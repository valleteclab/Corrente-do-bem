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
async function postMultipart(caminho, campos, fotos, cookie) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const f of fotos) fd.append('fotos', new Blob([f.dados], { type: f.tipo }), f.nome);
  return fetch(base + caminho, { method: 'POST', headers: cookie ? { cookie } : {}, body: fd, redirect: 'manual' });
}
async function cadastrar(dados) {
  const r = await post('/cadastrar', { tipo: 'pessoa', cidade: 'Osasco', estado: 'sp', consentimento: '1', senha: 'senha12345', ...dados });
  assert.equal(r.status, 302, 'cadastro deve redirecionar');
  return { cookie: cookieDe(r), destino: r.headers.get('location') };
}
async function entrar(email) {
  return cookieDe(await post('/entrar', { email, senha: 'senha12345' }));
}
async function loginAdmin() {
  return cookieDe(await post('/admin/login', { senha: SENHA_ADMIN }));
}

test('páginas públicas carregam', async () => {
  for (const c of ['/', '/sobre', '/termos', '/entrar', '/cadastrar', '/diretorio', '/vagas', '/ranking', '/corrente', '/corrente/como-funciona', '/corrente/pedidos']) {
    const r = await get(c);
    assert.equal(r.status, 200, c);
  }
  const html = await (await get('/')).text();
  assert.match(html, /Elo Brasil/);
  assert.match(html, /Patriota/);
});

test('cadastro valida campos e consentimento', async () => {
  const r = await post('/cadastrar', { tipo: 'pessoa', nome: 'X', email: 'invalido', senha: '123', cidade: '' });
  assert.equal(r.status, 422);
  const html = await r.text();
  assert.match(html, /e-mail válido/);
  assert.match(html, /8 caracteres/);
  assert.match(html, /termos/);
});

test('selo por análise: redes sociais → moderação aprova → pontos e convites', async () => {
  const { cookie: ana, destino } = await cadastrar({ nome: 'Ana Souza', email: 'ana@teste.com' });
  assert.equal(destino, '/verificacao', 'sem convite vai pedir o selo');
  let r = await post('/post', { texto: 'olá' }, ana);
  assert.equal(r.headers.get('location'), '/verificacao', 'sem selo não posta');

  // Sem rede nem foto => erro.
  r = await postMultipart('/verificacao', { instagram: '' }, [], ana);
  assert.equal(r.status, 422);
  assert.match(await r.text(), /pelo menos uma rede social ou envie uma foto/);

  // Só com Instagram já entra na fila.
  r = await postMultipart('/verificacao', { instagram: '@ana.souza', facebook: 'ana.souza.oficial' }, [], ana);
  assert.equal(r.status, 302);
  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  assert.equal(anaDb.status_verificacao, 'em_analise');
  assert.equal(anaDb.instagram, 'ana.souza');
  const verif = db.verificacoes.ultimaDoUsuario(anaDb.id);
  assert.match(verif.outras_redes, /facebook: ana\.souza\.oficial/);
  assert.deepEqual(verif.fotos, []);

  r = await get(`/u/${anaDb.id}`);
  assert.equal(r.status, 404, 'perfil sem selo não é público');

  const admin = await loginAdmin();
  const fila = await (await get('/admin/verificacoes', admin)).text();
  assert.match(fila, /Ana Souza/);
  assert.match(fila, /instagram\.com\/ana\.souza/);

  r = await post(`/admin/verificacoes/${verif.id}/decidir`, { decisao: 'aprovar' }, admin);
  assert.equal(r.status, 302);
  const anaOk = db.usuarios.buscar(anaDb.id);
  assert.equal(anaOk.status_verificacao, 'verificado');
  assert.equal(anaOk.convites_restantes, 5);
  assert.equal(db.pontos.total(anaDb.id), 50, 'ganhou os pontos do selo');

  r = await post('/post', { texto: 'Primeira publicação!' }, ana);
  assert.equal(r.headers.get('location'), '/feed');
  assert.equal(db.pontos.total(anaDb.id), 55);
  assert.equal((await get(`/u/${anaDb.id}`)).status, 200);
});

