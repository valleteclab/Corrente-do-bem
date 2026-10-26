'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarApp } = require('../src/server');
const { abrirBanco } = require('../src/db');
const { criarIa } = require('../src/ia');
const { criarUploads } = require('../src/upload');

const SENHA_ADMIN = 'segredo-teste';
let servidor;
let base;
let db;
let dirTemp;

// PNG 1x1 válido, para os uploads.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'rede-test-'));
  db = abrirBanco(':memory:');
  const ia = { ...criarIa({ client: null }), ativo: false };
  const app = criarApp({ db, ia, uploads: criarUploads(dirTemp), adminSenha: SENHA_ADMIN, segredo: 'segredo-cookie' });
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => { servidor.close(); fs.rmSync(dirTemp, { recursive: true, force: true }); });

function form(d) { return new URLSearchParams(d).toString(); }
function cookieDe(r) {
  const h = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return h.filter(Boolean).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}
async function post(caminho, dados, cookie) {
  return fetch(base + caminho, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form(dados), redirect: 'manual' });
}
async function get(caminho, cookie) {
  return fetch(base + caminho, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}
async function postMultipart(caminho, campos, arquivos, cookie) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const [k, { nome, dados, tipo }] of Object.entries(arquivos)) fd.append(k, new Blob([dados], { type: tipo }), nome);
  return fetch(base + caminho, { method: 'POST', headers: cookie ? { cookie } : {}, body: fd, redirect: 'manual' });
}
async function cadastrar(dados) {
  const r = await post('/cadastrar', { tipo: 'pessoa', cidade: 'Osasco', estado: 'sp', consentimento: '1', senha: 'senha12345', ...dados });
  assert.equal(r.status, 302, 'cadastro deve redirecionar');
  return cookieDe(r);
}
async function loginAdmin() {
  const r = await post('/admin/login', { senha: SENHA_ADMIN });
  return cookieDe(r);
}

test('página inicial da rede e páginas públicas carregam', async () => {
  for (const c of ['/', '/sobre', '/termos', '/entrar', '/cadastrar', '/diretorio', '/vagas', '/corrente', '/corrente/como-funciona', '/corrente/pedidos']) {
    const r = await get(c);
    assert.equal(r.status, 200, c);
  }
  const html = await (await get('/')).text();
  assert.match(html, /Elo Brasil/);
});

test('cadastro valida campos e consentimento', async () => {
  const r = await post('/cadastrar', { tipo: 'pessoa', nome: 'X', email: 'invalido', senha: '123', cidade: '' });
  assert.equal(r.status, 422);
  const html = await r.text();
  assert.match(html, /e-mail válido/);
  assert.match(html, /8 caracteres/);
  assert.match(html, /termos/);
});

