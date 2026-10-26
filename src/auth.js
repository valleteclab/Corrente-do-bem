'use strict';

/** Sessão de membro por cookie assinado + guardas de rota. */

const COOKIE = 'membro';
const OPCOES_COOKIE = { signed: true, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60_000 };

function criarAuth(db) {
  function carregarUsuario(req, res, next) {
    const id = Number.parseInt(req.signedCookies[COOKIE], 10);
    req.usuario = null;
    if (Number.isInteger(id) && id > 0) {
      const u = db.usuarios.buscar(id);
      if (u && !u.banido) req.usuario = u;
      else res.clearCookie(COOKIE);
    }
    res.locals.usuario = req.usuario;
    next();
  }

  function entrar(res, usuarioId) {
    res.cookie(COOKIE, String(usuarioId), OPCOES_COOKIE);
  }

  function sair(res) {
    res.clearCookie(COOKIE);
  }

  function exigirLogin(req, res, next) {
    if (!req.usuario) {
      res.locals.setFlash('erro', 'Entre na sua conta para continuar.');
      return res.redirect('/entrar?voltar=' + encodeURIComponent(req.originalUrl));
    }
    next();
  }

  function exigirVerificado(req, res, next) {
    if (!req.usuario) return exigirLogin(req, res, next);
    if (req.usuario.status_verificacao !== 'verificado') {
      res.locals.setFlash('erro', 'Essa área é só para membros verificados. Complete sua verificação.');
      return res.redirect('/verificacao');
    }
    next();
  }

  function exigirEmpresa(req, res, next) {
    exigirVerificado(req, res, () => {
      if (req.usuario.tipo !== 'empresa') {
        res.locals.setFlash('erro', 'Só perfis de empresa podem fazer isso.');
        return res.redirect('/vagas');
      }
      next();
    });
  }

  return { carregarUsuario, entrar, sair, exigirLogin, exigirVerificado, exigirEmpresa, COOKIE };
}

module.exports = { criarAuth };