test('selo por convite: convidado entra verificado na hora e quem convidou pontua', async () => {
  const ana = await entrar('ana@teste.com');
  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  const pontosAntes = db.pontos.total(anaDb.id);
  let r = await post('/convites', {}, ana);
  assert.equal(r.status, 302);
  const [convite] = db.convites.doUsuario(anaDb.id);
  assert.ok(convite.codigo);

  const htmlConvite = await (await get(`/cadastrar?convite=${convite.codigo}`)).text();
  assert.match(htmlConvite, /convidado\(a\) por <strong>Ana Souza/);
  assert.match(htmlConvite, /já recebe o selo/);

  const { cookie: bruno, destino } = await cadastrar({ nome: 'Bruno Lima', email: 'bruno@teste.com', convite: convite.codigo });
  assert.equal(destino, '/perfil', 'convidado não passa pela verificação');
  const brunoDb = db.usuarios.buscarPorEmail('bruno@teste.com');
  assert.equal(brunoDb.status_verificacao, 'verificado');
  assert.equal(brunoDb.convidado_por, anaDb.id);
  assert.equal(brunoDb.convites_restantes, 5, 'convidado também pode convidar');
  assert.equal(db.pontos.total(brunoDb.id), 50);
  assert.equal(db.pontos.total(anaDb.id), pontosAntes + 30, 'quem convidou ganhou 30');

  r = await post('/post', { texto: 'Cheguei!' }, bruno);
  assert.equal(r.headers.get('location'), '/feed');

  // Convite não pode ser reutilizado.
  r = await post('/cadastrar', { tipo: 'pessoa', nome: 'Carla', email: 'carla@teste.com', senha: 'senha12345', cidade: 'SP', consentimento: '1', convite: convite.codigo });
  assert.equal(r.status, 422);
});

test('selo por fotos: até 3 fotos privadas, apagadas após a decisão', async () => {
  const { cookie: carla } = await cadastrar({ nome: 'Carla Dias', email: 'carla@teste.com' });
  let r = await postMultipart('/verificacao', { instagram: '', observacao: 'Tenho uma loja no centro.' }, [
    { nome: 'a.png', dados: PNG, tipo: 'image/png' },
    { nome: 'b.png', dados: PNG, tipo: 'image/png' },
  ], carla);
  assert.equal(r.status, 302);
  const carlaDb = db.usuarios.buscarPorEmail('carla@teste.com');
  const v = db.verificacoes.ultimaDoUsuario(carlaDb.id);
  assert.equal(v.fotos.length, 2);
  assert.ok(fs.existsSync(path.join(dirTemp, 'uploads', 'verificacao', v.fotos[0])));

  const admin = await loginAdmin();
  assert.equal((await get(`/admin/verificacoes/${v.id}/foto/0`, admin)).status, 200);
  assert.equal((await get(`/admin/verificacoes/${v.id}/foto/1`, admin)).status, 200);
  assert.equal((await get(`/admin/verificacoes/${v.id}/foto/0`)).status, 302, 'sem login não abre');

  r = await post(`/admin/verificacoes/${v.id}/decidir`, { decisao: 'rejeitar', motivo: 'Fotos não mostram nada' }, admin);
  assert.equal(db.usuarios.buscar(carlaDb.id).status_verificacao, 'rejeitado');
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(path.join(dirTemp, 'uploads', 'verificacao', v.fotos[0])), 'foto apagada');
  assert.deepEqual(db.verificacoes.buscar(v.id).fotos, []);
  const pagina = await (await get('/verificacao', carla)).text();
  assert.match(pagina, /Fotos não mostram nada/);

  // Mais de 3 fotos é recusado.
  const quatro = Array.from({ length: 4 }, (_, i) => ({ nome: `f${i}.png`, dados: PNG, tipo: 'image/png' }));
  r = await postMultipart('/verificacao', { instagram: 'carla' }, quatro, carla);
  assert.equal(r.status, 422);
  assert.match(await r.text(), /arquivos demais/);
});