test('fluxo: cadastro → verificação com fotos → moderação aprova → convite → convidado', async () => {
  // 1. Ana se cadastra sem convite.
  const ana = await cadastrar({ nome: 'Ana Souza', email: 'ana@teste.com' });
  let r = await get('/feed', ana);
  assert.equal(r.status, 200);
  // Não verificada: não pode postar.
  r = await post('/post', { texto: 'olá' }, ana);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/verificacao');

  // Não pode convidar ainda.
  r = await post('/convites', {}, ana);
  assert.equal(r.headers.get('location'), '/verificacao');

  // 2. Envia verificação (sem Instagram e sem convite => erro).
  r = await postMultipart('/verificacao', { instagram: '' }, {
    selfie: { nome: 'selfie.png', dados: PNG, tipo: 'image/png' },
    documento: { nome: 'doc.png', dados: PNG, tipo: 'image/png' },
  }, ana);
  assert.equal(r.status, 422);
  assert.match(await r.text(), /Instagram/);

  // Com Instagram, entra na fila.
  r = await postMultipart('/verificacao', { instagram: '@ana.souza' }, {
    selfie: { nome: 'selfie.png', dados: PNG, tipo: 'image/png' },
    documento: { nome: 'doc.png', dados: PNG, tipo: 'image/png' },
  }, ana);
  assert.equal(r.status, 302);
  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  assert.equal(anaDb.status_verificacao, 'em_analise');
  assert.equal(anaDb.instagram, 'ana.souza');
  const verif = db.verificacoes.ultimaDoUsuario(anaDb.id);
  assert.ok(verif.selfie && verif.documento, 'arquivos registrados');
  assert.ok(fs.existsSync(path.join(dirTemp, 'uploads', 'verificacao', verif.selfie)), 'selfie salva em área privada');

  // Perfil não verificado não aparece publicamente.
  r = await get(`/u/${anaDb.id}`);
  assert.equal(r.status, 404);

  // 3. Moderação vê a fila, a imagem privada, e aprova.
  const admin = await loginAdmin();
  r = await get('/admin/verificacoes', admin);
  assert.match(await r.text(), /Ana Souza/);
  r = await get(`/admin/verificacoes/${verif.id}/imagem/selfie`, admin);
  assert.equal(r.status, 200);
  r = await get(`/admin/verificacoes/${verif.id}/imagem/selfie`);
  assert.equal(r.status, 302, 'sem login, imagem privada não abre');

  r = await post(`/admin/verificacoes/${verif.id}/decidir`, { decisao: 'aprovar' }, admin);
  assert.equal(r.status, 302);
  const anaOk = db.usuarios.buscar(anaDb.id);
  assert.equal(anaOk.status_verificacao, 'verificado');
  assert.equal(anaOk.convites_restantes, 5);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(path.join(dirTemp, 'uploads', 'verificacao', verif.selfie)), 'selfie apagada após a decisão');
  assert.equal(db.verificacoes.buscar(verif.id).selfie, '', 'caminho apagado do banco');

  // Agora pode postar e o perfil é público.
  r = await post('/post', { texto: 'Primeira publicação!' }, ana);
  assert.equal(r.headers.get('location'), '/feed');
  r = await get(`/u/${anaDb.id}`);
  assert.equal(r.status, 200);
  const feed = await (await get('/feed', ana)).text();
  assert.match(feed, /Primeira publicação!/);

  // 4. Gera convite.
  r = await post('/convites', {}, ana);
  assert.equal(r.status, 302);
  const [convite] = db.convites.doUsuario(anaDb.id);
  assert.ok(convite.codigo);
  assert.equal(db.usuarios.buscar(anaDb.id).convites_restantes, 4);

  // 5. Bruno entra pelo convite: fica ligado à Ana e a página mostra isso.
  const htmlConvite = await (await get(`/cadastrar?convite=${convite.codigo}`)).text();
  assert.match(htmlConvite, /convidado\(a\) por <strong>Ana Souza/);
  const bruno = await cadastrar({ nome: 'Bruno Lima', email: 'bruno@teste.com', convite: convite.codigo });
  const brunoDb = db.usuarios.buscarPorEmail('bruno@teste.com');
  assert.equal(brunoDb.convidado_por, anaDb.id);
  assert.equal(db.convites.doUsuario(anaDb.id)[0].usado_por, brunoDb.id);

  // Convite não pode ser reutilizado.
  r = await post('/cadastrar', { tipo: 'pessoa', nome: 'Carla', email: 'carla@teste.com', senha: 'senha12345', cidade: 'SP', consentimento: '1', convite: convite.codigo });
  assert.equal(r.status, 422);

  // Convidado pode enviar verificação sem Instagram.
  r = await postMultipart('/verificacao', { instagram: '' }, {
    selfie: { nome: 's.png', dados: PNG, tipo: 'image/png' },
    documento: { nome: 'd.png', dados: PNG, tipo: 'image/png' },
  }, bruno);
  assert.equal(r.status, 302);
  assert.equal(db.usuarios.buscar(brunoDb.id).status_verificacao, 'em_analise');

  // Moderação recusa com motivo; Bruno vê o motivo.
  const vb = db.verificacoes.ultimaDoUsuario(brunoDb.id);
  await post(`/admin/verificacoes/${vb.id}/decidir`, { decisao: 'rejeitar', motivo: 'Documento ilegível' }, admin);
  assert.equal(db.usuarios.buscar(brunoDb.id).status_verificacao, 'rejeitado');
  const pagina = await (await get('/verificacao', bruno)).text();
  assert.match(pagina, /Documento ilegível/);
});

