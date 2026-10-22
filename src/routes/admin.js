'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { CATEGORIAS, STATUS_OFERTA, STATUS_PEDIDO } = require('../db');

function texto(valor, max = 500) {
  return String(valor ?? '').replace(/\r/g, '').trim().slice(0, max);
}

function categoriaValida(valor) {
  return CATEGORIAS.includes(valor) ? valor : 'Outros';
}

function idDe(param) {
  const n = Number.parseInt(param, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function senhasIguais(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = function criarRotasAdmin(db, { senha, ia }) {
  const router = express.Router();
  const painelAtivo = Boolean(senha);

  /** Anexa as sugestões da IA (pedidos abertos) a cada oferta da lista. */
  function comSugestoes(ofertas) {
    const mapa = db.ofertas.sugestoesIa(ofertas.map((o) => o.id));
    return ofertas.map((o) => ({ ...o, sugestoes: mapa[o.id] || [] }));
  }

  // Limita tentativas de login por IP (bem simples, em memória).
  const tentativas = new Map();
  function registrarTentativa(ip) {
    const agora = Date.now();
    const lista = (tentativas.get(ip) || []).filter((t) => agora - t < 15 * 60_000);
    lista.push(agora);
    tentativas.set(ip, lista);
    return lista.length;
  }

  router.get('/login', (req, res) => {
    if (req.signedCookies.admin === 'ok') return res.redirect('/admin');
    res.render('admin/login', { titulo: 'Entrar no painel', painelAtivo, erro: null });
  });

  router.post('/login', (req, res) => {
    if (!painelAtivo) return res.status(403).render('admin/login', { titulo: 'Entrar no painel', painelAtivo, erro: null });
    const quantas = registrarTentativa(req.ip);
    if (quantas > 10) {
      return res.status(429).render('admin/login', { titulo: 'Entrar no painel', painelAtivo, erro: 'Muitas tentativas. Espera uns minutos e tenta de novo.' });
    }
    if (senhasIguais(req.body.senha || '', senha)) {
      res.cookie('admin', 'ok', { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60_000 });
      return res.redirect('/admin');
    }
    res.status(401).render('admin/login', { titulo: 'Entrar no painel', painelAtivo, erro: 'Senha incorreta.' });
  });

  router.post('/sair', (req, res) => {
    res.clearCookie('admin');
    res.redirect('/');
  });

  // Tudo abaixo exige login.
  router.use((req, res, next) => {
    if (!painelAtivo || req.signedCookies.admin !== 'ok') return res.redirect('/admin/login');
    res.locals.admin = true;
    next();
  });

  router.get('/', (req, res) => {
    res.render('admin/dashboard', {
      titulo: 'Painel',
      stats: db.estatisticas(),
      ofertasNovas: comSugestoes(db.ofertas.listar({ status: 'nova' }).slice(0, 8)),
      ofertasDisponiveis: comSugestoes(db.ofertas.listar({ status: 'disponivel' }).slice(0, 8)),
      pendentesIa: db.ofertas.idsParaAnalise().length,
    });
  });

  // ----- IA -----
  router.post('/ia/analisar', async (req, res, next) => {
    if (!ia.ativo) {
      res.locals.setFlash('erro', 'IA desativada. Defina ANTHROPIC_API_KEY no servidor.');
      return res.redirect(req.body.voltar || '/admin');
    }
    try {
      const ids = db.ofertas.idsParaAnalise({ todas: req.body.todas === '1' });
      if (!ids.length) {
        res.locals.setFlash('ok', 'Nenhuma oferta pendente de análise.');
      } else {
        const r = await ia.analisarLote(db, ids);
        res.locals.setFlash(r.erros ? 'erro' : 'ok', `IA analisou ${r.ok} oferta(s)${r.erros ? `, ${r.erros} com erro` : ''}.`);
      }
      res.redirect(req.body.voltar || '/admin/ofertas');
    } catch (e) { next(e); }
  });

  router.post('/ofertas/:id/ia', async (req, res, next) => {
    const id = idDe(req.params.id);
    if (!ia.ativo) {
      res.locals.setFlash('erro', 'IA desativada. Defina ANTHROPIC_API_KEY no servidor.');
      return res.redirect(req.body.voltar || '/admin/ofertas');
    }
    try {
      const analise = id ? await ia.analisarEAplicar(db, id) : null;
      if (analise) {
        res.locals.setFlash('ok', analise.sugestoes.length
          ? `IA encontrou ${analise.sugestoes.length} pedido(s) que essa doação pode atender.`
          : 'IA analisou a oferta, mas não encontrou pedido compatível por enquanto.');
      }
    } catch (e) {
      res.locals.setFlash('erro', `IA: ${e.message}`);
    }
    res.redirect(req.body.voltar || '/admin/ofertas');
  });

  // ----- necessidades -----
  router.get('/necessidades', (req, res) => {
    res.render('admin/necessidades', { titulo: 'O que ela precisa', necessidades: db.necessidades.listar(), editando: null });
  });

  router.get('/necessidades/:id/editar', (req, res) => {
    const n = db.necessidades.buscar(idDe(req.params.id));
    if (!n) return res.redirect('/admin/necessidades');
    res.render('admin/necessidades', { titulo: 'Editar necessidade', necessidades: db.necessidades.listar(), editando: n });
  });

  router.post('/necessidades', (req, res) => {
    const titulo = texto(req.body.titulo, 200);
    if (!titulo) { res.locals.setFlash('erro', 'O título é obrigatório.'); return res.redirect('/admin/necessidades'); }
    db.necessidades.criar({ titulo, descricao: texto(req.body.descricao, 1000), categoria: categoriaValida(req.body.categoria) });
    res.locals.setFlash('ok', 'Necessidade adicionada.');
    res.redirect('/admin/necessidades');
  });

  router.post('/necessidades/:id/editar', (req, res) => {
    const id = idDe(req.params.id);
    const titulo = texto(req.body.titulo, 200);
    if (id && titulo) {
      db.necessidades.atualizar(id, { titulo, descricao: texto(req.body.descricao, 1000), categoria: categoriaValida(req.body.categoria) });
      res.locals.setFlash('ok', 'Necessidade atualizada.');
    }
    res.redirect('/admin/necessidades');
  });

  router.post('/necessidades/:id/recebida', (req, res) => {
    const id = idDe(req.params.id);
    if (id) {
      db.necessidades.marcarRecebida(id);
      res.locals.setFlash('ok', 'Marcada como recebida. As ofertas pendentes para esse item agora estão disponíveis para repasse.');
    }
    res.redirect(req.body.voltar || '/admin/necessidades');
  });

  router.post('/necessidades/:id/reabrir', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.necessidades.reabrir(id); res.locals.setFlash('ok', 'Necessidade reaberta.'); }
    res.redirect('/admin/necessidades');
  });

  router.post('/necessidades/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.necessidades.remover(id); res.locals.setFlash('ok', 'Necessidade removida.'); }
    res.redirect('/admin/necessidades');
  });

  // ----- ofertas -----
  router.get('/ofertas', (req, res) => {
    const status = STATUS_OFERTA.includes(req.query.status) ? req.query.status : '';
    res.render('admin/ofertas', {
      titulo: 'Ofertas de doação',
      ofertas: comSugestoes(db.ofertas.listar(status ? { status } : {})),
      statusFiltro: status,
      statusLista: STATUS_OFERTA,
      pedidosAbertos: db.pedidos.listar({ status: 'aberto' }),
      pendentesIa: db.ofertas.idsParaAnalise().length,
    });
  });

  router.post('/ofertas/:id/status', (req, res) => {
    const id = idDe(req.params.id);
    const status = req.body.status;
    if (id && STATUS_OFERTA.includes(status)) {
      if (status === 'concluida') db.ofertas.concluir(id);
      else db.ofertas.mudarStatus(id, status, req.body.observacao !== undefined ? texto(req.body.observacao, 1000) : undefined);
      res.locals.setFlash('ok', 'Oferta atualizada.');
    }
    res.redirect(req.body.voltar || '/admin/ofertas');
  });

  router.post('/ofertas/:id/repassar', (req, res) => {
    const id = idDe(req.params.id);
    const pedidoId = idDe(req.body.pedido_id);
    if (id && pedidoId) {
      try {
        db.ofertas.repassar(id, pedidoId);
        res.locals.setFlash('ok', 'Doação repassada! Agora é só colocar doador e quem precisa em contato.');
      } catch (e) {
        res.locals.setFlash('erro', e.message);
      }
    } else {
      res.locals.setFlash('erro', 'Escolha para quem repassar.');
    }
    res.redirect(req.body.voltar || '/admin/ofertas');
  });

  router.post('/ofertas/:id/observacao', (req, res) => {
    const id = idDe(req.params.id);
    if (id) {
      const o = db.ofertas.buscar(id);
      if (o) db.ofertas.mudarStatus(id, o.status, texto(req.body.observacao, 1000));
    }
    res.redirect(req.body.voltar || '/admin/ofertas');
  });

  router.post('/ofertas/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.ofertas.remover(id); res.locals.setFlash('ok', 'Oferta removida.'); }
    res.redirect('/admin/ofertas');
  });

  // ----- pedidos -----
  router.get('/pedidos', (req, res) => {
    const status = STATUS_PEDIDO.includes(req.query.status) ? req.query.status : '';
    res.render('admin/pedidos', {
      titulo: 'Pedidos de ajuda',
      pedidos: db.pedidos.listar(status ? { status } : {}),
      statusFiltro: status,
      statusLista: STATUS_PEDIDO,
    });
  });

  router.post('/pedidos/:id/status', (req, res) => {
    const id = idDe(req.params.id);
    if (id && STATUS_PEDIDO.includes(req.body.status)) {
      db.pedidos.mudarStatus(id, req.body.status);
      res.locals.setFlash('ok', 'Pedido atualizado.');
    }
    res.redirect(req.body.voltar || '/admin/pedidos');
  });

  router.post('/pedidos/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.pedidos.remover(id); res.locals.setFlash('ok', 'Pedido removido.'); }
    res.redirect('/admin/pedidos');
  });

  // ----- configurações -----
  router.get('/config', (req, res) => {
    res.render('admin/config', { titulo: 'Configurações da campanha' });
  });

  router.post('/config', (req, res) => {
    db.config.salvar({
      nome_campanha: texto(req.body.nome_campanha, 120) || 'Corrente do Bem',
      nome_beneficiaria: texto(req.body.nome_beneficiaria, 120) || 'Tia',
      historia: texto(req.body.historia, 4000),
      link_video: texto(req.body.link_video, 500),
      whatsapp_contato: texto(req.body.whatsapp_contato, 40).replace(/\D/g, ''),
      cidade: texto(req.body.cidade, 120),
    });
    res.locals.setFlash('ok', 'Configurações salvas.');
    res.redirect('/admin/config');
  });

  return router;
};
