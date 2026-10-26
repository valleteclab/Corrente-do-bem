'use strict';

const path = require('node:path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { abrirBanco, CATEGORIAS } = require('./db');
const { criarIa } = require('./ia');
const { criarAuth } = require('./auth');
const { criarUploads } = require('./upload');
const { criarGamificacao } = require('./gamificacao');
const criarRotasAuth = require('./routes/auth');
const criarRotasRede = require('./routes/rede');
const criarRotasCorrente = require('./routes/publico');
const criarRotasAdmin = require('./routes/admin');

function criarApp(opcoes = {}) {
  const db = opcoes.db || abrirBanco(opcoes.caminhoBanco);
  const ia = opcoes.ia || criarIa();
  const uploads = opcoes.uploads || criarUploads(opcoes.dirUploads);
  const auth = criarAuth(db);
  const gamificacao = criarGamificacao(db);
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
  app.use('/uploads/fotos', express.static(uploads.dirFotos, { maxAge: '7d', index: false, dotfiles: 'deny' }));
  app.use('/uploads/posts', express.static(uploads.dirPosts, { maxAge: '7d', index: false, dotfiles: 'deny', acceptRanges: true }));

  // Dados comuns a todas as páginas.
  app.use((req, res, next) => {
    res.locals.config = db.config.todas();
    res.locals.categorias = CATEGORIAS;
    res.locals.caminho = req.originalUrl;
    res.locals.admin = false;
    res.locals.papelPainel = '';
    res.locals.linkificar = linkificar;
    res.locals.embedsDe = embedsDe;
    res.locals.iaAtiva = ia.ativo;
    res.locals.rotulos = ROTULOS;
    res.locals.formatarData = formatarData;
    res.locals.linkWhatsapp = linkWhatsapp;
    res.locals.urlFoto = urlFoto;
    res.locals.urlMidia = (nome) => (nome ? `/uploads/posts/${encodeURIComponent(nome)}` : '');
    res.locals.urlBase = process.env.URL_BASE || `${req.protocol}://${req.get('host')}`;
    res.locals.iniciais = iniciais;
    res.locals.nivelDe = gamificacao.nivelDe;
    res.locals.flash = req.signedCookies.flash ? safeJson(req.signedCookies.flash) : null;
    if (res.locals.flash) res.clearCookie('flash');
    res.locals.setFlash = (tipo, mensagem) => {
      res.cookie('flash', JSON.stringify({ tipo, mensagem }), { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
    };
    next();
  });
  app.use(auth.carregarUsuario);

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.use('/', criarRotasAuth(db, auth, gamificacao));
  app.use('/', criarRotasRede(db, { auth, uploads, ia, gamificacao }));
  app.use('/corrente', criarRotasCorrente(db, ia));
  app.use('/admin', criarRotasAdmin(db, { senha: adminSenha, segredo, ia, uploads, gamificacao }));

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
  verificacao: { pendente: 'Sem selo', em_analise: 'Em análise', verificado: 'Com selo', rejeitado: 'Recusado' },
  tipoUsuario: { pessoa: 'Pessoa', empresa: 'Empresa' },
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

function urlFoto(nome) {
  return nome ? `/uploads/fotos/${encodeURIComponent(nome)}` : '';
}

const RE_URL = /https?:\/\/[^\s<]+/g;

function escaparHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Escapa o texto e transforma URLs em links. */
function linkificar(texto) {
  return escaparHtml(texto || '').replace(RE_URL, (url) => {
    const limpa = url.replace(/[.,;:!?)]+$/, '');
    const sobra = url.slice(limpa.length);
    return `<a href="${limpa}" target="_blank" rel="noopener nofollow">${limpa}</a>${sobra}`;
  });
}

/**
 * Links do Instagram e YouTube no texto viram embeds (o conteúdo fica no site de origem;
 * não baixamos as fotos). Retorna [{ tipo: 'instagram'|'youtube', url }].
 */
function embedsDe(texto) {
  const out = [];
  const vistos = new Set();
  for (const url of String(texto || '').match(RE_URL) || []) {
    let m = url.match(/instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([\w-]+)/i);
    if (m && !vistos.has('ig' + m[1])) { vistos.add('ig' + m[1]); out.push({ tipo: 'instagram', url: `https://www.instagram.com/p/${m[1]}/embed/` }); continue; }
    m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{6,})/i);
    if (m && !vistos.has('yt' + m[1])) { vistos.add('yt' + m[1]); out.push({ tipo: 'youtube', url: `https://www.youtube-nocookie.com/embed/${m[1]}` }); }
  }
  return out.slice(0, 2);
}

function iniciais(nome) {
  return String(nome || '?').trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

if (require.main === module) {
  const porta = Number(process.env.PORT || 3000);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('AVISO: ADMIN_PASSWORD não definida. O painel /admin ficará bloqueado até você definir essa variável.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('AVISO: ANTHROPIC_API_KEY não definida. A triagem por IA ficará desativada.');
  }
  const app = criarApp();
  app.listen(porta, () => {
    console.log(`Rodando em http://localhost:${porta}`);
  });
}

module.exports = { criarApp };