test('comércio gamificado: cliente registra negócio, empresa confirma, os dois pontuam e sobem no ranking', async () => {
  const { cookie: empresa } = await cadastrar({ tipo: 'empresa', nome: 'Padaria Verde', email: 'padaria@teste.com', categoria: 'Alimentação e restaurantes', whatsapp: '11999990000' });
  const empresaDb = db.usuarios.buscarPorEmail('padaria@teste.com');
  const admin = await loginAdmin();
  await post(`/admin/usuarios/${empresaDb.id}/status`, { status: 'verificado' }, admin);
  assert.equal(db.pontos.total(empresaDb.id), 50);

  const ana = await entrar('ana@teste.com');
  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  const antesAna = db.pontos.total(anaDb.id);

  // Página da empresa mostra o botão de registrar negócio para membro com selo.
  let html = await (await get(`/u/${empresaDb.id}`, ana)).text();
  assert.match(html, /Fechou negócio aqui/);

  let r = await post(`/u/${empresaDb.id}/negocio`, { descricao: '10 pães e um bolo' }, ana);
  assert.equal(r.status, 302);
  assert.equal(db.negocios.daEmpresa(empresaDb.id, 'pendente').length, 1);
  // Não pode duplicar enquanto está pendente.
  r = await post(`/u/${empresaDb.id}/negocio`, { descricao: 'de novo' }, ana);
  assert.equal(db.negocios.daEmpresa(empresaDb.id).length, 1);
  // Ninguém pontua antes da confirmação.
  assert.equal(db.pontos.total(anaDb.id), antesAna);

  // Empresa vê pendência no feed e confirma.
  html = await (await get('/feed', empresa)).text();
  assert.match(html, /negócio\(s\) para confirmar/);
  const [neg] = db.negocios.daEmpresa(empresaDb.id, 'pendente');
  r = await post(`/negocios/${neg.id}/decidir`, { decisao: 'confirmar' }, empresa);
  assert.equal(r.status, 302);
  assert.equal(db.negocios.buscar(neg.id).status, 'confirmado');
  assert.equal(db.pontos.total(anaDb.id), antesAna + 25);
  assert.equal(db.pontos.total(empresaDb.id), 75);
  // Outra pessoa não consegue confirmar o negócio da empresa.
  const bruno = await entrar('bruno@teste.com');
  r = await post(`/negocios/${neg.id}/decidir`, { decisao: 'confirmar' }, bruno);
  assert.notEqual(r.status, 200);

  // Conquista "Primeiro Elo" e ranking.
  html = await (await get(`/u/${anaDb.id}`)).text();
  assert.match(html, /Primeiro Elo/);
  html = await (await get('/ranking')).text();
  assert.match(html, /Padaria Verde/);
  assert.match(html, /Ana Souza/);
  html = await (await get('/negocios', ana)).text();
  assert.match(html, /Comprou de um membro/);

  // Avaliação pontua os dois.
  r = await post(`/u/${empresaDb.id}/avaliar`, { nota: '5', texto: 'Pão ótimo' }, ana);
  assert.equal(db.pontos.total(anaDb.id), antesAna + 35);
  assert.equal(db.pontos.total(empresaDb.id), 85);
  // Avaliar de novo não pontua de novo.
  await post(`/u/${empresaDb.id}/avaliar`, { nota: '4', texto: 'ok' }, ana);
  assert.equal(db.pontos.total(anaDb.id), antesAna + 35);

  // Perfil completo (foto + bio) dá +20 uma vez.
  await post('/perfil', { nome: 'Ana Souza', cidade: 'Osasco', estado: 'SP', bio: 'Mãe, empreendedora.', instagram: 'ana.souza', whatsapp: '', site: '' }, ana);
  assert.equal(db.pontos.total(anaDb.id), antesAna + 35, 'sem foto ainda não completa');
  const fd = new FormData();
  fd.append('foto', new Blob([PNG], { type: 'image/png' }), 'eu.png');
  r = await fetch(base + '/perfil/foto', { method: 'POST', headers: { cookie: ana }, body: fd, redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(db.pontos.total(anaDb.id), antesAna + 55);
});

test('limite diário de pontos por post', async () => {
  const bruno = await entrar('bruno@teste.com');
  const brunoDb = db.usuarios.buscarPorEmail('bruno@teste.com');
  const antes = db.pontos.total(brunoDb.id);
  for (let i = 0; i < 5; i += 1) await post('/post', { texto: `post ${i}` }, bruno);
  // Já tinha 1 post hoje ("Cheguei!"), então só mais 2 pontuam.
  assert.equal(db.pontos.total(brunoDb.id), antes + 10);
});

test('empresa publica vaga, membro com selo se candidata, empresa vê contato', async () => {
  const empresa = await entrar('padaria@teste.com');
  let r = await post('/vagas/nova', { titulo: 'Atendente', descricao: 'Meio período, manhã.', cidade: 'Osasco', tipo: 'CLT' }, empresa);
  assert.equal(r.status, 302);
  const [vaga] = db.vagas.listar();
  assert.equal(vaga.titulo, 'Atendente');

  const ana = await entrar('ana@teste.com');
  r = await post(`/vagas/${vaga.id}/candidatar`, { mensagem: 'Tenho experiência.' }, ana);
  assert.equal(r.status, 302);
  assert.equal(db.vagas.candidaturas(vaga.id).length, 1);

  const paginaEmpresa = await (await get(`/vagas/${vaga.id}`, empresa)).text();
  assert.match(paginaEmpresa, /Tenho experiência/);
  assert.match(paginaEmpresa, /ana@teste\.com/);
  const paginaAna = await (await get(`/vagas/${vaga.id}`, ana)).text();
  assert.doesNotMatch(paginaAna, /ana@teste\.com/);
  assert.match(paginaAna, /já se candidatou/);

  const perfilAnon = await (await get(`/u/${db.usuarios.buscarPorEmail('padaria@teste.com').id}`)).text();
  assert.doesNotMatch(perfilAnon, /wa\.me/, 'WhatsApp só para membros com selo');
});

test('denúncia vai para a moderação; suspensão derruba a sessão', async () => {
  const ana = await entrar('ana@teste.com');
  const bruno = await entrar('bruno@teste.com');
  const [post1] = db.posts.listar();
  let r = await post(`/post/${post1.id}/denunciar`, { motivo: 'spam' }, bruno);
  assert.equal(r.status, 302);
  const admin = await loginAdmin();
  const html = await (await get('/admin/denuncias', admin)).text();
  assert.match(html, /spam/);
  const [den] = db.denuncias.listar();
  const antes = db.posts.listar().length;
  r = await post(`/admin/denuncias/${den.id}/resolver`, { remover_post: '1', post_id: post1.id }, admin);
  assert.equal(db.posts.listar().length, antes - 1, 'post removido some do feed');

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
  const bruno = await entrar('bruno@teste.com');
  let r = await get('/admin', bruno);
  assert.equal(r.status, 302);
  db.usuarios.mudarPapel(brunoDb.id, 'moderador');
  r = await get('/admin', bruno);
  assert.equal(r.status, 200);
});

test('nome do selo é configurável', async () => {
  const admin = await loginAdmin();
  await post('/admin/config', { nome_rede: 'Elo Brasil', slogan: 's', descricao_rede: 'd', nome_selo: 'Verificado', cadastro_aberto: '1', nome_campanha: 'Corrente do Bem', nome_beneficiaria: 'Tia', historia: '', link_video: '', whatsapp_contato: '', cidade: '' }, admin);
  const html = await (await get('/')).text();
  assert.match(html, /selo Verificado/);
  db.config.salvar({ nome_selo: 'Patriota' });
});

test('verificador só acessa a fila do selo e fica registrado como quem decidiu', async () => {
  const brunoDb = db.usuarios.buscarPorEmail('bruno@teste.com');
  db.usuarios.mudarPapel(brunoDb.id, 'verificador');
  const bruno = await entrar('bruno@teste.com');
  let r = await get('/admin', bruno);
  assert.equal(r.headers.get('location'), '/admin/verificacoes');
  assert.equal((await get('/admin/verificacoes', bruno)).status, 200);
  r = await get('/admin/usuarios', bruno);
  assert.equal(r.status, 302, 'verificador não entra em Membros');
  r = await get('/admin/config', bruno);
  assert.equal(r.status, 302, 'verificador não entra em Config');

  // Alguém pede o selo; o verificador aprova.
  const { cookie: eli } = await cadastrar({ nome: 'Eli Santos', email: 'eli@teste.com' });
  await postMultipart('/verificacao', { instagram: '@eli.santos' }, [], eli);
  const eliDb = db.usuarios.buscarPorEmail('eli@teste.com');
  const v = db.verificacoes.ultimaDoUsuario(eliDb.id);
  r = await post(`/admin/verificacoes/${v.id}/decidir`, { decisao: 'aprovar' }, bruno);
  assert.equal(r.status, 302);
  assert.equal(db.usuarios.buscar(eliDb.id).status_verificacao, 'verificado');
  assert.equal(db.verificacoes.buscar(v.id).decidido_por, brunoDb.id);
  const aprovados = await (await get('/admin/verificacoes?status=verificado', bruno)).text();
  assert.match(aprovados, /Decidido por Bruno Lima/);

  // No painel de Membros, o admin vê quantos selos ele decidiu.
  const admin = await loginAdmin();
  const membros = await (await get('/admin/usuarios?q=Bruno', admin)).text();
  assert.match(membros, /verificador · 1 selo\(s\) decididos/);
  db.usuarios.mudarPapel(brunoDb.id, 'moderador');
});

test('Corrente do Bem: membro cria campanha, recebe oferta, marca recebido e a oferta vai para repasse', async () => {
  const ana = await entrar('ana@teste.com');
  const anaDb = db.usuarios.buscarPorEmail('ana@teste.com');
  // Sem selo não cria campanha.
  const { cookie: semSelo } = await cadastrar({ nome: 'Sem Selo', email: 'semselo@teste.com' });
  let r = await get('/corrente/campanhas/nova', semSelo);
  assert.equal(r.headers.get('location'), '/verificacao');

  r = await post('/corrente/campanhas/nova', { titulo: 'Ajuda para a Dona Lúcia', beneficiario: 'Dona Lúcia', historia: 'Perdeu tudo na enchente e precisa recomeçar com os três netos.', cidade: 'Osasco', whatsapp: '11999990001' }, ana);
  assert.equal(r.status, 302);
  const [camp] = db.campanhas.listar({ dono_id: anaDb.id });
  assert.equal(camp.titulo, 'Ajuda para a Dona Lúcia');
  assert.equal(r.headers.get('location'), `/corrente/campanha/${camp.id}/gerenciar`);
  const pontos = db.pontos.total(anaDb.id);

  // Dona adiciona itens; outro membro não consegue gerenciar.
  r = await post(`/corrente/campanha/${camp.id}/necessidades`, { titulo: 'Geladeira', categoria: 'Móveis e eletrodomésticos' }, ana);
  r = await post(`/corrente/campanha/${camp.id}/necessidades`, { titulo: 'Cesta básica', categoria: 'Alimentação' }, ana);
  const [geladeira, cesta] = db.necessidades.listar({ campanha_id: camp.id }).sort((a, b) => a.id - b.id);
  const bruno = await entrar('bruno@teste.com');
  db.usuarios.mudarPapel(db.usuarios.buscarPorEmail('bruno@teste.com').id, 'membro');
  r = await get(`/corrente/campanha/${camp.id}/gerenciar`, bruno);
  assert.equal(r.status, 302, 'outro membro não gerencia');
  r = await post(`/corrente/campanha/${camp.id}/necessidades/${geladeira.id}/recebida`, {}, bruno);
  assert.equal(db.necessidades.buscar(geladeira.id).status, 'aberta');

  // Página pública mostra a campanha; hub lista.
  let html = await (await get(`/corrente/campanha/${camp.id}`)).text();
  assert.match(html, /Dona Lúcia/);
  assert.match(html, /Geladeira/);
  html = await (await get('/corrente')).text();
  assert.match(html, /Ajuda para a Dona Lúcia/);

  // Bruno (logado) doa a geladeira: oferta fica ligada à conta dele.
  r = await post('/corrente/ajudar', { nome: 'Bruno', contato: '11988880000', item: 'Geladeira duplex', categoria: 'Móveis e eletrodomésticos', necessidade_id: geladeira.id, autoriza_repasse: '1' }, bruno);
  assert.equal(r.status, 302);
  const [oferta] = db.ofertas.listar({ campanha_id: camp.id });
  assert.equal(oferta.usuario_id, db.usuarios.buscarPorEmail('bruno@teste.com').id);
  assert.equal(oferta.status, 'nova');

  // Dona vê a oferta com contato, aceita e marca entregue: Bruno ganha 20 pontos.
  html = await (await get(`/corrente/campanha/${camp.id}/gerenciar`, ana)).text();
  assert.match(html, /Geladeira duplex/);
  assert.match(html, /11988880000/);
  const brunoId = oferta.usuario_id;
  const antesBruno = db.pontos.total(brunoId);
  await post(`/corrente/campanha/${camp.id}/ofertas/${oferta.id}/status`, { status: 'aceita' }, ana);
  await post(`/corrente/campanha/${camp.id}/ofertas/${oferta.id}/status`, { status: 'concluida' }, ana);
  assert.equal(db.ofertas.buscar(oferta.id).status, 'concluida');
  assert.equal(db.pontos.total(brunoId), antesBruno + 20);

  // Segunda oferta para a cesta; dona marca cesta como recebida: oferta vira disponível para repasse.
  await post('/corrente/ajudar', { nome: 'Carla', contato: 'carla@x.com', item: 'Cesta básica', categoria: 'Alimentação', necessidade_id: cesta.id, autoriza_repasse: '1' });
  await post(`/corrente/campanha/${camp.id}/necessidades/${cesta.id}/recebida`, {}, ana);
  const cestaOferta = db.ofertas.listar({ campanha_id: camp.id }).find((o) => o.item === 'Cesta básica');
  assert.equal(cestaOferta.status, 'disponivel');
  // Quem tenta doar o item recebido é avisado.
  html = await (await get(`/corrente/ajudar?necessidade=${cesta.id}`)).text();
  assert.match(html, /Dona Lúcia já recebeu "Cesta básica"/);

  // Minha corrente e encerramento.
  html = await (await get('/corrente/minha', ana)).text();
  assert.match(html, /Ajuda para a Dona Lúcia/);
  await post(`/corrente/campanha/${camp.id}/status`, { status: 'encerrada' }, ana);
  assert.equal(db.campanhas.buscar(camp.id).status, 'encerrada');
  assert.equal(db.pontos.total(anaDb.id), pontos, 'criar campanha pontuou uma vez (10) e nada mais');
  db.usuarios.mudarPapel(db.usuarios.buscarPorEmail('bruno@teste.com').id, 'moderador');
});
