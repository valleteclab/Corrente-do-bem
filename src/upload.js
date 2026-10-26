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
const TIPOS_VIDEO = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov' };
const TIPOS_PDF = { 'application/pdf': '.pdf' };
const TAMANHO_MAX = 6 * 1024 * 1024;
const TAMANHO_MAX_VIDEO = 80 * 1024 * 1024;
const TAMANHO_MAX_PDF = 5 * 1024 * 1024;

function dirDados() {
  const banco = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'corrente.db');
  return banco === ':memory:' ? path.join(__dirname, '..', 'data') : path.dirname(banco);
}

function criarUploads(raiz = dirDados()) {
  const dirFotos = path.join(raiz, 'uploads', 'fotos');
  const dirPrivado = path.join(raiz, 'uploads', 'verificacao');
  const dirPosts = path.join(raiz, 'uploads', 'posts');
  const dirCurriculos = path.join(raiz, 'uploads', 'curriculos');
  for (const d of [dirFotos, dirPrivado, dirPosts, dirCurriculos]) fs.mkdirSync(d, { recursive: true });

  const nomeArquivo = (tabela) => (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${tabela[file.mimetype]}`);
  const filtroDe = (tabela, mensagem) => (req, file, cb) => {
    if (!tabela[file.mimetype]) return cb(new Error(mensagem));
    cb(null, true);
  };
  const filtro = filtroDe(TIPOS, 'Envie uma imagem JPG, PNG ou WebP.');
  const TIPOS_MIDIA = { ...TIPOS, ...TIPOS_VIDEO };

  const fotos = multer({ storage: multer.diskStorage({ destination: dirFotos, filename: nomeArquivo(TIPOS) }), fileFilter: filtro, limits: { fileSize: TAMANHO_MAX, files: 1 } });
  const privado = multer({ storage: multer.diskStorage({ destination: dirPrivado, filename: nomeArquivo(TIPOS) }), fileFilter: filtro, limits: { fileSize: TAMANHO_MAX, files: 3 } });
  const midias = multer({
    storage: multer.diskStorage({ destination: dirPosts, filename: nomeArquivo(TIPOS_MIDIA) }),
    fileFilter: filtroDe(TIPOS_MIDIA, 'Envie fotos (JPG, PNG, WebP) ou um vídeo (MP4, WebM, MOV).'),
    limits: { fileSize: TAMANHO_MAX_VIDEO, files: 4 },
  });
  const curriculos = multer({
    storage: multer.diskStorage({ destination: dirCurriculos, filename: nomeArquivo(TIPOS_PDF) }),
    fileFilter: filtroDe(TIPOS_PDF, 'O currículo precisa ser um PDF.'),
    limits: { fileSize: TAMANHO_MAX_PDF, files: 1 },
  });

  function apagar(dir, nome) {
    if (!nome) return;
    const alvo = path.join(dir, path.basename(nome));
    fs.rm(alvo, { force: true }, () => {});
  }

  return {
    dirFotos,
    dirPrivado,
    dirPosts,
    dirCurriculos,
    foto: fotos.single('foto'),
    verificacao: privado.array('fotos', 3),
    midias: midias.array('midias', 4),
    curriculo: curriculos.single('curriculo_arquivo'),
    ehVideo: (mimetype) => Boolean(TIPOS_VIDEO[mimetype]),
    apagarFoto: (nome) => apagar(dirFotos, nome),
    apagarPrivado: (nome) => apagar(dirPrivado, nome),
    apagarMidia: (nome) => apagar(dirPosts, nome),
    apagarCurriculo: (nome) => apagar(dirCurriculos, nome),
    caminhoPrivado: (nome) => path.join(dirPrivado, path.basename(nome)),
    caminhoCurriculo: (nome) => path.join(dirCurriculos, path.basename(nome)),
    /** Converte um erro do multer em mensagem amigável; retorna null se não for erro de upload. */
    mensagemErro(err) {
      if (!err) return null;
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return 'Arquivo muito grande. Fotos até 6 MB, vídeos até 80 MB, PDF até 5 MB.';
        if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return 'Você enviou arquivos demais. Máximo: 3 fotos na verificação, 4 fotos ou 1 vídeo por post.';
        return 'Não foi possível receber o arquivo.';
      }
      if (/JPG, PNG|MP4, WebM|precisa ser um PDF/.test(err.message)) return err.message;
      return null;
    },
  };
}

module.exports = { criarUploads, TAMANHO_MAX, TAMANHO_MAX_VIDEO, TAMANHO_MAX_PDF };
