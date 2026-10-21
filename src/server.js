'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { abrirBanco, CATEGORIAS } = require('./db');
const { criarIa } = require('./ia');
const criarRotasPublicas = require('./routes/publico');
const criarRotasAdmin = require('./routes/admin');

function criarApp(opcoes = {}) {
  const db = opcoes.db || abrirBanco(opcoes.caminhoBanco);
  const ia = opcoes.ia || criarIa();
  const adminSenha = opcoes.adminSenha ?? process.env.ADMIN_PASSWORD ?? '';
  const segredo = opcoes.segredo ?? process.env.SESSION_SECRET ?? adminSenha ?? 'troque-este-segredo';

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.urlencoded({ extended: false, limit: '50kb' }));
  app.use(cookieParser(segredo));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));

  // Dados comuns a todas as páginas.
  app.use((req, res, next) => {
    res.locals.config = db.config.todas();
    res.locals.categorias = CATEGORIAS;
    res.locals.caminho = req.originalUrl;
    res.locals.admin = false;
    res.locals.iaAtiva = ia.ativo;
    res.locals.rotulos = ROTULOS;
    res.locals.formatarData = formatarData;
    res.locals.linkWhatsapp = linkWhatsapp;
    res.locals.flash = req.signedCookies.flash ? safeJson(req.signedCookies.flash) : null;
    if (res.locals.flash) res.clearCookie('flash');
    res.locals.setFlash = (tipo, mensagem) => {
      res.cookie('flash', JSON.stringify({ tipo, mensagem }), { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    };
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/', criarRotasPublicas(db, ia));
  app.use('/admin', criarRotasAdmin(db, { senha: adminSenha, segredo, ia }));

  app.use((req, res) => {
    res.status(404).render('erro', { titulo: 'Página não encontrada', mensagem: 'Essa página não existe.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).render('erro', { titulo: 'Deu algo errado', mensagem: 'Tenta de novo daqui a pouco.' });
  });

  app.locals.db = db;
  return app;
}

function safeJson(texto) {
  try { return JSON.parse(texto); } catch { return null; }
}

const ROTULOS = {
  necessidade: { aberta: 'Ainda precisa', recebida: 'Já recebeu' },
  oferta: {
    nova: 'Nova',
    aceita: 'Vai para ela',
    disponivel: 'Disponível para repasse',
    repassada: 'Repassada',
    concluida: 'Concluída',
    cancelada: 'Cancelada',
  },
  pedido: { aberto: 'Aguardando', atendido: 'Atendido', cancelado: 'Cancelado' },
};

function formatarData(texto) {
  if (!texto) return '';
  const d = new Date(texto.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return texto;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Sao_Paulo' });
}

function linkWhatsapp(numero, mensagem) {
  const digitos = String(numero || '').replace(/\D/g, '');
  if (!digitos) return '';
  const completo = digitos.length <= 11 ? '55' + digitos : digitos;
  const texto = mensagem ? '?text=' + encodeURIComponent(mensagem) : '';
  return `https://wa.me/${completo}${texto}`;
}

if (require.main === module) {
  const porta = Number(process.env.PORT || 3000);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('AVISO: ADMIN_PASSWORD não definida. O painel /admin ficará bloqueado até você definir essa variável.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('AVISO: ANTHROPIC_API_KEY não definida. As sugestões de repasse por IA ficarão desativadas.');
  }
  const app = criarApp();
  app.listen(porta, () => {
    console.log(`Corrente do Bem rodando em http://localhost:${porta}`);
  });
}

module.exports = { criarApp };
