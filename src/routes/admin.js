'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { CATEGORIAS, STATUS_OFERTA, STATUS_PEDIDO } = require('../db');
const { STATUS_VERIFICACAO, PAPEIS } = require('../db-rede');

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

module.exports = function criarRotasAdmin(db, { senha, ia, uploads, gamificacao }) {
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

  /** Moderador: senha do painel (cookie admin) ou membro com papel "moderador". */
  function ehModerador(req) {
    return req.signedCookies.admin === 'ok' || (req.usuario && req.usuario.papel === 'moderador');
  }
  /** Verificador: membro que só cuida da fila do selo. */
  function ehVerificador(req) {
    return req.usuario && req.usuario.papel === 'verificador';
  }

  router.get('/login', (req, res) => {
    if (ehModerador(req)) return res.redirect('/admin');
    if (ehVerificador(req)) return res.redirect('/admin/verificacoes');
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

  // Tudo abaixo exige moderação. Verificadores só entram na fila do selo.
  router.use((req, res, next) => {
    if (ehModerador(req)) {
      res.locals.admin = true;
      res.locals.papelPainel = 'moderador';
      return next();
    }
    if (ehVerificador(req)) {
      res.locals.admin = true;
      res.locals.papelPainel = 'verificador';
      if (req.path === '/' || req.path === '') return res.redirect('/admin/verificacoes');
      if (req.path.startsWith('/verificacoes')) return next();
      res.locals.setFlash('erro', 'Como verificador, você só tem acesso à fila do selo.');
      return res.redirect('/admin/verificacoes');
    }
    res.redirect('/admin/login');
  });

  /** Quem está decidindo: id do membro, ou null quando é a senha de admin. */
  const decisor = (req) => (req.usuario ? req.usuario.id : null);

  router.get('/', (req, res) => {
    res.render('admin/dashboard', {
      titulo: 'Moderação',
      stats: db.estatisticas(),
      statsRede: db.usuarios.contar(),
      verificacoes: db.verificacoes.listar({ status: 'em_analise' }).slice(0, 5),
      denuncias: db.denuncias.listar({ resolvida: 0 }).length,
      ofertasNovas: comSugestoes(db.ofertas.listar({ status: 'nova' }).slice(0, 5)),
      ofertasDisponiveis: comSugestoes(db.ofertas.listar({ status: 'disponivel' }).slice(0, 5)),
      pendentesIa: db.ofertas.idsParaAnalise().length,
    });
  });

  // ================= REDE =================

  // ----- verificações -----
  router.get('/verificacoes', (req, res) => {
    const status = STATUS_VERIFICACAO.includes(req.query.status) ? req.query.status : 'em_analise';
    res.render('admin/verificacoes', {
      titulo: 'Fila de verificação',
      verificacoes: db.verificacoes.listar({ status }),
      statusFiltro: status,
    });
  });

  // Fotos privadas da verificação: só a moderação vê.
  router.get('/verificacoes/:id/foto/:indice', (req, res, next) => {
    const v = db.verificacoes.buscar(idDe(req.params.id));
    const nome = v && v.fotos[Number.parseInt(req.params.indice, 10)];
    if (!nome) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(uploads.caminhoPrivado(nome), (err) => { if (err) next(); });
  });

  router.post('/verificacoes/:id/decidir', (req, res) => {
    const id = idDe(req.params.id);
    const aprovado = req.body.decisao === 'aprovar';
    const r = id ? db.verificacoes.decidir(id, aprovado, texto(req.body.motivo, 500), decisor(req)) : null;
    if (r) {
      for (const f of r.fotos) uploads.apagarPrivado(f);
      if (aprovado) gamificacao.premiar(r.usuario_id, 'selo', 'verificacao');
      res.locals.setFlash('ok', aprovado ? `Selo ${db.config.todas().nome_selo} concedido! As fotos enviadas foram apagadas.` : 'Verificação recusada. As fotos foram apagadas.');
    }
    res.redirect(req.body.voltar || '/admin/verificacoes');
  });

  router.post('/verificacoes/:id/ia', async (req, res) => {
    const id = idDe(req.params.id);
    if (!ia.ativo) { res.locals.setFlash('erro', 'IA desativada. Defina ANTHROPIC_API_KEY.'); return res.redirect('/admin/verificacoes'); }
    try {
      const a = id ? await ia.analisarVerificacaoEAplicar(db, uploads, id) : null;
      res.locals.setFlash('ok', a ? `IA recomenda: ${a.recomendacao}.` : 'Nada para analisar.');
    } catch (e) {
      res.locals.setFlash('erro', `IA: ${e.message}`);
    }
    res.redirect(req.body.voltar || '/admin/verificacoes');
  });

  // ----- usuários -----
  router.get('/usuarios', (req, res) => {
    const filtro = {
      status: STATUS_VERIFICACAO.includes(req.query.status) ? req.query.status : '',
      tipo: ['pessoa', 'empresa'].includes(req.query.tipo) ? req.query.tipo : '',
      busca: texto(req.query.q, 120),
    };
    const usuarios = db.usuarios.listar(filtro).map((u) => ({ ...u, decisoes: u.papel === 'membro' ? 0 : db.verificacoes.contarDecisoes(u.id) }));
    res.render('admin/usuarios', { titulo: 'Membros', usuarios, filtro, statusLista: STATUS_VERIFICACAO, papeis: PAPEIS });
  });

  router.post('/usuarios/:id/banir', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.usuarios.banir(id, req.body.banido !== '0'); res.locals.setFlash('ok', req.body.banido !== '0' ? 'Conta suspensa.' : 'Conta reativada.'); }
    res.redirect(req.body.voltar || '/admin/usuarios');
  });

  router.post('/usuarios/:id/status', (req, res) => {
    const id = idDe(req.params.id);
    if (id && STATUS_VERIFICACAO.includes(req.body.status)) {
      db.usuarios.mudarStatusVerificacao(id, req.body.status);
      if (req.body.status === 'verificado') gamificacao.premiar(id, 'selo', 'manual');
      res.locals.setFlash('ok', 'Status atualizado.');
    }
    res.redirect(req.body.voltar || '/admin/usuarios');
  });

  router.post('/usuarios/:id/papel', (req, res) => {
    const id = idDe(req.params.id);
    if (id && PAPEIS.includes(req.body.papel)) {
      db.usuarios.mudarPapel(id, req.body.papel);
      res.locals.setFlash('ok', { membro: 'Papel removido: agora é membro comum.', verificador: 'Agora é verificador: pode aprovar e recusar pedidos de selo.', moderador: 'Agora é moderador: acesso ao painel inteiro.' }[req.body.papel]);
    }
    res.redirect(req.body.voltar || '/admin/usuarios');
  });

  router.post('/usuarios/:id/convites', (req, res) => {
    const id = idDe(req.params.id);
    const q = Number.parseInt(req.body.quantidade, 10);
    if (id && Number.isInteger(q) && q > 0 && q <= 100) { db.usuarios.darConvites(id, q); res.locals.setFlash('ok', `${q} convite(s) adicionados.`); }
    res.redirect(req.body.voltar || '/admin/usuarios');
  });

  // ----- denúncias -----
  router.get('/denuncias', (req, res) => {
    res.render('admin/denuncias', { titulo: 'Denúncias', denuncias: db.denuncias.listar({ resolvida: req.query.resolvidas === '1' ? 1 : 0 }), mostrandoResolvidas: req.query.resolvidas === '1' });
  });

  router.post('/denuncias/:id/resolver', (req, res) => {
    const id = idDe(req.params.id);
    if (id) {
      if (req.body.remover_post === '1' && idDe(req.body.post_id)) db.posts.remover(idDe(req.body.post_id));
      db.denuncias.resolver(id);
      res.locals.setFlash('ok', 'Denúncia resolvida.');
    }
    res.redirect('/admin/denuncias');
  });

  // ----- configurações -----
  router.get('/config', (req, res) => {
    res.render('admin/config', { titulo: 'Configurações' });
  });

  router.post('/config', (req, res) => {
    db.config.salvar({
      nome_rede: texto(req.body.nome_rede, 120) || 'Elo Brasil',
      slogan: texto(req.body.slogan, 200),
      descricao_rede: texto(req.body.descricao_rede, 4000),
      cidade_foco: texto(req.body.cidade_foco, 120),
      cadastro_aberto: req.body.cadastro_aberto === '1' ? '1' : '0',
      nome_selo: texto(req.body.nome_selo, 40) || 'Patriota',
      nome_campanha: texto(req.body.nome_campanha, 120) || 'Corrente do Bem',
      descricao_corrente: texto(req.body.descricao_corrente, 2000),
      whatsapp_contato: texto(req.body.whatsapp_contato, 40).replace(/\D/g, ''),
      cidade: texto(req.body.cidade, 120),
    });
    res.locals.setFlash('ok', 'Configurações salvas.');
    res.redirect('/admin/config');
  });

  // ================= CORRENTE DO BEM =================

  router.post('/corrente/ia/analisar', async (req, res, next) => {
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
      res.redirect(req.body.voltar || '/admin/corrente/ofertas');
    } catch (e) { next(e); }
  });

  router.post('/corrente/ofertas/:id/ia', async (req, res) => {
    const id = idDe(req.params.id);
    if (!ia.ativo) {
      res.locals.setFlash('erro', 'IA desativada. Defina ANTHROPIC_API_KEY no servidor.');
      return res.redirect(req.body.voltar || '/admin/corrente/ofertas');
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
    res.redirect(req.body.voltar || '/admin/corrente/ofertas');
  });

  // ----- necessidades -----
  router.get('/corrente/necessidades', (req, res) => {
    res.render('admin/corrente/necessidades', { titulo: 'Itens das campanhas', necessidades: db.necessidades.listar(), campanhas: db.campanhas.listar({ status: 'ativa' }), editando: null });
  });

  router.get('/corrente/necessidades/:id/editar', (req, res) => {
    const n = db.necessidades.buscar(idDe(req.params.id));
    if (!n) return res.redirect('/admin/corrente/necessidades');
    res.render('admin/corrente/necessidades', { titulo: 'Editar item', necessidades: db.necessidades.listar(), campanhas: db.campanhas.listar({ status: 'ativa' }), editando: n });
  });

  router.post('/corrente/necessidades', (req, res) => {
    const titulo = texto(req.body.titulo, 200);
    if (!titulo) { res.locals.setFlash('erro', 'O título é obrigatório.'); return res.redirect('/admin/corrente/necessidades'); }
    db.necessidades.criar({ campanha_id: idDe(req.body.campanha_id), titulo, descricao: texto(req.body.descricao, 1000), categoria: categoriaValida(req.body.categoria) });
    res.locals.setFlash('ok', 'Necessidade adicionada.');
    res.redirect('/admin/corrente/necessidades');
  });

  router.post('/corrente/necessidades/:id/editar', (req, res) => {
    const id = idDe(req.params.id);
    const titulo = texto(req.body.titulo, 200);
    if (id && titulo) {
      db.necessidades.atualizar(id, { titulo, descricao: texto(req.body.descricao, 1000), categoria: categoriaValida(req.body.categoria) });
      res.locals.setFlash('ok', 'Necessidade atualizada.');
    }
    res.redirect('/admin/corrente/necessidades');
  });

  router.post('/corrente/necessidades/:id/recebida', (req, res) => {
    const id = idDe(req.params.id);
    if (id) {
      db.necessidades.marcarRecebida(id);
      res.locals.setFlash('ok', 'Marcada como recebida. As ofertas pendentes para esse item agora estão disponíveis para repasse.');
    }
    res.redirect(req.body.voltar || '/admin/corrente/necessidades');
  });

  router.post('/corrente/necessidades/:id/reabrir', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.necessidades.reabrir(id); res.locals.setFlash('ok', 'Necessidade reaberta.'); }
    res.redirect('/admin/corrente/necessidades');
  });

  router.post('/corrente/necessidades/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.necessidades.remover(id); res.locals.setFlash('ok', 'Necessidade removida.'); }
    res.redirect('/admin/corrente/necessidades');
  });

  // ----- ofertas -----
  router.get('/corrente/ofertas', (req, res) => {
    const status = STATUS_OFERTA.includes(req.query.status) ? req.query.status : '';
    res.render('admin/corrente/ofertas', {
      titulo: 'Ofertas de doação',
      ofertas: comSugestoes(db.ofertas.listar(status ? { status } : {})),
      statusFiltro: status,
      statusLista: STATUS_OFERTA,
      pedidosAbertos: db.pedidos.listar({ status: 'aberto' }),
      pendentesIa: db.ofertas.idsParaAnalise().length,
    });
  });

  router.post('/corrente/ofertas/:id/status', (req, res) => {
    const id = idDe(req.params.id);
    const status = req.body.status;
    if (id && STATUS_OFERTA.includes(status)) {
      if (status === 'concluida') {
        const o = db.ofertas.buscar(id);
        db.ofertas.concluir(id);
        if (o && o.usuario_id) gamificacao.premiar(o.usuario_id, 'doou', String(id));
      } else db.ofertas.mudarStatus(id, status, req.body.observacao !== undefined ? texto(req.body.observacao, 1000) : undefined);
      res.locals.setFlash('ok', 'Oferta atualizada.');
    }
    res.redirect(req.body.voltar || '/admin/corrente/ofertas');
  });

  router.post('/corrente/ofertas/:id/repassar', (req, res) => {
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
    res.redirect(req.body.voltar || '/admin/corrente/ofertas');
  });

  router.post('/corrente/ofertas/:id/observacao', (req, res) => {
    const id = idDe(req.params.id);
    if (id) {
      const o = db.ofertas.buscar(id);
      if (o) db.ofertas.mudarStatus(id, o.status, texto(req.body.observacao, 1000));
    }
    res.redirect(req.body.voltar || '/admin/corrente/ofertas');
  });

  router.post('/corrente/ofertas/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.ofertas.remover(id); res.locals.setFlash('ok', 'Oferta removida.'); }
    res.redirect('/admin/corrente/ofertas');
  });

  // ----- pedidos -----
  router.get('/corrente/pedidos', (req, res) => {
    const status = STATUS_PEDIDO.includes(req.query.status) ? req.query.status : '';
    res.render('admin/corrente/pedidos', {
      titulo: 'Pedidos de ajuda',
      pedidos: db.pedidos.listar(status ? { status } : {}),
      statusFiltro: status,
      statusLista: STATUS_PEDIDO,
    });
  });

  router.post('/corrente/pedidos/:id/status', (req, res) => {
    const id = idDe(req.params.id);
    if (id && STATUS_PEDIDO.includes(req.body.status)) {
      db.pedidos.mudarStatus(id, req.body.status);
      res.locals.setFlash('ok', 'Pedido atualizado.');
    }
    res.redirect(req.body.voltar || '/admin/corrente/pedidos');
  });

  router.post('/corrente/pedidos/:id/remover', (req, res) => {
    const id = idDe(req.params.id);
    if (id) { db.pedidos.remover(id); res.locals.setFlash('ok', 'Pedido removido.'); }
    res.redirect('/admin/corrente/pedidos');
  });

  return router;
};
