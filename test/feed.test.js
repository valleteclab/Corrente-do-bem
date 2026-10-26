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

let servidor;
let base;
let db;
let dirTemp;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const VIDEO = Buffer.from('AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVl', 'base64'); // cabeçalho mp4 mínimo
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

before(async () => {
  dirTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-test-'));
  db = abrirBanco(':memory:');
  const ia = { ...criarIa({ client: null }), ativo: false };
  const app = criarApp({ db, ia, uploads: criarUploads(dirTemp), adminSenha: 'x', segredo: 'y' });
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});
after(() => { servidor.close(); fs.rmSync(dirTemp, { recursive: true, force: true }); });

function form(d) { return new URLSearchParams(d).toString(); }
function cookieDe(r) {
  const h = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')];
  return h.filter(Boolean).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}
// Só o cookie de sessão (sem o flash, que é consumido na próxima página).
function sessao(r) { return cookieDe(r).split('; ').filter((c) => c.startsWith('membro=')).join('; '); }
const post = (c, d, cookie) => fetch(base + c, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) }, body: form(d), redirect: 'manual' });
const get = (c, cookie) => fetch(base + c, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
async function multipart(c, campos, arquivos, cookie) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(campos)) fd.append(k, v);
  for (const a of arquivos) fd.append(a.campo, new Blob([a.dados], { type: a.tipo }), a.nome);
  return fetch(base + c, { method: 'POST', headers: cookie ? { cookie } : {}, body: fd, redirect: 'manual' });
}
async function membro(nome, email, extra = {}) {
  const r = await post('/cadastrar', { tipo: 'pessoa', nome, email, senha: 'senha12345', cidade: 'Osasco', estado: 'SP', consentimento: '1', ...extra });
  const u = db.usuarios.buscarPorEmail(email);
  db.usuarios.mudarStatusVerificacao(u.id, 'verificado');
  return { cookie: sessao(r), id: u.id };
}

test('post com fotos, curtida e comentário', async () => {
  const ana = await membro('Ana', 'ana@f.com');
  const bruno = await membro('Bruno', 'bruno@f.com');

  // Post só com texto continua funcionando.
  let r = await post('/post', { texto: 'Olá!' }, ana.cookie);
  assert.equal(r.status, 302);

  // Post com 2 fotos.
  r = await multipart('/post', { texto: 'Inauguração da loja' }, [
    { campo: 'midias', nome: 'a.png', dados: PNG, tipo: 'image/png' },
    { campo: 'midias', nome: 'b.png', dados: PNG, tipo: 'image/png' },
  ], ana.cookie);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/feed');
  const [p] = db.posts.listar();
  assert.equal(p.midias.length, 2);
  assert.equal(p.midias[0].tipo, 'imagem');
  assert.ok(fs.existsSync(path.join(dirTemp, 'uploads', 'posts', p.midias[0].arquivo)));
  // Arquivo é servido publicamente.
  assert.equal((await get(`/uploads/posts/${p.midias[0].arquivo}`)).status, 200);

  // Post só com foto, sem texto, é aceito; sem nada, não.
  r = await multipart('/post', { texto: '' }, [{ campo: 'midias', nome: 'c.png', dados: PNG, tipo: 'image/png' }], ana.cookie);
  assert.equal(r.status, 302);
  const antes = db.posts.listar().length;
  r = await multipart('/post', { texto: '' }, [], ana.cookie);
  assert.equal(db.posts.listar().length, antes, 'post vazio não cria');

  // Curtir / descurtir.
  r = await post(`/post/${p.id}/curtir`, { voltar: '/feed' }, bruno.cookie);
  assert.equal(r.status, 302);
  assert.equal(db.posts.listar({ usuarioId: bruno.id }).find((x) => x.id === p.id).curtidas, 1);
  assert.equal(db.posts.listar({ usuarioId: bruno.id }).find((x) => x.id === p.id).curti, 1);
  await post(`/post/${p.id}/curtir`, { voltar: '/feed' }, bruno.cookie);
  assert.equal(db.posts.listar().find((x) => x.id === p.id).curtidas, 0);

  // Comentar pontua (+2) e aparece no feed e na página do post.
  const pontosAntes = db.pontos.total(bruno.id);
  r = await post(`/post/${p.id}/comentar`, { texto: 'Parabéns!', voltar: '/feed' }, bruno.cookie);
  assert.equal(r.status, 302);
  assert.equal(db.pontos.total(bruno.id), pontosAntes + 2);
  const feed = await (await get('/feed', ana.cookie)).text();
  assert.match(feed, /Parabéns!/);
  assert.match(feed, /Inauguração da loja/);
  const pagina = await (await get(`/p/${p.id}`)).text();
  assert.match(pagina, /Parabéns!/);

  // Dona do post pode remover o comentário de outro; autor do post remove o post e as fotos somem.
  const [c] = db.posts.buscarCompleto(p.id).comentarios;
  await post(`/comentario/${c.id}/remover`, {}, ana.cookie);
  assert.equal(db.posts.buscarCompleto(p.id).comentarios.length, 0);
  await post(`/post/${p.id}/remover`, {}, ana.cookie);
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(!fs.existsSync(path.join(dirTemp, 'uploads', 'posts', p.midias[0].arquivo)), 'foto apagada com o post');
  assert.equal((await get(`/p/${p.id}`)).status, 404);
});

