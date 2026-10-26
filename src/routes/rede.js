'use strict';

const express = require('express');
const { CATEGORIAS_EMPRESA, TIPOS_VAGA } = require('../db-rede');

function texto(v, max = 500) { return String(v ?? '').replace(/\r/g, '').trim().slice(0, max); }
function idDe(v) { const n = Number.parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; }
function instagramLimpo(v) { return texto(v, 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, ''); }

module.exports = function criarRotasRede(db, { auth, uploads, ia }) {
  const router = express.Router();

  // ----- início -----
  router.get('/', (req, res) => {
    const stats = db.usuarios.contar();
    const destaques = db.usuarios.listar({ apenasVerificados: true, tipo: 'empresa', limite: 6 });
    const vagas = db.vagas.listar().slice(0, 4);
    res.render('rede/index', { titulo: null, stats, destaques, vagas });
  });

  router.get('/sobre', (req, res) => res.render('rede/sobre', { titulo: 'Como funciona' }));
  router.get('/termos', (req, res) => res.render('rede/termos', { titulo: 'Termos e privacidade' }));

  // ----- feed -----
  router.get('/feed', auth.exigirLogin, (req, res) => {
    const cidade = texto(req.query.cidade, 120);
    res.render('rede/feed', {
      titulo: 'Feed',
      posts: db.posts.listar({ cidade }),
      cidadeFiltro: cidade,
      stats: db.usuarios.contar(),
    });
  });

  router.post('/post', auth.exigirVerificado, (req, res) => {
    const txt = texto(req.body.texto, 2000);
    if (txt.length < 2) { res.locals.setFlash('erro', 'Escreva alguma coisa.'); return res.redirect('/feed'); }
    db.posts.criar({ usuario_id: req.usuario.id, texto: txt, cidade: req.usuario.cidade });
    res.redirect('/feed');
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
    if (p && p.usuario_id === req.usuario.id) db.posts.remover(id);
    res.redirect('/feed');
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
      avaliacoes: perfil.tipo === 'empresa' ? db.avaliacoes.daEmpresa(perfil.id) : [],
      vagas: perfil.tipo === 'empresa' ? db.vagas.listar({ empresa_id: perfil.id }) : [],
      posts: db.posts.listar({ limite: 10 }).filter((p) => p.usuario_id === perfil.id),
    });
  });

  router.post('/u/:id/avaliar', auth.exigirVerificado, (req, res) => {
    const id = idDe(req.params.id);
    const alvo = id ? db.usuarios.buscar(id) : null;
    if (!alvo || alvo.tipo !== 'empresa' || alvo.id === req.usuario.id) { res.locals.setFlash('erro', 'Não dá para avaliar esse perfil.'); return res.redirect('/diretorio'); }
    db.avaliacoes.salvar({ empresa_id: id, autor_id: req.usuario.id, nota: req.body.nota, texto: texto(req.body.texto, 600) });
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

  // ----- meu perfil -----
  router.get('/perfil', auth.exigirLogin, (req, res) => {
    res.render('rede/perfil-editar', { titulo: 'Meu perfil', valores: req.usuario, erros: [], categoriasEmpresa: CATEGORIAS_EMPRESA });
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
    if (erros.length) return res.status(422).render('rede/perfil-editar', { titulo: 'Meu perfil', valores: { ...req.usuario, ...valores }, erros, categoriasEmpresa: CATEGORIAS_EMPRESA });
    db.usuarios.atualizarPerfil(req.usuario.id, valores);
    if (b.nova_senha) {
      if (String(b.nova_senha).length < 8) { res.locals.setFlash('erro', 'Perfil salvo, mas a senha nova precisa ter 8+ caracteres.'); return res.redirect('/perfil'); }
      db.usuarios.mudarSenha(req.usuario.id, String(b.nova_senha));
    }
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
      res.locals.setFlash('ok', 'Foto atualizada.');
      res.redirect('/perfil');
    });
  });

  // ----- verificação -----
  router.get('/verificacao', auth.exigirLogin, (req, res) => {
    res.render('rede/verificacao', {
      titulo: 'Verificação',
      ultima: db.verificacoes.ultimaDoUsuario(req.usuario.id),
      convidante: req.usuario.convidado_por ? db.usuarios.buscar(req.usuario.convidado_por) : null,
      erros: [],
    });
  });

  router.post('/verificacao', auth.exigirLogin, (req, res) => {
    if (req.usuario.status_verificacao === 'verificado') return res.redirect('/feed');
    if (req.usuario.status_verificacao === 'em_analise') { res.locals.setFlash('erro', 'Sua verificação já está em análise.'); return res.redirect('/verificacao'); }
    uploads.verificacao(req, res, async (err) => {
      const msg = uploads.mensagemErro(err);
      if (err && !msg) return res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Não foi possível receber as imagens.' });
      const selfie = req.files && req.files.selfie && req.files.selfie[0];
      const documento = req.files && req.files.documento && req.files.documento[0];
      const instagram = instagramLimpo(req.body.instagram);
      const erros = [];
      if (msg) erros.push(msg);
      if (!selfie) erros.push('Envie uma selfie segurando o documento.');
      if (!documento) erros.push('Envie a foto do documento (RG ou CNH).');
      if (!instagram && !req.usuario.convidado_por) erros.push('Informe seu Instagram (ou entre por convite).');
      if (erros.length) {
        if (selfie) uploads.apagarPrivado(selfie.filename);
        if (documento) uploads.apagarPrivado(documento.filename);
        return res.status(422).render('rede/verificacao', {
          titulo: 'Verificação',
          ultima: db.verificacoes.ultimaDoUsuario(req.usuario.id),
          convidante: req.usuario.convidado_por ? db.usuarios.buscar(req.usuario.convidado_por) : null,
          erros,
        });
      }
      const id = db.verificacoes.criar({
        usuario_id: req.usuario.id,
        selfie: selfie.filename,
        documento: documento.filename,
        instagram,
        observacao: texto(req.body.observacao, 500),
      });
      // Triagem por IA em segundo plano: só sugere, quem decide é a moderação.
      if (ia && ia.ativo) {
        ia.analisarVerificacaoEAplicar(db, uploads, id).catch((e) => console.error(`IA: erro na verificação ${id}:`, e.message));
      }
      res.locals.setFlash('ok', 'Verificação enviada! A moderação analisa em breve. Você já pode navegar pelo diretório enquanto isso.');
      res.redirect('/verificacao');
    });
  });

  // ----- convites -----
  router.get('/convites', auth.exigirLogin, (req, res) => {
    res.render('rede/convites', { titulo: 'Meus convites', convites: db.convites.doUsuario(req.usuario.id) });
  });

  router.post('/convites', auth.exigirVerificado, (req, res) => {
    try {
      db.convites.gerar(req.usuario.id);
      res.locals.setFlash('ok', 'Convite gerado. Mande o link para quem você confia.');
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

  router.get('/vagas/nova', auth.exigirEmpresa, (req, res) => {
    res.render('rede/vaga-nova', { titulo: 'Publicar vaga', valores: { cidade: req.usuario.cidade, tipo: 'CLT' }, erros: [], tiposVaga: TIPOS_VAGA });
  });

  router.post('/vagas/nova', auth.exigirEmpresa, (req, res) => {
    const valores = { titulo: texto(req.body.titulo, 120), descricao: texto(req.body.descricao, 3000), cidade: texto(req.body.cidade, 120), tipo: texto(req.body.tipo, 20) };
    const erros = [];
    if (!valores.titulo) erros.push('Dê um título à vaga.');
    if (!valores.descricao) erros.push('Descreva a vaga.');
    if (erros.length) return res.status(422).render('rede/vaga-nova', { titulo: 'Publicar vaga', valores, erros, tiposVaga: TIPOS_VAGA });
    const id = db.vagas.criar({ ...valores, empresa_id: req.usuario.id });
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
    res.locals.setFlash('ok', 'Candidatura enviada! A empresa vê seu perfil e contato.');
    res.redirect(`/vagas/${id}`);
  });

  router.post('/vagas/:id/fechar', auth.exigirEmpresa, (req, res) => {
    const id = idDe(req.params.id);
    const vaga = id ? db.vagas.buscar(id) : null;
    if (vaga && vaga.empresa_id === req.usuario.id) db.vagas.fechar(id, req.body.aberta === '1');
    res.redirect(`/vagas/${id}`);
  });

  return router;
};
