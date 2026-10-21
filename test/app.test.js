'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { criarApp } = require('../src/server');
const { abrirBanco } = require('../src/db');

const SENHA = 'segredo-teste';
let servidor;
let base;
let db;

before(async () => {
  db = abrirBanco(':memory:');
  const app = criarApp({ db, adminSenha: SENHA, segredo: 'segredo-cookie' });
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => servidor.close());

function form(dados) {
  return new URLSearchParams(dados).toString();
}

async function post(caminho, dados, cookie) {
  return fetch(base + caminho, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
    body: form(dados),
    redirect: 'manual',
  });
}

async function loginAdmin() {
  const r = await post('/admin/login', { senha: SENHA });
  assert.equal(r.status, 302);
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return cookie;
}

test('página inicial carrega', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Corrente do Bem/);
  assert.match(html, /Quero ajudar/);
});

test('painel exige login', async () => {
  const r = await fetch(base + '/admin', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/admin/login');
});

test('senha errada é recusada', async () => {
  const r = await post('/admin/login', { senha: 'errada' });
  assert.equal(r.status, 401);
});

test('fluxo completo: necessidade recebida libera oferta para repasse', async () => {
  const cookie = await loginAdmin();

  // Admin cadastra duas necessidades.
  let r = await post('/admin/necessidades', { titulo: 'Dentadura', categoria: 'Saúde e remédios', descricao: '' }, cookie);
  assert.equal(r.status, 302);
  r = await post('/admin/necessidades', { titulo: 'Geladeira', categoria: 'Móveis e eletrodomésticos', descricao: '' }, cookie);
  assert.equal(r.status, 302);
  const [dentadura, geladeira] = db.necessidades.listar().sort((a, b) => a.id - b.id);
  assert.equal(dentadura.titulo, 'Dentadura');

  // Dois doadores oferecem dentadura; um autoriza repasse, outro não.
  r = await post('/ajudar', { nome: 'Ana Souza', contato: '11999990000', item: 'Dentadura', categoria: 'Saúde e remédios', necessidade_id: dentadura.id, autoriza_repasse: '1' });
  assert.equal(r.status, 302);
  r = await post('/ajudar', { nome: 'Bruno Lima', contato: 'bruno@x.com', item: 'Dentadura', categoria: 'Saúde e remédios', necessidade_id: dentadura.id, autoriza_repasse: '0' });
  assert.equal(r.status, 302);
  assert.deepEqual(db.ofertas.listar().map((o) => o.status).sort(), ['nova', 'nova']);

  // Tia recebe a dentadura.
  r = await post(`/admin/necessidades/${dentadura.id}/recebida`, {}, cookie);
  assert.equal(r.status, 302);
  const ofertas = db.ofertas.listar().sort((a, b) => a.id - b.id);
  assert.equal(ofertas[0].status, 'disponivel', 'quem autorizou repasse fica disponível');
  assert.equal(ofertas[1].status, 'nova', 'quem não autorizou continua nova para contato');

  // Novo doador escolhe a dentadura já recebida: oferta já nasce disponível e a página avisa.
  r = await post('/ajudar', { nome: 'Carla Dias', contato: '11988880000', item: 'Dentadura nova', categoria: 'Saúde e remédios', necessidade_id: dentadura.id, autoriza_repasse: '1' });
  assert.equal(r.status, 302);
  const obrigado = await fetch(base + r.headers.get('location'));
  const htmlObrigado = await obrigado.text();
  assert.match(htmlObrigado, /vai seguir a corrente/);

  // Alguém pede ajuda.
  r = await post('/pedir', { nome: 'Dona Maria Silva', contato: '11977770000', cidade: 'Osasco', item: 'Dentadura', categoria: 'Saúde e remédios' });
  assert.equal(r.status, 302);
  const [pedido] = db.pedidos.listar();
  assert.equal(pedido.status, 'aberto');

  // Lista pública mostra só o primeiro nome e nunca o contato.
  const lista = await (await fetch(base + '/pedidos')).text();
  assert.match(lista, /Maria/);
  assert.doesNotMatch(lista, /Maria Silva/);
  assert.doesNotMatch(lista, /11977770000/);

  // Admin repassa a oferta da Ana para a Dona Maria e marca como entregue.
  r = await post(`/admin/ofertas/${ofertas[0].id}/repassar`, { pedido_id: pedido.id }, cookie);
  assert.equal(r.status, 302);
  assert.equal(db.ofertas.buscar(ofertas[0].id).status, 'repassada');
  r = await post(`/admin/ofertas/${ofertas[0].id}/status`, { status: 'concluida' }, cookie);
  assert.equal(r.status, 302);
  assert.equal(db.ofertas.buscar(ofertas[0].id).status, 'concluida');
  assert.equal(db.pedidos.buscar(pedido.id).status, 'atendido', 'pedido vira atendido quando a doação é entregue');

  // Doação direta para um pedido aberto nasce já repassada.
  r = await post('/pedir', { nome: 'Seu José', contato: '11966660000', item: 'Cesta básica', categoria: 'Alimentação' });
  const jose = db.pedidos.listar({ status: 'aberto' })[0];
  r = await post('/ajudar', { nome: 'Edu', contato: '11955550000', item: 'Cesta básica', categoria: 'Alimentação', pedido_id: jose.id });
  assert.equal(r.status, 302);
  const direta = db.ofertas.listar().find((o) => o.nome === 'Edu');
  assert.equal(direta.status, 'repassada');
  assert.equal(direta.pedido_id, jose.id);

  const stats = db.estatisticas();
  assert.equal(stats.ofertas_repassadas, 2);
  assert.equal(stats.pedidos_atendidos, 1);
  assert.equal(stats.necessidades_recebidas, 1);
  assert.equal(geladeira.status, 'aberta');
});

test('formulário de oferta valida campos obrigatórios', async () => {
  const r = await post('/ajudar', { nome: '', contato: '', item: '' });
  assert.equal(r.status, 422);
  const html = await r.text();
  assert.match(html, /Diz seu nome/);
});

test('admin consegue abrir todas as telas', async () => {
  const cookie = await loginAdmin();
  for (const caminho of ['/admin', '/admin/necessidades', '/admin/ofertas', '/admin/ofertas?status=disponivel', '/admin/pedidos', '/admin/config']) {
    const r = await fetch(base + caminho, { headers: { cookie } });
    assert.equal(r.status, 200, caminho);
  }
});

test('config é salva e aparece no site', async () => {
  const cookie = await loginAdmin();
  const r = await post('/admin/config', { nome_campanha: 'Corrente da Tia Lu', nome_beneficiaria: 'Tia Lu', historia: 'História aqui', link_video: '', whatsapp_contato: '(11) 99999-9999', cidade: '' }, cookie);
  assert.equal(r.status, 302);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /Corrente da Tia Lu/);
  assert.match(html, /wa\.me\/5511999999999/);
});