test('reel: vídeo vai para a aba Reels; vídeo + foto é recusado', async () => {
  const ana = sessao(await post('/entrar', { email: 'ana@f.com', senha: 'senha12345' }));
  let r = await multipart('/post', { texto: 'Meu primeiro reel' }, [{ campo: 'midias', nome: 'v.mp4', dados: VIDEO, tipo: 'video/mp4' }], ana);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/reels');
  const reels = db.posts.listar({ apenasVideos: true });
  assert.equal(reels.length, 1);
  assert.equal(reels[0].midias[0].tipo, 'video');
  const html = await (await get('/reels', ana)).text();
  assert.match(html, /<video/);
  assert.match(html, /Meu primeiro reel/);

  const antes = db.posts.listar().length;
  r = await multipart('/post', { texto: 'mistura' }, [
    { campo: 'midias', nome: 'v.mp4', dados: VIDEO, tipo: 'video/mp4' },
    { campo: 'midias', nome: 'a.png', dados: PNG, tipo: 'image/png' },
  ], ana);
  assert.equal(db.posts.listar().length, antes, 'vídeo + foto não cria post');
  r = await multipart('/post', { texto: 'exe' }, [{ campo: 'midias', nome: 'x.exe', dados: PNG, tipo: 'application/octet-stream' }], ana);
  assert.equal(db.posts.listar().length, antes, 'tipo inválido não cria post');
});

test('currículo: pessoa aparece em Talentos; PDF só para membros com selo; qualquer membro com selo publica vaga', async () => {
  const carlos = await membro('Carlos Pereira', 'carlos@f.com');
  let r = await post('/curriculo', { procura_emprego: '1', profissao: '', curriculo: 'x' }, carlos.cookie);
  assert.equal(r.status, 422, 'procurando trabalho exige profissão');
  const pontosAntes = db.pontos.total(carlos.id);
  r = await post('/curriculo', { procura_emprego: '1', profissao: 'Eletricista', curriculo: '10 anos de experiência em instalações residenciais.' }, carlos.cookie);
  assert.equal(r.status, 302);
  assert.equal(db.pontos.total(carlos.id), pontosAntes + 15);
  r = await post('/curriculo', { procura_emprego: '1', profissao: 'Eletricista', curriculo: 'editado' }, carlos.cookie);
  assert.equal(db.pontos.total(carlos.id), pontosAntes + 15, 'pontua uma vez só');

  r = await multipart('/curriculo/arquivo', {}, [{ campo: 'curriculo_arquivo', nome: 'cv.pdf', dados: PDF, tipo: 'application/pdf' }], carlos.cookie);
  assert.equal(r.status, 302);
  assert.ok(db.usuarios.buscar(carlos.id).curriculo_arquivo);
  r = await multipart('/curriculo/arquivo', {}, [{ campo: 'curriculo_arquivo', nome: 'cv.png', dados: PNG, tipo: 'image/png' }], carlos.cookie);
  assert.equal(r.status, 302);
  const paginaCv = await (await get('/curriculo', carlos.cookie + '; ' + cookieDe(r))).text();
  assert.match(paginaCv, /precisa ser um PDF/);

  const talentos = await (await get('/talentos?q=eletric')).text();
  assert.match(talentos, /Carlos Pereira/);
  assert.match(talentos, /Eletricista/);
  assert.doesNotMatch(await (await get('/talentos?q=padeiro')).text(), /Carlos Pereira/);

  // PDF: anônimo não vê; membro com selo vê.
  assert.equal((await get(`/u/${carlos.id}/curriculo`)).status, 302);
  const ana = sessao(await post('/entrar', { email: 'ana@f.com', senha: 'senha12345' }));
  const pdf = await get(`/u/${carlos.id}/curriculo`, ana);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-type'), /pdf/);

  // Pessoa com selo publica vaga.
  r = await post('/vagas/nova', { titulo: 'Diarista', descricao: 'Uma vez por semana.', cidade: 'Osasco', tipo: 'Freelancer' }, ana);
  assert.equal(r.status, 302);
  assert.match(await (await get('/vagas')).text(), /Diarista/);
  // Sem selo, não.
  const semSelo = sessao(await post('/cadastrar', { tipo: 'pessoa', nome: 'Novo', email: 'novo@f.com', senha: 'senha12345', cidade: 'SP', consentimento: '1' }));
  r = await get('/vagas/nova', semSelo);
  assert.equal(r.headers.get('location'), '/verificacao');
});

test('links do Instagram e YouTube no post viram embeds e URLs viram links', async () => {
  const ana = sessao(await post('/entrar', { email: 'ana@f.com', senha: 'senha12345' }));
  await post('/post', { texto: 'Olha isso https://www.instagram.com/reel/C1a2B3c4D5e/?igsh=abc e https://youtu.be/dQw4w9WgXcQ. Site: https://exemplo.com.br/x' }, ana);
  const html = await (await get('/feed', ana)).text();
  assert.match(html, /instagram\.com\/p\/C1a2B3c4D5e\/embed/);
  assert.match(html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  assert.match(html, /<a href="https:\/\/exemplo\.com\.br\/x"/);
  // Texto continua escapado (sem XSS).
  await post('/post', { texto: '<script>alert(1)</script> https://x.com/a' }, ana);
  const html2 = await (await get('/feed', ana)).text();
  assert.doesNotMatch(html2, /<script>alert\(1\)/);
  assert.match(html2, /&lt;script&gt;/);
});
