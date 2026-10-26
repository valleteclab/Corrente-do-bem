'use strict';

/**
 * Corrente do Bem: o módulo de ajuda da rede.
 *  - Campanhas: um membro com selo cria uma campanha para alguém que precisa, com a lista do que falta.
 *  - Pedidos: qualquer pessoa registra o que precisa.
 *  - Ofertas: qualquer pessoa oferece uma doação (para um item de campanha, para um pedido, ou livre).
 *  - Repasse: o que uma campanha já recebeu vai para o próximo da fila (com sugestão da IA).
 */

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

module.exports = function criarRotasCorrente(db, { ia, auth, uploads, gamificacao }) {
  const router = express.Router();
  const TEMPO_IA_MS = Number(process.env.IA_TEMPO_LIMITE_MS || 15000);

  const ehModerador = (req) => req.signedCookies.admin === 'ok' || (req.usuario && req.usuario.papel === 'moderador');
  const podeGerenciar = (req, campanha) => Boolean(campanha && ((req.usuario && campanha.dono_id === req.usuario.id) || ehModerador(req)));
  const dadosDoMembro = (req) => (req.usuario ? { nome: req.usuario.nome, contato: req.usuario.whatsapp || req.usuario.email, cidade: req.usuario.cidade } : {});

  /** Itens abertos de campanhas ativas, agrupados por campanha (para o select de "quero doar"). */
  function itensPorCampanha() {
    const grupos = new Map();
    for (const n of db.necessidades.listar({ apenasAtivas: true })) {
      if (!grupos.has(n.campanha_id)) grupos.set(n.campanha_id, { id: n.campanha_id, titulo: n.campanha_titulo, beneficiario: n.campanha_beneficiario, itens: [] });
      grupos.get(n.campanha_id).itens.push(n);
    }
    return [...grupos.values()];
  }

  // ----- início do módulo -----
  router.get('/', (req, res) => {
    res.render('corrente/index', {
      titulo: res.locals.config.nome_campanha,
      campanhas: db.campanhas.listar({ status: 'ativa', limite: 6 }),
      pedidos: db.pedidos.listar({ status: 'aberto' }).slice(0, 4).map((p) => ({ ...p, nome: primeiroNome(p.nome) })),
      stats: db.estatisticas(),
    });
  });

  router.get('/como-funciona', (req, res) => {
    res.render('corrente/como-funciona', { titulo: 'Como funciona a corrente', stats: db.estatisticas() });
  });

  // ----- campanhas -----
  router.get('/campanhas', (req, res) => {
    res.render('corrente/campanhas', {
      titulo: 'Campanhas',
      ativas: db.campanhas.listar({ status: 'ativa' }),
      encerradas: db.campanhas.listar({ status: 'encerrada', limite: 20 }),
    });
  });

  router.get('/campanhas/nova', auth.exigirVerificado, (req, res) => {
    res.render('corrente/campanha-form', { titulo: 'Criar campanha', valores: { cidade: req.usuario.cidade, whatsapp: req.usuario.whatsapp }, erros: [], campanha: null });
  });

  function lerCampanha(b) {
    return {
      titulo: texto(b.titulo, 120),
      beneficiario: texto(b.beneficiario, 120),
      historia: texto(b.historia, 4000),
      cidade: texto(b.cidade, 120),
      link_video: texto(b.link_video, 500),
      whatsapp: texto(b.whatsapp, 40).replace(/\D/g, ''),
    };
  }

  router.post('/campanhas/nova', auth.exigirVerificado, (req, res) => {
    const valores = lerCampanha(req.body);
    const erros = [];
    if (!valores.titulo) erros.push('Dê um título à campanha.');
    if (!valores.beneficiario) erros.push('Diga quem está sendo ajudado (nome ou como chamar).');
    if (valores.historia.length < 20) erros.push('Conte a história com um pouco mais de detalhe.');
    if (erros.length) return res.status(422).render('corrente/campanha-form', { titulo: 'Criar campanha', valores, erros, campanha: null });
    const id = db.campanhas.criar({ ...valores, dono_id: req.usuario.id });
    gamificacao.premiar(req.usuario.id, 'campanha', String(id));
    res.locals.setFlash('ok', 'Campanha criada! Agora adicione o que a pessoa precisa.');
    res.redirect(`/corrente/campanha/${id}/gerenciar`);
  });

  router.get('/campanha/:id', (req, res, next) => {
    const campanha = db.campanhas.buscar(inteiroOuNulo(req.params.id));
    if (!campanha) return next();
    const itens = db.necessidades.listar({ campanha_id: campanha.id });
    const dono = campanha.dono_id ? db.usuarios.buscar(campanha.dono_id) : null;
    res.render('corrente/campanha', {
      titulo: campanha.titulo,
      campanha,
      dono,
      abertas: itens.filter((n) => n.status === 'aberta'),
      recebidas: itens.filter((n) => n.status === 'recebida'),
      podeGerenciar: podeGerenciar(req, campanha),
    });
  });

  // Área de quem cuida da campanha (dono ou moderação).
  function exigirGestor(req, res, next) {
    const campanha = db.campanhas.buscar(inteiroOuNulo(req.params.id));
    if (!campanha) return next();
    if (!podeGerenciar(req, campanha)) {
      res.locals.setFlash('erro', 'Só quem criou a campanha (ou a moderação) pode gerenciar.');
      return res.redirect(`/corrente/campanha/${campanha.id}`);
    }
    req.campanha = campanha;
    next();
  }

  router.get('/campanha/:id/gerenciar', exigirGestor, (req, res) => {
    res.render('corrente/campanha-gerenciar', {
      titulo: 'Gerenciar: ' + req.campanha.titulo,
      campanha: req.campanha,
      itens: db.necessidades.listar({ campanha_id: req.campanha.id }),
      ofertas: db.ofertas.listar({ campanha_id: req.campanha.id }),
      valores: req.campanha,
      erros: [],
    });
  });

  router.post('/campanha/:id/editar', exigirGestor, (req, res) => {
    const valores = lerCampanha(req.body);
    if (!valores.titulo || !valores.beneficiario) { res.locals.setFlash('erro', 'Título e nome de quem é ajudado são obrigatórios.'); return res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`); }
    db.campanhas.atualizar(req.campanha.id, valores);
    res.locals.setFlash('ok', 'Campanha atualizada.');
    res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
  });

  router.post('/campanha/:id/foto', exigirGestor, (req, res) => {
    uploads.foto(req, res, (err) => {
      const msg = uploads.mensagemErro(err);
      if (err && !msg) return res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Não foi possível salvar a foto.' });
      if (msg || !req.file) { res.locals.setFlash('erro', msg || 'Escolha uma imagem.'); return res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`); }
      if (req.campanha.foto) uploads.apagarFoto(req.campanha.foto);
      db.campanhas.atualizarFoto(req.campanha.id, req.file.filename);
      res.locals.setFlash('ok', 'Foto da campanha atualizada.');
      res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
    });
  });

  router.post('/campanha/:id/status', exigirGestor, (req, res) => {
    const status = req.body.status === 'encerrada' ? 'encerrada' : 'ativa';
    db.campanhas.mudarStatus(req.campanha.id, status);
    res.locals.setFlash('ok', status === 'encerrada' ? 'Campanha encerrada. Obrigado por cuidar dela!' : 'Campanha reaberta.');
    res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
  });

  router.post('/campanha/:id/necessidades', exigirGestor, (req, res) => {
    const titulo = texto(req.body.titulo, 200);
    if (titulo) db.necessidades.criar({ campanha_id: req.campanha.id, titulo, descricao: texto(req.body.descricao, 1000), categoria: categoriaValida(req.body.categoria) });
    else res.locals.setFlash('erro', 'Escreva o item.');
    res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
  });

  router.post('/campanha/:id/necessidades/:nid/:acao', exigirGestor, (req, res) => {
    const n = db.necessidades.buscar(inteiroOuNulo(req.params.nid));
    if (n && n.campanha_id === req.campanha.id) {
      if (req.params.acao === 'recebida') { db.necessidades.marcarRecebida(n.id); res.locals.setFlash('ok', `"${n.titulo}" marcado como recebido. Ofertas pendentes para esse item foram liberadas para repasse.`); }
      if (req.params.acao === 'reabrir') db.necessidades.reabrir(n.id);
      if (req.params.acao === 'remover') db.necessidades.remover(n.id);
    }
    res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
  });

  router.post('/campanha/:id/ofertas/:oid/status', exigirGestor, (req, res) => {
    const o = db.ofertas.buscar(inteiroOuNulo(req.params.oid));
    const status = req.body.status;
    if (o && o.campanha_id === req.campanha.id && ['aceita', 'concluida', 'cancelada', 'disponivel'].includes(status)) {
      if (status === 'concluida') { db.ofertas.concluir(o.id); if (o.usuario_id) gamificacao.premiar(o.usuario_id, 'doou', String(o.id)); }
      else db.ofertas.mudarStatus(o.id, status);
      res.locals.setFlash('ok', 'Oferta atualizada.');
    }
    res.redirect(`/corrente/campanha/${req.campanha.id}/gerenciar`);
  });

  // ----- quero ajudar (oferta de doação) -----
  function renderAjudar(req, res, { valores = {}, erros = [], status = 200 } = {}) {
    const necessidadeId = valores.necessidade_id || inteiroOuNulo(req.query.necessidade);
    const pedidoId = valores.pedido_id || inteiroOuNulo(req.query.pedido);
    const campanhaId = inteiroOuNulo(req.query.campanha);
    const necessidade = necessidadeId ? db.necessidades.buscar(necessidadeId) : null;
    const pedidoBruto = pedidoId ? db.pedidos.buscar(pedidoId) : null;
    const pedido = pedidoBruto && pedidoBruto.status === 'aberto' ? pedidoBruto : null;
    res.status(status).render('corrente/ajudar', {
      titulo: 'Quero ajudar',
      grupos: itensPorCampanha(),
      campanhaSelecionada: campanhaId || (necessidade ? necessidade.campanha_id : null),
      necessidadeSelecionada: necessidade,
      pedidoSelecionado: pedido ? { ...pedido, nome: primeiroNome(pedido.nome) } : null,
      valores: Object.keys(valores).length ? valores : dadosDoMembro(req),
      erros,
    });
  }

  router.get('/ajudar', (req, res) => renderAjudar(req, res));

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
    if (texto(b.site)) return res.redirect('/corrente');

    const erros = [];
    if (!valores.nome) erros.push('Diz seu nome pra gente saber quem é você.');
    if (!valores.contato) erros.push('Precisamos de um contato (WhatsApp ou e-mail) para combinar a entrega.');
    if (!valores.item) erros.push('Conta o que você quer doar.');
    if (erros.length) return renderAjudar(req, res, { valores, erros, status: 422 });

    const resultado = db.ofertas.criar({ ...valores, usuario_id: req.usuario ? req.usuario.id : null });

    // A IA liga a oferta ao item certo e, se já foi recebido, deixa a doação disponível para repasse.
    if (ia.ativo && !resultado.pedido) {
      const analise = ia.analisarEAplicar(db, resultado.id).catch((e) => { console.error(`IA: erro ao analisar oferta ${resultado.id}:`, e.message); return null; });
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
        campanha_beneficiario: oferta.campanha_beneficiario,
        campanha_id: oferta.campanha_id,
        pedido_item: oferta.pedido_item,
        autoriza_repasse: oferta.autoriza_repasse,
      },
      pedidosAbertos,
    });
  });

  // ----- preciso de ajuda (pedido) -----
  router.get('/pedir', (req, res) => {
    res.render('corrente/pedir', { titulo: 'Preciso de ajuda', valores: dadosDoMembro(req), erros: [] });
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
    if (erros.length) return res.status(422).render('corrente/pedir', { titulo: 'Preciso de ajuda', valores, erros });
    db.pedidos.criar({ ...valores, usuario_id: req.usuario ? req.usuario.id : null });
    // Um pedido novo pode ser atendido por doações que já estão esperando repasse.
    ia.analisarEmSegundoPlano(db, db.ofertas.listar({ status: 'disponivel' }).slice(0, 20).map((o) => o.id));
    res.redirect('/corrente/pedir/obrigado');
  });

  router.get('/pedir/obrigado', (req, res) => {
    res.render('corrente/pedir-obrigado', { titulo: 'Pedido registrado' });
  });

  router.get('/pedidos', (req, res) => {
    const categoria = CATEGORIAS.includes(req.query.categoria) ? req.query.categoria : '';
    const pedidos = db.pedidos.listar({ status: 'aberto', ...(categoria ? { categoria } : {}) })
      .map((p) => ({ id: p.id, nome: primeiroNome(p.nome), cidade: p.cidade, item: p.item, descricao: p.descricao, categoria: p.categoria, criado_em: p.criado_em }));
    res.render('corrente/pedidos', { titulo: 'Quem precisa de ajuda', pedidos, categoriaFiltro: categoria });
  });

  // ----- minha participação -----
  router.get('/minha', auth.exigirLogin, (req, res) => {
    res.render('corrente/minha', {
      titulo: 'Minha corrente',
      campanhas: db.campanhas.listar({ dono_id: req.usuario.id }),
      ofertas: db.ofertas.listar({ usuario_id: req.usuario.id }),
      pedidos: db.pedidos.doUsuario(req.usuario.id),
    });
  });

  return router;
};
