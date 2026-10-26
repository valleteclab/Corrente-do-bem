'use strict';

const express = require('express');
const { CATEGORIAS_EMPRESA } = require('../db-rede');

function texto(v, max = 500) { return String(v ?? '').replace(/\r/g, '').trim().slice(0, max); }
function emailValido(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function instagramLimpo(v) { return texto(v, 60).replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/.*$/, ''); }
function destinoSeguro(v) { const s = String(v || ''); return s.startsWith('/') && !s.startsWith('//') ? s : '/feed'; }

module.exports = function criarRotasAuth(db, auth) {
  const router = express.Router();

  // Limita tentativas de login por IP.
  const tentativas = new Map();
  function registrarTentativa(ip) {
    const agora = Date.now();
    const lista = (tentativas.get(ip) || []).filter((t) => agora - t < 15 * 60_000);
    lista.push(agora);
    tentativas.set(ip, lista);
    return lista.length;
  }

  router.get('/entrar', (req, res) => {
    if (req.usuario) return res.redirect('/feed');
    res.render('rede/entrar', { titulo: 'Entrar', voltar: destinoSeguro(req.query.voltar), erro: null, email: '' });
  });

  router.post('/entrar', (req, res) => {
    const email = texto(req.body.email, 160).toLowerCase();
    const voltar = destinoSeguro(req.body.voltar);
    if (registrarTentativa(req.ip) > 20) {
      return res.status(429).render('rede/entrar', { titulo: 'Entrar', voltar, erro: 'Muitas tentativas. Espere alguns minutos.', email });
    }
    const u = db.usuarios.autenticar(email, req.body.senha || '');
    if (!u) return res.status(401).render('rede/entrar', { titulo: 'Entrar', voltar, erro: 'E-mail ou senha incorretos.', email });
    if (u.banido) return res.status(403).render('rede/entrar', { titulo: 'Entrar', voltar, erro: 'Esta conta foi suspensa.', email });
    auth.entrar(res, u.id);
    res.redirect(voltar);
  });

  router.post('/sair', (req, res) => {
    auth.sair(res);
    res.redirect('/');
  });

  router.get('/cadastrar', (req, res) => {
    if (req.usuario) return res.redirect('/feed');
    const codigo = texto(req.query.convite, 20).toUpperCase();
    const convite = codigo ? db.convites.buscarValido(codigo) : null;
    res.render('rede/cadastrar', {
      titulo: 'Criar conta',
      valores: { tipo: 'pessoa', convite: codigo },
      convite,
      erros: codigo && !convite ? ['Esse código de convite não é válido ou já foi usado. Você ainda pode se cadastrar e passar pela verificação.'] : [],
      categoriasEmpresa: CATEGORIAS_EMPRESA,
    });
  });

  router.post('/cadastrar', (req, res) => {
    const b = req.body;
    const valores = {
      tipo: b.tipo === 'empresa' ? 'empresa' : 'pessoa',
      nome: texto(b.nome, 120),
      email: texto(b.email, 160).toLowerCase(),
      cidade: texto(b.cidade, 120),
      estado: texto(b.estado, 2).toUpperCase(),
      whatsapp: texto(b.whatsapp, 40).replace(/\D/g, ''),
      instagram: instagramLimpo(b.instagram),
      categoria: CATEGORIAS_EMPRESA.includes(b.categoria) ? b.categoria : '',
      convite: texto(b.convite, 20).toUpperCase(),
    };
    const senha = String(b.senha || '');
    const erros = [];
    if (texto(b.site)) return res.redirect('/');
    if (db.config.todas().cadastro_aberto !== '1' && !valores.convite) erros.push('No momento o cadastro é só por convite.');
    if (!valores.nome) erros.push('Diz seu nome (ou o nome da empresa).');
    if (!emailValido(valores.email)) erros.push('Informe um e-mail válido.');
    if (senha.length < 8) erros.push('A senha precisa ter pelo menos 8 caracteres.');
    if (!valores.cidade) erros.push('Informe sua cidade.');
    if (b.consentimento !== '1') erros.push('Você precisa aceitar os termos e a política de privacidade.');
    if (valores.tipo === 'empresa' && !valores.categoria) erros.push('Escolha a categoria da empresa.');

    let convite = null;
    if (valores.convite) {
      convite = db.convites.buscarValido(valores.convite);
      if (!convite) erros.push('Código de convite inválido ou já usado.');
    }
    if (!erros.length && db.usuarios.buscarPorEmail(valores.email)) erros.push('Já existe uma conta com esse e-mail. Tente entrar.');

    if (erros.length) {
      return res.status(422).render('rede/cadastrar', { titulo: 'Criar conta', valores, convite, erros, categoriasEmpresa: CATEGORIAS_EMPRESA });
    }

    const id = db.usuarios.criar({ ...valores, senha, convidado_por: convite ? convite.criado_por : null });
    if (convite) db.convites.usar(convite.codigo, id);
    auth.entrar(res, id);
    res.locals.setFlash('ok', convite
      ? `Bem-vindo(a)! Você entrou por convite de ${convite.convidante_nome}. Complete a verificação para liberar tudo.`
      : 'Conta criada! Agora complete a verificação para ter o selo de membro.');
    res.redirect('/verificacao');
  });

  return router;
};
