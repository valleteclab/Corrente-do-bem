'use strict';

const express = require('express');
const { CATEGORIAS_EMPRESA, TIPOS_VAGA } = require('../db-rede');

function texto(v, max = 500) { return String(v ?? '').replace(/\r/g, '').trim().slice(0, max); }
function idDe(v) { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; }
function instagramLimpo(v) { return texto(v, 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, ''); }
function redeLimpa(v) { return texto(v, 200).replace(/^@/, ''); }

module.exports = function criarRotasRede(db, { auth, uploads, ia, gamificacao }) {
  const router = express.Router();

  // ----- início -----
  router.get('/', (req, res) => {
    const stats = db.usuarios.contar();
    const destaques = db.pontos.ranking({ tipo: 'empresa', limite: 6 });
    const vagas = db.vagas.listar().slice(0, 4);
    res.render('rede/index', { titulo: null, stats, destaques, vagas });
  });

  router.get('/sobre', (req, res) => res.render('rede/sobre', { titulo: 'Como funciona', niveis: gamificacao.NIVEIS, acoes: gamificacao.ACOES }));
  router.get('/termos', (req, res) => res.render('rede/termos', { titulo: 'Termos e privacidade' }));

  router.get('/ranking', (req, res) => {
    const cidade = texto(req.query.cidade, 120);
    res.render('rede/ranking', {
      titulo: 'Ranking',
      empresas: db.pontos.ranking({ tipo: 'empresa', cidade, limite: 20 }),
      pessoas: db.pontos.ranking({ tipo: 'pessoa', cidade, limite: 20 }),
      cidadeFiltro: cidade,
      nivelDe: gamificacao.nivelDe,
    });
  });

  // ----- feed -----
  router.get('/feed', auth.exigirLogin, (req, res) => {
    const cidade = texto(req.query.cidade, 120);
    res.render('rede/feed', {
      titulo: 'Feed',
      posts: db.posts.listar({ cidade, usuarioId: req.usuario.id }),
      cidadeFiltro: cidade,
      modo: 'feed',
      stats: db.usuarios.contar(),
      meu: gamificacao.resumo(req.usuario.id),
      pendentes: req.usuario.tipo === 'empresa' ? db.negocios.daEmpresa(req.usuario.id, 'pendente').length : 0,
    });
  });

  // Reels: só publicações com vídeo.
  router.get('/reels', auth.exigirLogin, (req, res) => {
    res.render('rede/reels', { titulo: 'Reels', posts: db.posts.listar({ apenasVideos: true, usuarioId: req.usuario.id, limite: 30 }) });
  });

  // Uma publicação (para compartilhar o link).
  router.get('/p/:id', (req, res, next) => {
    const id = idDe(req.params.id);
    const p = id ? db.posts.buscarCompleto(id, req.usuario ? req.usuario.id : null) : null;
    if (!p) return next();
    res.render('rede/post', { titulo: `${p.nome} no feed`, post: p });
  });

  router.post('/post', auth.exigirVerificado, (req, res) => {
    uploads.midias(req, res, (err) => {
      const msg = uploads.mensagemErro(err);
      const arquivos = req.files || [];
      const falhar = (mensagem) => { for (const f of arquivos) uploads.apagarMidia(f.filename); res.locals.setFlash('erro', mensagem); res.redirect('/feed'); };
      if (err && !msg) return falhar('Não foi possível receber os arquivos.');
      if (msg) return falhar(msg);
      const txt = texto(req.body.texto, 2000);
      const videos = arquivos.filter((f) => uploads.ehVideo(f.mimetype));
      if (videos.length > 1 || (videos.length === 1 && arquivos.length > 1)) return falhar('Um vídeo por publicação, sem misturar com fotos.');
      if (txt.length < 1 && arquivos.length === 0) return falhar('Escreva algo ou envie uma foto ou vídeo.');
      const midias = arquivos.map((f) => ({ tipo: uploads.ehVideo(f.mimetype) ? 'video' : 'imagem', arquivo: f.filename }));
      const id = db.posts.criar({ usuario_id: req.usuario.id, texto: txt, cidade: req.usuario.cidade, midias });
      gamificacao.premiar(req.usuario.id, 'post', String(id));
      res.redirect(videos.length ? '/reels' : '/feed');
    });
  });

  router.post('/post/:id/curtir', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    if (id && db.posts.buscar(id)) db.posts.curtir(id, req.usuario.id);
    res.redirect(req.body.voltar || '/feed');
  });

  router.post('/post/:id/comentar', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const txt = texto(req.body.texto, 600);
    if (id && txt && db.posts.buscar(id)) {
      const cid = db.posts.comentar({ post_id: id, usuario_id: req.usuario.id, texto: txt });
      gamificacao.premiar(req.usuario.id, 'comentou', String(cid));
    }
    res.redirect(req.body.voltar || `/p/${id}`);
  });

  router.post('/comentario/:id/remover', auth.exigirLogin, (req, res) => {
    const id = idDe(req.params.id);
    const c = id ? db.posts.buscarComentario(id) : null;
    const p = c ? db.posts.buscar(c.post_id) : null;
    if (c && (c.usuario_id === req.usuario.id || (p && p.usuario_id === req.usuario.id))) db.posts.removerComentario(id);
    res.redirect(req.body.voltar || '/feed');
  });

  router.post('/post/:id/denunciar', auth.exigirLogin, (req, res) => {
    const id = idDe(req.params.id);
    if (id && db.posts.buscar(id)) {
      db.denuncias.criar({ post_id: id, autor_id: req.usuario.id, motivo: texto(req.body.motivo, 300) });
      res.locals.setFlash('ok', 'Denúncia enviada. A moderação vai analisar.');
    }
    res.redirect('/feed');
  });

  router.post('/post/:id/remover', auth.exigirLogin, (req, res) => {
    const id = idDe(req.params.id);
    const p = id ? db.posts.buscar(id) : null;
    if (p && p.usuario_id === req.usuario.id) {
      db.posts.remover(id);
      for (const m of p.midias) uploads.apagarMidia(m.arquivo);
    }
    res.redirect(req.body.voltar || '/feed');
  });

  // ----- diretório -----
  router.get('/diretorio', (req, res) => {
    const filtro = {
      apenasVerificados: true,
      tipo: ['pessoa', 'empresa'].includes(req.query.tipo) ? req.query.tipo : '',
      cidade: texto(req.query.cidade, 120),
      categoria: CATEGORIAS_EMPRESA.includes(req.query.categoria) ? req.query.categoria : '',
      busca: texto(req.query.q, 120),
    };
    res.render('rede/diretorio', { titulo: 'Diretório', membros: db.usuarios.listar(filtro), filtro, categoriasEmpresa: CATEGORIAS_EMPRESA });
  });

  router.get('/u/:id', (req, res, next) => {
    const id = idDe(req.params.id);
    const perfil = id ? db.usuarios.perfilPublico(id) : null;
    if (!perfil || perfil.banido) return next();
    const souEu = req.usuario && req.usuario.id === perfil.id;
    const verificadoVendo = req.usuario && req.usuario.status_verificacao === 'verificado';
    // Perfis não verificados só aparecem para o próprio dono e para membros verificados.
    if (perfil.status_verificacao !== 'verificado' && !souEu && !verificadoVendo) return next();
    const mostrarContato = souEu || verificadoVendo;
    res.render('rede/perfil', {
      titulo: perfil.nome,
      perfil: mostrarContato ? perfil : { ...perfil, whatsapp: '' },
      mostrarContato,
      souEu,
      jogo: gamificacao.resumo(perfil.id),
      avaliacoes: perfil.tipo === 'empresa' ? db.avaliacoes.daEmpresa(perfil.id) : [],
      vagas: perfil.tipo === 'empresa' ? db.vagas.listar({ empresa_id: perfil.id }) : [],
      posts: db.posts.listar({ autorId: perfil.id, usuarioId: req.usuario ? req.usuario.id : null, limite: 12 }),
      negocioPendente: req.usuario && perfil.tipo === 'empresa' && !souEu ? db.negocios.pendentesHoje(req.usuario.id, perfil.id) > 0 : false,
    });
  });

  router.post('/u/:id/avaliar', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const alvo = id ? db.usuarios.buscar(id) : null;
    if (!alvo || alvo.tipo !== 'empresa' || alvo.id === req.usuario.id) { res.locals.setFlash('erro', 'Não dá para avaliar esse perfil.'); return res.redirect('/diretorio'); }
    db.avaliacoes.salvar({ empresa_id: id, autor_id: req.usuario.id, nota: req.body.nota, texto: texto(req.body.texto, 600) });
    gamificacao.premiar(req.usuario.id, 'avaliou', String(id));
    gamificacao.premiar(id, 'foi_avaliado', String(req.usuario.id));
    res.locals.setFlash('ok', 'Avaliação salva. Obrigado!');
    res.redirect(`/u/${id}`);
  });

  router.post('/u/:id/denunciar', auth.exigirLogin, (req, res) => {
    const id = idDe(req.params.id);
    if (id && id !== req.usuario.id && db.usuarios.buscar(id)) {
      db.denuncias.criar({ usuario_alvo_id: id, autor_id: req.usuario.id, motivo: texto(req.body.motivo, 300) });
      res.locals.setFlash('ok', 'Denúncia enviada. A moderação vai analisar.');
    }
    res.redirect(id ? `/u/${id}` : '/diretorio');
  });

  // ----- negócios entre membros (o coração do incentivo ao comércio) -----
  router.post('/u/:id/negocio', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const empresa = id ? db.usuarios.buscar(id) : null;
    if (!empresa || empresa.tipo !== 'empresa' || empresa.id === req.usuario.id || empresa.status_verificacao !== 'verificado') {
      res.locals.setFlash('erro', 'Só dá para registrar negócio com empresas verificadas.');
      return res.redirect('/diretorio');
    }
    if (db.negocios.pendentesHoje(req.usuario.id, id) > 0) {
      res.locals.setFlash('erro', 'Você já tem um negócio aguardando confirmação dessa empresa.');
      return res.redirect(`/u/${id}`);
    }
    db.negocios.criar({ empresa_id: id, cliente_id: req.usuario.id, descricao: texto(req.body.descricao, 300) });
    res.locals.setFlash('ok', `Registrado! Quando ${empresa.nome} confirmar, vocês dois ganham pontos.`);
    res.redirect(`/u/${id}`);
  });

  router.get('/negocios', auth.exigirLogin, (req, res) => {
    res.render('rede/negocios', {
      titulo: 'Negócios na rede',
      comoEmpresa: req.usuario.tipo === 'empresa' ? db.negocios.daEmpresa(req.usuario.id) : [],
      comoCliente: db.negocios.doCliente(req.usuario.id),
      jogo: gamificacao.resumo(req.usuario.id),
      historico: db.pontos.historico(req.usuario.id),
      acoes: gamificacao.ACOES,
    });
  });

  router.post('/negocios/:id/decidir', auth.exigirEmpresa, (req, res) => {
    const id = idDe(req.params.id);
    const n = id ? db.negocios.buscar(id) : null;
    if (!n || n.empresa_id !== req.usuario.id || n.status !== 'pendente') return res.redirect('/negocios');
    const confirmado = req.body.decisao === 'confirmar';
    db.negocios.decidir(id, confirmado);
    if (confirmado) {
      gamificacao.premiar(n.cliente_id, 'negocio_cliente', String(id));
      gamificacao.premiar(n.empresa_id, 'negocio_empresa', String(id));
      res.locals.setFlash('ok', `Negócio confirmado! Você e ${n.cliente_nome} ganharam pontos.`);
    } else {
      res.locals.setFlash('ok', 'Negócio recusado.');
    }
    res.redirect('/negocios');
  });

  // ----- meu perfil -----
  router.get('/perfil', auth.exigirLogin, (req, res) => {
    res.render('rede/perfil-editar', { titulo: 'Meu perfil', valores: req.usuario, erros: [], categoriasEmpresa: CATEGORIAS_EMPRESA, jogo: gamificacao.resumo(req.usuario.id) });
  });

  router.post('/perfil', auth.exigirLogin, (req, res) => {
    const b = req.body;
    const valores = {
      nome: texto(b.nome, 120),
      cidade: texto(b.cidade, 120),
      estado: texto(b.estado, 2).toUpperCase(),
      bio: texto(b.bio, 1000),
      instagram: instagramLimpo(b.instagram),
      whatsapp: texto(b.whatsapp, 40).replace(/\D/g, ''),
      site: texto(b.site, 200),
      categoria: req.usuario.tipo === 'empresa' && CATEGORIAS_EMPRESA.includes(b.categoria) ? b.categoria : req.usuario.categoria,
    };
    const erros = [];
    if (!valores.nome) erros.push('O nome é obrigatório.');
    if (!valores.cidade) erros.push('A cidade é obrigatória.');
    if (erros.length) return res.status(422).render('rede/perfil-editar', { titulo: 'Meu perfil', valores: { ...req.usuario, ...valores }, erros, categoriasEmpresa: CATEGORIAS_EMPRESA, jogo: gamificacao.resumo(req.usuario.id) });
    db.usuarios.atualizarPerfil(req.usuario.id, valores);
    if (b.nova_senha) {
      if (String(b.nova_senha).length < 8) { res.locals.setFlash('erro', 'Perfil salvo, mas a senha nova precisa ter 8+ caracteres.'); return res.redirect('/perfil'); }
      db.usuarios.mudarSenha(req.usuario.id, String(b.nova_senha));
    }
    gamificacao.checarPerfilCompleto(req.usuario);
    res.locals.setFlash('ok', 'Perfil atualizado.');
    res.redirect('/perfil');
  });

  router.post('/perfil/foto', auth.exigirLogin, (req, res) => {
    uploads.foto(req, res, (err) => {
      const msg = uploads.mensagemErro(err);
      if (err && !msg) return res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Não foi possível salvar a foto.' });
      if (msg) { res.locals.setFlash('erro', msg); return res.redirect('/perfil'); }
      if (!req.file) { res.locals.setFlash('erro', 'Escolha uma imagem.'); return res.redirect('/perfil'); }
      const antiga = req.usuario.foto;
      db.usuarios.atualizarFoto(req.usuario.id, req.file.filename);
      if (antiga) uploads.apagarFoto(antiga);
      gamificacao.checarPerfilCompleto(req.usuario);
      res.locals.setFlash('ok', 'Foto atualizada.');
      res.redirect('/perfil');
    });
  });

  // ----- verificação (redes sociais e/ou fotos) -----
  function paginaVerificacao(req, res, erros = [], status = 200) {
    res.status(status).render('rede/verificacao', {
      titulo: 'Selo ' + res.locals.config.nome_selo,
      ultima: db.verificacoes.ultimaDoUsuario(req.usuario.id),
      convidante: req.usuario.convidado_por ? db.usuarios.buscar(req.usuario.convidado_por) : null,
      erros,
    });
  }

  router.get('/verificacao', auth.exigirLogin, (req, res) => paginaVerificacao(req, res));

  router.post('/verificacao', auth.exigirLogin, (req, res) => {
    if (req.usuario.status_verificacao === 'verificado') return res.redirect('/feed');
    if (req.usuario.status_verificacao === 'em_analise') { res.locals.setFlash('erro', 'Sua verificação já está em análise.'); return res.redirect('/verificacao'); }
    uploads.verificacao(req, res, async (err) => {
      const msg = uploads.mensagemErro(err);
      if (err && !msg) return res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Não foi possível receber as imagens.' });
      const fotos = (req.files || []).map((f) => f.filename);
      const instagram = instagramLimpo(req.body.instagram);
      const outras = ['facebook', 'tiktok', 'x', 'youtube'].map((k) => ({ k, v: redeLimpa(req.body[k]) })).filter((r) => r.v);
      const outras_redes = outras.map((r) => `${r.k}: ${r.v}`).join('\n');
      const erros = [];
      if (msg) erros.push(msg);
      if (!instagram && !outras.length && !fotos.length) erros.push('Informe pelo menos uma rede social ou envie uma foto.');
      if (erros.length) {
        for (const f of fotos) uploads.apagarPrivado(f);
        return paginaVerificacao(req, res, erros, 422);
      }
      const id = db.verificacoes.criar({ usuario_id: req.usuario.id, instagram, outras_redes, fotos, observacao: texto(req.body.observacao, 500) });
      // Triagem por IA em segundo plano: só sugere, quem decide é a moderação.
      if (ia && ia.ativo) {
        ia.analisarVerificacaoEAplicar(db, uploads, id).catch((e) => console.error(`IA: erro na verificação ${id}:`, e.message));
      }
      res.locals.setFlash('ok', 'Enviado! A moderação analisa em breve. Enquanto isso você já pode navegar pelo diretório.');
      res.redirect('/verificacao');
    });
  });

  // ----- currículo e talentos -----
  router.get('/curriculo', auth.exigirLogin, (req, res) => {
    res.render('rede/curriculo', { titulo: 'Meu currículo', valores: req.usuario, erros: [] });
  });

  router.post('/curriculo', auth.exigirLogin, (req, res) => {
    const valores = {
      procura_emprego: req.body.procura_emprego === '1',
      profissao: texto(req.body.profissao, 120),
      curriculo: texto(req.body.curriculo, 4000),
    };
    const erros = [];
    if (valores.procura_emprego && !valores.profissao) erros.push('Diga sua profissão ou área para aparecer em Talentos.');
    if (erros.length) return res.status(422).render('rede/curriculo', { titulo: 'Meu currículo', valores: { ...req.usuario, ...valores }, erros });
    db.usuarios.atualizarCurriculo(req.usuario.id, valores);
    if (valores.profissao && valores.curriculo) gamificacao.premiar(req.usuario.id, 'curriculo', 'curriculo');
    res.locals.setFlash('ok', valores.procura_emprego ? 'Currículo salvo. Você já aparece em Talentos para as empresas da rede.' : 'Currículo salvo.');
    res.redirect('/curriculo');
  });

  router.post('/curriculo/arquivo', auth.exigirLogin, (req, res) => {
    uploads.curriculo(req, res, (err) => {
      const msg = uploads.mensagemErro(err);
      if (err && !msg) return res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Não foi possível salvar o PDF.' });
      if (msg) { res.locals.setFlash('erro', msg); return res.redirect('/curriculo'); }
      if (!req.file) { res.locals.setFlash('erro', 'Escolha um PDF.'); return res.redirect('/curriculo'); }
      const antigo = req.usuario.curriculo_arquivo;
      db.usuarios.atualizarCurriculoArquivo(req.usuario.id, req.file.filename);
      if (antigo) uploads.apagarCurriculo(antigo);
      res.locals.setFlash('ok', 'PDF do currículo enviado.');
      res.redirect('/curriculo');
    });
  });

  router.post('/curriculo/arquivo/remover', auth.exigirLogin, (req, res) => {
    if (req.usuario.curriculo_arquivo) {
      uploads.apagarCurriculo(req.usuario.curriculo_arquivo);
      db.usuarios.atualizarCurriculoArquivo(req.usuario.id, '');
    }
    res.redirect('/curriculo');
  });

  // PDF do currículo: só membros com selo veem.
  router.get('/u/:id/curriculo', auth.exigirVerificado, (req, res, next) => {
    const id = idDe(req.params.id);
    const u = id ? db.usuarios.buscar(id) : null;
    if (!u || !u.curriculo_arquivo || u.banido) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(uploads.caminhoCurriculo(u.curriculo_arquivo), { headers: { 'Content-Disposition': `inline; filename="curriculo-${id}.pdf"` } }, (err) => { if (err) next(); });
  });

  router.get('/talentos', (req, res) => {
    const filtro = { cidade: texto(req.query.cidade, 120), busca: texto(req.query.q, 120) };
    res.render('rede/talentos', { titulo: 'Talentos', talentos: db.usuarios.talentos(filtro), filtro });
  });

  // ----- convites -----
  router.get('/convites', auth.exigirLogin, (req, res) => {
    res.render('rede/convites', { titulo: 'Meus convites', convites: db.convites.doUsuario(req.usuario.id) });
  });

  router.post('/convites', auth.exigirVerificado, (req, res) => {
    try {
      db.convites.gerar(req.usuario.id);
      res.locals.setFlash('ok', 'Convite gerado. Mande o link para quem você confia: a pessoa já entra com o selo.');
    } catch (e) {
      res.locals.setFlash('erro', e.message);
    }
    res.redirect('/convites');
  });

  // ----- vagas -----
  router.get('/vagas', (req, res) => {
    const cidade = texto(req.query.cidade, 120);
    res.render('rede/vagas', { titulo: 'Vagas', vagas: db.vagas.listar({ cidade }), cidadeFiltro: cidade });
  });

  // Qualquer membro com selo pode publicar vaga (empresa ou pessoa contratando).
  router.get('/vagas/nova', auth.exigirVerificado, (req, res) => {
    res.render('rede/vaga-nova', { titulo: 'Publicar vaga', valores: { cidade: req.usuario.cidade, tipo: 'CLT' }, erros: [], tiposVaga: TIPOS_VAGA });
  });

  router.post('/vagas/nova', auth.exigirVerificado, (req, res) => {
    const valores = { titulo: texto(req.body.titulo, 120), descricao: texto(req.body.descricao, 3000), cidade: texto(req.body.cidade, 120), tipo: texto(req.body.tipo, 20) };
    const erros = [];
    if (!valores.titulo) erros.push('Dê um título à vaga.');
    if (!valores.descricao) erros.push('Descreva a vaga.');
    if (erros.length) return res.status(422).render('rede/vaga-nova', { titulo: 'Publicar vaga', valores, erros, tiposVaga: TIPOS_VAGA });
    const id = db.vagas.criar({ ...valores, empresa_id: req.usuario.id });
    gamificacao.premiar(req.usuario.id, 'vaga', String(id));
    res.locals.setFlash('ok', 'Vaga publicada.');
    res.redirect(`/vagas/${id}`);
  });

  router.get('/vagas/:id', (req, res, next) => {
    const id = idDe(req.params.id);
    const vaga = id ? db.vagas.buscar(id) : null;
    if (!vaga) return next();
    const dona = req.usuario && req.usuario.id === vaga.empresa_id;
    res.render('rede/vaga', {
      titulo: vaga.titulo,
      vaga,
      dona,
      candidaturas: dona ? db.vagas.candidaturas(id) : [],
      jaCandidatou: req.usuario ? db.vagas.jaCandidatou(id, req.usuario.id) : false,
    });
  });

  router.post('/vagas/:id/candidatar', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const vaga = id ? db.vagas.buscar(id) : null;
    if (!vaga || !vaga.aberta) { res.locals.setFlash('erro', 'Essa vaga não está mais aberta.'); return res.redirect('/vagas'); }
    if (vaga.empresa_id === req.usuario.id) return res.redirect(`/vagas/${id}`);
    db.vagas.candidatar({ vaga_id: id, usuario_id: req.usuario.id, mensagem: texto(req.body.mensagem, 1000) });
    gamificacao.premiar(req.usuario.id, 'candidatura', String(id));
    res.locals.setFlash('ok', 'Candidatura enviada! A empresa vê seu perfil e contato.');
    res.redirect(`/vagas/${id}`);
  });

  router.post('/vagas/:id/fechar', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const vaga = id ? db.vagas.buscar(id) : null;
    if (vaga && vaga.empresa_id === req.usuario.id) db.vagas.fechar(id, req.body.aberta === '1');
    res.redirect(`/vagas/${id}`);
  });

  return router;
};
