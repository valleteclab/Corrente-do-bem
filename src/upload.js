'use strict';

/**
 * Upload de imagens.
 *  - fotos de perfil: públicas, servidas em /uploads/fotos
 *  - selfie e documento da verificação: privadas, só a moderação vê, apagadas após a decisão
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const multer = require('multer');

const TIPOS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const TAMANHO_MAX = 6 * 1024 * 1024;

function dirDados() {
  const banco = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'corrente.db');
  return banco === ':memory:' ? path.join(__dirname, '..', 'data') : path.dirname(banco);
}

function criarUploads(raiz = dirDados()) {
  const dirFotos = path.join(raiz, 'uploads', 'fotos');
  const dirPrivado = path.join(raiz, 'uploads', 'verificacao');
  fs.mkdirSync(dirFotos, { recursive: true });
  fs.mkdirSync(dirPrivado, { recursive: true });

  const nomeArquivo = (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${TIPOS[file.mimetype]}`);
  const filtro = (req, file, cb) => {
    if (!TIPOS[file.mimetype]) return cb(new Error('Envie uma imagem JPG, PNG ou WebP.'));
    cb(null, true);
  };

  const fotos = multer({ storage: multer.diskStorage({ destination: dirFotos, filename: nomeArquivo }), fileFilter: filtro, limits: { fileSize: TAMANHO_MAX, files: 1 } });
  const privado = multer({ storage: multer.diskStorage({ destination: dirPrivado, filename: nomeArquivo }), fileFilter: filtro, limits: { fileSize: TAMANHO_MAX, files: 2 } });

  function apagar(dir, nome) {
    if (!nome) return;
    const alvo = path.join(dir, path.basename(nome));
    fs.rm(alvo, { force: true }, () => {});
  }

  return {
    dirFotos,
    dirPrivado,
    foto: fotos.single('foto'),
    verificacao: privado.fields([{ name: 'selfie', maxCount: 1 }, { name: 'documento', maxCount: 1 }]),
    apagarFoto: (nome) => apagar(dirFotos, nome),
    apagarPrivado: (nome) => apagar(dirPrivado, nome),
    caminhoPrivado: (nome) => path.join(dirPrivado, path.basename(nome)),
    /** Converte um erro do multer em mensagem amigável; retorna null se não for erro de upload. */
    mensagemErro(err) {
      if (!err) return null;
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return 'A imagem é muito grande. Máximo 6 MB.';
        return 'Não foi possível receber a imagem.';
      }
      if (/JPG, PNG ou WebP/.test(err.message)) return err.message;
      return null;
    },
  };
}

module.exports = { criarUploads, TAMANHO_MAX };
