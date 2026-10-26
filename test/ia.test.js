'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { criarApp } = require('../src/server');
const { abrirBanco } = require('../src/db');
const { criarIa, ESQUEMA_RESPOSTA } = require('../src/ia');

const SENHA = 'segredo-teste';
let servidor;
let base;
let db;
let ia;
const chamadas = [];
let respostaFake = () => ({ necessidade_id: null, resumo: 'nada', sugestoes: [] });

// Cliente falso que imita client.beta.messages.create e devolve JSON como a API faria.
const clienteFake = {
  beta: {
    messages: {
      async create(params) {
        chamadas.push(params);
        const corpo = respostaFake(params);
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(corpo) }], usage: {} };
      },
    },
  },
};

before(async () => {
  db = abrirBanco(':memory:');
  ia = criarIa({ client: clienteFake, logger: { error() {} } });
  const app = criarApp({ db, ia, adminSenha: SENHA, segredo: 'segredo-cookie' });
  await new Promise((resolve) => { servidor = app.listen(0, resolve); });
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => servidor.close());

function form(dados) { return new URLSearchParams(dados).toString(); }
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
  return r.headers.get('set-cookie').split(';')[0];
}

test('esquema de resposta é um JSON Schema fechado', () => {
  assert.equal(ESQUEMA_RESPOSTA.type, 'object');
  assert.equal(ESQUEMA_RESPOSTA.additionalProperties, false);
  assert.deepEqual(ESQUEMA_RESPOSTA.required, ['necessidade_id', 'resumo', 'sugestoes']);
});

test('validar descarta IDs inventados, limita pontuação e ordena', () => {
  const r = ia.validar(
    { necessidade_id: 99, resumo: 'ok', sugestoes: [{ pedido_id: 1, pontuacao: 50, motivo: 'a' }, { pedido_id: 2, pontuacao: 900, motivo: 'b' }, { pedido_id: 7, pontuacao: 80, motivo: 'x' }, { pedido_id: 1, pontuacao: 10, motivo: 'dup' }] },
    { necessidades: [{ id: 1 }], pedidos: [{ id: 1 }, { id: 2 }] },
  );
  assert.equal(r.necessidade_id, null);
  assert.deepEqual(r.sugestoes.map((s) => [s.pedido_id, s.pontuacao]), [[2, 100], [1, 50]]);
});

test('IA liga a oferta escrita com outras palavras ao item já recebido e sugere repasse', async () => {
  const cookie = await loginAdmin();
  await post('/admin/corrente/necessidades', { titulo: 'Dentadura', categoria: 'Saúde e remédios' }, cookie);
  const [dentadura] = db.necessidades.listar();
  await post(`/admin/corrente/necessidades/${dentadura.id}/recebida`, {}, cookie);

  await post('/corrente/pedir', { nome: 'Dona Maria', contato: '119', cidade: 'Osasco', item: 'Prótese dentária', categoria: 'Saúde e remédios' });
  await post('/corrente/pedir', { nome: 'José', contato: '118', cidade: 'Barueri', item: 'Cesta básica', categoria: 'Alimentação' });
  const [cesta, protese] = db.pedidos.listar();
  assert.equal(protese.item, 'Prótese dentária');

  // A IA "entende" que prótese dentária = dentadura e que atende o pedido da Dona Maria.
  respostaFake = (params) => {
    const prompt = params.messages[0].content;
    assert.match(prompt, /Item oferecido: prótese dentária superior/);
    assert.match(prompt, /JÁ RECEBEU/);
    assert.doesNotMatch(prompt, /119/, 'contatos nunca vão para a IA');
    return {
      necessidade_id: dentadura.id,
      resumo: 'Ela já recebeu dentadura; a Dona Maria em Osasco precisa exatamente disso.',
      sugestoes: [
        { pedido_id: protese.id, pontuacao: 95, motivo: 'Mesmo item, cidade próxima.' },
        { pedido_id: cesta.id, pontuacao: 10, motivo: 'Não combina.' },
      ],
    };
  };

  const r = await post('/corrente/ajudar', { nome: 'Ana', contato: '117', cidade: 'Carapicuíba', item: 'prótese dentária superior', categoria: 'Saúde e remédios', autoriza_repasse: '1' });
  assert.equal(r.status, 302);
  const oferta = db.ofertas.listar()[0];
  assert.equal(oferta.necessidade_id, dentadura.id, 'IA ligou ao item certo');
  assert.equal(oferta.status, 'disponivel', 'item já recebido + autorização => disponível para repasse');
  assert.match(oferta.analise_ia, /Dona Maria/);

  const sugestoes = db.ofertas.sugestoesIa([oferta.id])[oferta.id];
  assert.equal(sugestoes.length, 2);
  assert.equal(sugestoes[0].pedido_id, protese.id);
  assert.equal(sugestoes[0].pontuacao, 95);

  // Chamada usou saída estruturada e cache no prompt de sistema.
  const chamada = chamadas.at(-1);
  assert.equal(chamada.output_config.format.type, 'json_schema');
  assert.equal(chamada.system[0].cache_control.type, 'ephemeral');
  assert.equal(chamada.fallbacks, 'default');

  // Página de obrigado já avisa que a doação vai seguir a corrente.
  const html = await (await fetch(base + r.headers.get('location'))).text();
  assert.match(html, /vai seguir a corrente/);

  // Painel mostra a sugestão com botão de repasse direto.
  const painel = await (await fetch(base + '/admin/corrente/ofertas', { headers: { cookie } })).text();
  assert.match(painel, /95%/);
  assert.match(painel, /Repassar para essa pessoa/);

  // Repassar pela sugestão.
  const rp = await post(`/admin/corrente/ofertas/${oferta.id}/repassar`, { pedido_id: protese.id }, cookie);
  assert.equal(rp.status, 302);
  assert.equal(db.ofertas.buscar(oferta.id).status, 'repassada');
});

