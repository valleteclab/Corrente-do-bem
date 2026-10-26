'use strict';

const express = require('express');
const { CATEGORIAS } = require('../db');

function texto(valor, max = 500) {
  return String(valor ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function categoriaValida(valor) {
  return CATEGORIAS.includes(valor) ? valor : 'Outros';
}

function inteiroOuNulo(valor) {
  const n = Number.parseInt(valor, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const TRATAMENTOS = new Set(['dona', 'dono', 'seu', 'sr', 'sr.', 'sra', 'sra.', 'srta', 'srta.', 'dr', 'dr.', 'dra', 'dra.', 'senhor', 'senhora', 'tia', 'tio', 'vó', 'vô']);

/** Primeiro nome para exibição pública. Mantém o tratamento, se houver ("Dona Maria"). */
function primeiroNome(nome) {
  const partes = String(nome || '').trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return 'Alguém';
  if (partes.length > 1 && TRATAMENTOS.has(partes[0].toLowerCase())) return `${partes[0]} ${partes[1]}`;
  return partes[0];
}

/** Espera a promessa até `ms`; se demorar mais, segue sem o resultado (a análise continua em segundo plano). */
function comTempoLimite(promessa, ms) {
  let timer;
  const limite = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

module.exports = function criarRotasPublicas(db, ia) {
  const router = express.Router();
  const TEMPO_IA_MS = Number(process.env.IA_TEMPO_LIMITE_MS || 15000);

  router.get('/', (req, res) => {
    const todas = db.necessidades.listar();
    res.render('corrente/index', {
      titulo: null,
      abertas: todas.filter((n) => n.status === 'aberta'),
      recebidas: todas.filter((n) => n.status === 'recebida'),
      stats: db.estatisticas(),
    });
  });

  router.get('/como-funciona', (req, res) => {
    res.render('corrente/como-funciona', { titulo: 'Como funciona a corrente', stats: db.estatisticas() });
  });

  // ----- quero ajudar -----
  router.get('/ajudar', (req, res) => {
    const necessidadeId = inteiroOuNulo(req.query.necessidade);
    const pedidoId = inteiroOuNulo(req.query.pedido);
    const necessidade = necessidadeId ? db.necessidades.buscar(necessidadeId) : null;
    const pedidoBruto = pedidoId ? db.pedidos.buscar(pedidoId) : null;
    const pedido = pedidoBruto && pedidoBruto.status === 'aberto' ? pedidoBruto : null;
    res.render('corrente/ajudar', {
      titulo: 'Quero ajudar',
      necessidades: db.necessidades.listar(),
      necessidadeSelecionada: necessidade,
      pedidoSelecionado: pedido ? { ...pedido, nome: primeiroNome(pedido.nome) } : null,
      valores: {},
      erros: [],
    });
  });

  router.post('/ajudar', async (req, res) => {
    const b = req.body;
    const valores = {
      nome: texto(b.nome, 120),
      contato: texto(b.contato, 120),
      cidade: texto(b.cidade, 120),
      item: texto(b.item, 200),
      descricao: texto(b.descricao, 1000),
      categoria: categoriaValida(b.categoria),
      necessidade_id: inteiroOuNulo(b.necessidade_id),
      pedido_id: inteiroOuNulo(b.pedido_id),
      autoriza_repasse: b.autoriza_repasse !== '0',
    };

    // Honeypot simples contra bots.
    if (texto(b.site)) return res.redirect('/corrente');

    const erros = [];
    if (!valores.nome) erros.push('Diz seu nome pra gente saber quem é você.');
    if (!valores.contato) erros.push('Precisamos de um contato (WhatsApp ou e-mail) para combinar a entrega.');
    if (!valores.item) erros.push('Conta o que você quer doar.');

    if (erros.length) {
      const necessidade = valores.necessidade_id ? db.necessidades.buscar(valores.necessidade_id) : null;
      const pedido = valores.pedido_id ? db.pedidos.buscar(valores.pedido_id) : null;
      return res.status(422).render('corrente/ajudar', {
        titulo: 'Quero ajudar',
        necessidades: db.necessidades.listar(),
        necessidadeSelecionada: necessidade,
        pedidoSelecionado: pedido ? { ...pedido, nome: primeiroNome(pedido.nome) } : null,
        valores,
        erros,
      });
    }

    const resultado = db.ofertas.criar(valores);

    // A IA liga a oferta ao item certo da lista (mesmo escrito com outras palavras) e,
    // se ela já recebeu, já deixa a doação disponível com sugestões de para quem repassar.
    // Se demorar, o doador não espera: a análise termina em segundo plano.
    if (ia.ativo && !resultado.pedido) {
      const analise = ia.analisarEAplicar(db, resultado.id).catch((e) => {
        console.error(`IA: erro ao analisar oferta ${resultado.id}:`, e.message);
        return null;
      });
      await comTempoLimite(analise, TEMPO_IA_MS);
    }
    res.redirect(`/corrente/ajudar/obrigado/${resultado.id}`);
  });

  router.get('/ajudar/obrigado/:id', (req, res) => {
    const oferta = db.ofertas.buscar(inteiroOuNulo(req.params.id));
    if (!oferta) return res.redirect('/corrente');
    const pedidosAbertos = oferta.status === 'disponivel'
      ? db.pedidos.listar({ status: 'aberto' }).slice(0, 6).map((p) => ({ ...p, nome: primeiroNome(p.nome) }))
      : [];
    res.render('corrente/ajudar-obrigado', {
      titulo: 'Obrigado!',
      oferta: {
        item: oferta.item,
        status: oferta.status,
        necessidade_titulo: oferta.necessidade_titulo,
        necessidade_status: oferta.necessidade_status,
        pedido_item: oferta.pedido_item,
        autoriza_repasse: oferta.autoriza_repasse,
      },
      pedidosAbertos,
    });
  });

  // ----- preciso de ajuda -----
  router.get('/pedir', (req, res) => {
    res.render('corrente/pedir', { titulo: 'Preciso de ajuda', valores: {}, erros: [] });
  });

  router.post('/pedir', (req, res) => {
    const b = req.body;
    const valores = {
      nome: texto(b.nome, 120),
      contato: texto(b.contato, 120),
      cidade: texto(b.cidade, 120),
      item: texto(b.item, 200),
      descricao: texto(b.descricao, 1000),
      categoria: categoriaValida(b.categoria),
    };
    if (texto(b.site)) return res.redirect('/corrente');

    const erros = [];
    if (!valores.nome) erros.push('Diz seu nome.');
    if (!valores.contato) erros.push('Precisamos de um contato (WhatsApp ou e-mail) para avisar quando aparecer uma doação.');
    if (!valores.item) erros.push('Conta o que você está precisando.');

    if (erros.length) {
      return res.status(422).render('corrente/pedir', { titulo: 'Preciso de ajuda', valores, erros });
    }
    db.pedidos.criar(valores);
    // Um pedido novo pode ser atendido por doações que já estão esperando repasse.
    ia.analisarEmSegundoPlano(db, db.ofertas.listar({ status: 'disponivel' }).slice(0, 20).map((o) => o.id));
    res.redirect('/corrente/pedir/obrigado');
  });

  router.get('/pedir/obrigado', (req, res) => {
    res.render('corrente/pedir-obrigado', { titulo: 'Pedido registrado' });
  });

  // ----- lista pública de quem precisa -----
  router.get('/pedidos', (req, res) => {
    const categoria = CATEGORIAS.includes(req.query.categoria) ? req.query.categoria : '';
    const pedidos = db.pedidos.listar({ status: 'aberto', ...(categoria ? { categoria } : {}) })
      .map((p) => ({ id: p.id, nome: primeiroNome(p.nome), cidade: p.cidade, item: p.item, descricao: p.descricao, categoria: p.categoria, criado_em: p.criado_em }));
    res.render('corrente/pedidos', { titulo: 'Quem mais precisa de ajuda', pedidos, categoriaFiltro: categoria });
  });

  return router;
};