test('empresa publica vaga, membro verificado se candidata, empresa vê contato', async () => {
  const empresa = await cadastrar({ tipo: 'empresa', nome: 'Padaria Verde', email: 'padaria@teste.com', categoria: 'Alimentação e restaurantes', whatsapp: '11999990000' });
  const empresaDb = db.usuarios.buscarPorEmail('padaria@teste.com');
  // Não verificada: não pode publicar vaga.
  let r = await get('/vagas/nova', empresa);
  assert.equal(r.status, 302);
  db.usuarios.mudarStatusVerificacao(empresaDb.id, 'verificado');

  r = await post('/vagas/nova', { titulo: 'Atendente', descricao: 'Meio período, manhã.', cidade: 'Osasco', tipo: 'CLT' }, empresa);
  assert.equal(r.status, 302);
  const [vaga] = db.vagas.listar();
  assert.equal(vaga.titulo, 'Atendente');
  assert.match(await (await get('/vagas')).text(), /Atendente/);

  // Pessoa verificada (Ana, do teste anterior) se candidata.
  const ana = cookieDe(await post('/entrar', { email: 'ana@teste.com', senha: 'senha12345' }));
  r = await post(`/vagas/${vaga.id}/candidatar`, { mensagem: 'Tenho experiência.' }, ana);
  assert.equal(r.status, 302);
  assert.equal(db.vagas.candidaturas(vaga.id).length, 1);

  // Empresa vê a candidatura com contato; outra pessoa não vê.
  const paginaEmpresa = await (await get(`/vagas/${vaga.id}`, empresa)).text();
  assert.match(paginaEmpresa, /Tenho experiência/);
  assert.match(paginaEmpresa, /ana@teste\.com/);
  const paginaAna = await (await get(`/vagas/${vaga.id}`, ana)).text();
  assert.doesNotMatch(paginaAna, /ana@teste\.com/);
  assert.match(paginaAna, /já se candidatou/);

  // Ana avalia a empresa; diretório mostra a nota.
  r = await post(`/u/${empresaDb.id}/avaliar`, { nota: '5', texto: 'Pão ótimo' }, ana);
  assert.equal(r.status, 302);
  const dir = await (await get('/diretorio?tipo=empresa')).text();
  assert.match(dir, /Padaria Verde/);
  assert.match(dir, /★ 5/);
  // WhatsApp da empresa só aparece para membro verificado.
  const perfilAnon = await (await get(`/u/${empresaDb.id}`)).text();
  assert.doesNotMatch(perfilAnon, /wa\.me/);
  const perfilAna = await (await get(`/u/${empresaDb.id}`, ana)).text();
  assert.match(perfilAna, /wa\.me\/5511999990000/);
});

test('denúncia vai para a moderação; suspensão derruba a sessão', async () => {
  const ana = cookieDe(await post('/entrar', { email: 'ana@teste.com', senha: 'senha12345' }));
  const bruno = cookieDe(await post('/entrar', { email: 'bruno@teste.com', senha: 'senha12345' }));
  const [post1] = db.posts.listar();
  let r = await post(`/post/${post1.id}/denunciar`, { motivo: 'spam' }, bruno);
  assert.equal(r.status, 302);
  const admin = await loginAdmin();
  const html = await (await get('/admin/denuncias', admin)).text();
  assert.match(html, /spam/);
  const [den] = db.denuncias.listar();
  r = await post(`/admin/denuncias/${den.id}/resolver`, { remover_post: '1', post_id: post1.id }, admin);
  assert.equal(db.posts.listar().length, 0, 'post removido some do feed');

  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  await post(`/admin/usuarios/${anaDb.id}/banir`, { banido: '1' }, admin);
  r = await get('/feed', ana);
  assert.equal(r.status, 302, 'banida perde a sessão');
  r = await post('/entrar', { email: 'ana@teste.com', senha: 'senha12345' });
  assert.equal(r.status, 403);
  await post(`/admin/usuarios/${anaDb.id}/banir`, { banido: '0' }, admin);
});

test('cadastro fechado aceita só convite', async () => {
  db.config.salvar({ cadastro_aberto: '0' });
  const r = await post('/cadastrar', { tipo: 'pessoa', nome: 'Dani', email: 'dani@teste.com', senha: 'senha12345', cidade: 'SP', consentimento: '1' });
  assert.equal(r.status, 422);
  assert.match(await r.text(), /só por convite/);
  db.config.salvar({ cadastro_aberto: '1' });
});

test('membro com papel moderador acessa o painel sem a senha de admin', async () => {
  const brunoDb = db.usuarios.buscarPorEmail('bruno@teste.com');
  const bruno = cookieDe(await post('/entrar', { email: 'bruno@teste.com', senha: 'senha12345' }));
  let r = await get('/admin', bruno);
  assert.equal(r.status, 302);
  db.usuarios.mudarPapel(brunoDb.id, 'moderador');
  r = await get('/admin', bruno);
  assert.equal(r.status, 200);
});