test('doador que não autoriza repasse continua "nova" mesmo com item já recebido', async () => {
  const [dentadura] = db.necessidades.listar();
  respostaFake = () => ({ necessidade_id: dentadura.id, resumo: 'já recebeu', sugestoes: [] });
  const r = await post('/corrente/ajudar', { nome: 'Bia', contato: '116', item: 'dentadura', categoria: 'Saúde e remédios', autoriza_repasse: '0' });
  assert.equal(r.status, 302);
  const oferta = db.ofertas.listar().find((o) => o.nome === 'Bia');
  assert.equal(oferta.status, 'nova');
  assert.equal(oferta.necessidade_id, dentadura.id);
});

test('erro na IA não impede o doador de registrar a oferta', async () => {
  respostaFake = () => { throw new Error('API fora do ar'); };
  const r = await post('/corrente/ajudar', { nome: 'Caio', contato: '115', item: 'geladeira', categoria: 'Móveis e eletrodomésticos' });
  assert.equal(r.status, 302);
  const oferta = db.ofertas.listar().find((o) => o.nome === 'Caio');
  assert.equal(oferta.status, 'nova');
  assert.equal(oferta.ia_analisada_em, null);
});

test('botão "Analisar pendentes" analisa só as ofertas sem análise', async () => {
  const cookie = await loginAdmin();
  const antes = chamadas.length;
  respostaFake = () => ({ necessidade_id: null, resumo: 'sem correspondência', sugestoes: [] });
  const r = await post('/admin/corrente/ia/analisar', {}, cookie);
  assert.equal(r.status, 302);
  assert.equal(chamadas.length - antes, 1, 'só a oferta do Caio estava pendente');
  assert.equal(db.ofertas.idsParaAnalise().length, 0);
});

test('IA desativada: painel avisa e não chama a API', async () => {
  const dbOff = abrirBanco(':memory:');
  const iaOff = criarIa({ client: null });
  const app = criarApp({ db: dbOff, ia: iaOff, adminSenha: SENHA, segredo: 'x' });
  const s = await new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const login = await fetch(b + '/admin/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ senha: SENHA }), redirect: 'manual' });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const html = await (await fetch(b + '/admin', { headers: { cookie } })).text();
    assert.match(html, /ANTHROPIC_API_KEY/);
    assert.equal(iaOff.ativo, Boolean(process.env.ANTHROPIC_API_KEY));
  } finally { s.close(); }
});
