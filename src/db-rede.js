'use strict';

/**
 * Tabelas e regras da rede (perfis, convites, verificação, feed, vagas, avaliações).
 * Usa o mesmo banco SQLite da Corrente do Bem.
 */

const crypto = require('node:crypto');

const TIPOS_USUARIO = ['pessoa', 'empresa'];
const STATUS_VERIFICACAO = ['pendente', 'em_analise', 'verificado', 'rejeitado'];
const PAPEIS = ['membro', 'moderador'];
const TIPOS_VAGA = ['CLT', 'PJ', 'Freelancer', 'Estágio', 'Temporário', 'Outro'];
const CONVITES_INICIAIS = 5;

const CATEGORIAS_EMPRESA = [
  'Alimentação e restaurantes',
  'Comércio e lojas',
  'Construção e reformas',
  'Saúde e bem-estar',
  'Beleza e estética',
  'Educação e cursos',
  'Serviços profissionais (advocacia, contabilidade...)',
  'Tecnologia',
  'Transporte e logística',
  'Agro e pecuária',
  'Indústria',
  'Imóveis',
  'Eventos e turismo',
  'Autônomo / profissional liberal',
  'Outros',
];

const SCHEMA_REDE = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo TEXT NOT NULL DEFAULT 'pessoa',
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  cidade TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  foto TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  site TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT '',
  status_verificacao TEXT NOT NULL DEFAULT 'pendente',
  convidado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  papel TEXT NOT NULL DEFAULT 'membro',
  banido INTEGER NOT NULL DEFAULT 0,
  convites_restantes INTEGER NOT NULL DEFAULT 0,
  consentimento_em TEXT,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS convites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  criado_por INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  usado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  usado_em TEXT
);

CREATE TABLE IF NOT EXISTS verificacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  selfie TEXT NOT NULL DEFAULT '',
  documento TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  observacao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'em_analise',
  analise_ia TEXT NOT NULL DEFAULT '',
  recomendacao_ia TEXT NOT NULL DEFAULT '',
  motivo_decisao TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  decidido_em TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  cidade TEXT NOT NULL DEFAULT '',
  removido INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS denuncias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  usuario_alvo_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  autor_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  motivo TEXT NOT NULL DEFAULT '',
  resolvida INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vagas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  cidade TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL DEFAULT 'CLT',
  aberta INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS candidaturas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vaga_id INTEGER NOT NULL REFERENCES vagas(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  mensagem TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (vaga_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS avaliacoes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  autor_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  nota INTEGER NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (empresa_id, autor_id)
);

CREATE INDEX IF NOT EXISTS idx_usuarios_status ON usuarios(status_verificacao);
CREATE INDEX IF NOT EXISTS idx_usuarios_cidade ON usuarios(cidade);
CREATE INDEX IF NOT EXISTS idx_posts_criado ON posts(criado_em);
CREATE INDEX IF NOT EXISTS idx_vagas_aberta ON vagas(aberta);
CREATE INDEX IF NOT EXISTS idx_verificacoes_status ON verificacoes(status);
`;

// ---------- senhas ----------
function gerarHashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(senha), sal, 64).toString('hex');
  return `scrypt$${sal}$${hash}`;
}

function conferirSenha(senha, armazenada) {
  const [alg, sal, hash] = String(armazenada || '').split('$');
  if (alg !== 'scrypt' || !sal || !hash) return false;
  const calc = crypto.scryptSync(String(senha), sal, 64);
  const esperado = Buffer.from(hash, 'hex');
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

function gerarCodigoConvite() {
  return crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 8);
}

function criarRepositorioRede(db) {
  db.exec(SCHEMA_REDE);
  const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const limpar = (l) => (l ? { ...l } : null);
  const semSenha = (u) => { if (!u) return null; const { senha_hash, ...resto } = u; return resto; };

  const COLUNAS_PUBLICAS = `u.id, u.tipo, u.nome, u.cidade, u.estado, u.bio, u.foto, u.instagram, u.site, u.categoria,
    u.status_verificacao, u.papel, u.banido, u.criado_em`;

  const usuarios = {
    criar({ tipo = 'pessoa', nome, email, senha, cidade = '', estado = '', whatsapp = '', instagram = '', categoria = '', convidado_por = null }) {
      const r = db.prepare(`INSERT INTO usuarios (tipo, nome, email, senha_hash, cidade, estado, whatsapp, instagram, categoria, convidado_por, consentimento_em)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(TIPOS_USUARIO.includes(tipo) ? tipo : 'pessoa', nome, email.toLowerCase(), gerarHashSenha(senha), cidade, estado, whatsapp, instagram, categoria, convidado_por, agora());
      return Number(r.lastInsertRowid);
    },
    buscar(id) {
      return semSenha(limpar(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id)));
    },
    buscarPorEmail(email) {
      return limpar(db.prepare('SELECT * FROM usuarios WHERE email = ?').get(String(email || '').toLowerCase()));
    },
    autenticar(email, senha) {
      const u = usuarios.buscarPorEmail(email);
      if (!u || !conferirSenha(senha, u.senha_hash)) return null;
      return semSenha(u);
    },
    atualizarPerfil(id, { nome, cidade, estado, bio, instagram, whatsapp, site, categoria }) {
      db.prepare(`UPDATE usuarios SET nome = ?, cidade = ?, estado = ?, bio = ?, instagram = ?, whatsapp = ?, site = ?, categoria = ?, atualizado_em = ? WHERE id = ?`)
        .run(nome, cidade, estado, bio, instagram, whatsapp, site, categoria, agora(), id);
    },
    atualizarFoto(id, caminho) {
      db.prepare('UPDATE usuarios SET foto = ?, atualizado_em = ? WHERE id = ?').run(caminho, agora(), id);
    },
    mudarSenha(id, senha) {
      db.prepare('UPDATE usuarios SET senha_hash = ?, atualizado_em = ? WHERE id = ?').run(gerarHashSenha(senha), agora(), id);
    },
    mudarStatusVerificacao(id, status) {
      if (!STATUS_VERIFICACAO.includes(status)) throw new Error('status inválido');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE usuarios SET status_verificacao = ?, atualizado_em = ? WHERE id = ?').run(status, agora(), id);
        if (status === 'verificado') {
          db.prepare('UPDATE usuarios SET convites_restantes = MAX(convites_restantes, ?) WHERE id = ?').run(CONVITES_INICIAIS, id);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    banir(id, banido = true) {
      db.prepare('UPDATE usuarios SET banido = ?, atualizado_em = ? WHERE id = ?').run(banido ? 1 : 0, agora(), id);
    },
    mudarPapel(id, papel) {
      if (!PAPEIS.includes(papel)) throw new Error('papel inválido');
      db.prepare('UPDATE usuarios SET papel = ?, atualizado_em = ? WHERE id = ?').run(papel, agora(), id);
    },
    darConvites(id, quantidade) {
      db.prepare('UPDATE usuarios SET convites_restantes = convites_restantes + ? WHERE id = ?').run(quantidade, id);
    },
    /** Lista para o painel (todos) ou diretório (só verificados). */
    listar({ status, tipo, cidade, categoria, busca, apenasVerificados = false, limite = 200 } = {}) {
      const where = ['1=1'];
      const params = [];
      if (apenasVerificados) { where.push("u.status_verificacao = 'verificado' AND u.banido = 0"); }
      if (status) { where.push('u.status_verificacao = ?'); params.push(status); }
      if (tipo) { where.push('u.tipo = ?'); params.push(tipo); }
      if (cidade) { where.push('LOWER(u.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      if (categoria) { where.push('u.categoria = ?'); params.push(categoria); }
      if (busca) { where.push('(LOWER(u.nome) LIKE ? OR LOWER(u.bio) LIKE ?)'); params.push(`%${busca.toLowerCase()}%`, `%${busca.toLowerCase()}%`); }
      const sql = `SELECT ${COLUNAS_PUBLICAS}, u.email, u.whatsapp, u.convites_restantes, u.convidado_por,
          (SELECT ROUND(AVG(nota), 1) FROM avaliacoes a WHERE a.empresa_id = u.id) AS nota_media,
          (SELECT COUNT(*) FROM avaliacoes a WHERE a.empresa_id = u.id) AS total_avaliacoes
        FROM usuarios u WHERE ${where.join(' AND ')} ORDER BY u.id DESC LIMIT ?`;
      params.push(limite);
      return db.prepare(sql).all(...params).map(limpar);
    },
    /** Perfil público: sem e-mail/senha; WhatsApp só para membros verificados (decidido na rota). */
    perfilPublico(id) {
      const u = limpar(db.prepare(`SELECT ${COLUNAS_PUBLICAS}, u.whatsapp, u.convidado_por,
          (SELECT ROUND(AVG(nota), 1) FROM avaliacoes a WHERE a.empresa_id = u.id) AS nota_media,
          (SELECT COUNT(*) FROM avaliacoes a WHERE a.empresa_id = u.id) AS total_avaliacoes
        FROM usuarios u WHERE u.id = ?`).get(id));
      if (!u) return null;
      if (u.convidado_por) {
        const c = db.prepare('SELECT id, nome FROM usuarios WHERE id = ?').get(u.convidado_por);
        u.convidante = c ? limpar(c) : null;
      }
      return u;
    },
    contar() {
      const n = (sql) => Number(db.prepare(sql).get().n);
      return {
        total: n('SELECT COUNT(*) n FROM usuarios'),
        verificados: n("SELECT COUNT(*) n FROM usuarios WHERE status_verificacao = 'verificado' AND banido = 0"),
        empresas: n("SELECT COUNT(*) n FROM usuarios WHERE tipo = 'empresa' AND status_verificacao = 'verificado' AND banido = 0"),
        pessoas: n("SELECT COUNT(*) n FROM usuarios WHERE tipo = 'pessoa' AND status_verificacao = 'verificado' AND banido = 0"),
        aguardando: n("SELECT COUNT(*) n FROM verificacoes WHERE status = 'em_analise'"),
        cidades: n("SELECT COUNT(DISTINCT LOWER(cidade)) n FROM usuarios WHERE status_verificacao = 'verificado' AND cidade <> ''"),
      };
    },
  };

  const convites = {
    gerar(usuarioId) {
      const u = db.prepare('SELECT convites_restantes, status_verificacao FROM usuarios WHERE id = ?').get(usuarioId);
      if (!u || u.status_verificacao !== 'verificado') throw new Error('Só membros verificados podem convidar.');
      if (u.convites_restantes <= 0) throw new Error('Você não tem convites disponíveis.');
      let codigo;
      for (let i = 0; i < 5; i += 1) {
        codigo = gerarCodigoConvite();
        if (!db.prepare('SELECT 1 FROM convites WHERE codigo = ?').get(codigo)) break;
      }
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO convites (codigo, criado_por) VALUES (?, ?)').run(codigo, usuarioId);
        db.prepare('UPDATE usuarios SET convites_restantes = convites_restantes - 1 WHERE id = ?').run(usuarioId);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return codigo;
    },
    buscarValido(codigo) {
      const c = limpar(db.prepare(`SELECT c.*, u.nome AS convidante_nome, u.status_verificacao AS convidante_status, u.banido AS convidante_banido
        FROM convites c JOIN usuarios u ON u.id = c.criado_por WHERE c.codigo = ? AND c.usado_por IS NULL`).get(String(codigo || '').trim().toUpperCase()));
      if (!c || c.convidante_status !== 'verificado' || c.convidante_banido) return null;
      return c;
    },
    usar(codigo, usuarioId) {
      db.prepare('UPDATE convites SET usado_por = ?, usado_em = ? WHERE codigo = ? AND usado_por IS NULL').run(usuarioId, agora(), codigo);
    },
    doUsuario(usuarioId) {
      return db.prepare(`SELECT c.*, u.nome AS usado_por_nome FROM convites c LEFT JOIN usuarios u ON u.id = c.usado_por
        WHERE c.criado_por = ? ORDER BY c.id DESC`).all(usuarioId).map(limpar);
    },
  };

  const verificacoes = {
    criar({ usuario_id, selfie = '', documento = '', instagram = '', observacao = '' }) {
      db.exec('BEGIN');
      try {
        const r = db.prepare('INSERT INTO verificacoes (usuario_id, selfie, documento, instagram, observacao) VALUES (?, ?, ?, ?, ?)')
          .run(usuario_id, selfie, documento, instagram, observacao);
        db.prepare("UPDATE usuarios SET status_verificacao = 'em_analise', instagram = CASE WHEN ? <> '' THEN ? ELSE instagram END, atualizado_em = ? WHERE id = ?")
          .run(instagram, instagram, agora(), usuario_id);
        db.exec('COMMIT');
        return Number(r.lastInsertRowid);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    buscar(id) {
      return limpar(db.prepare(`SELECT v.*, u.nome, u.email, u.tipo, u.cidade, u.estado, u.foto, u.convidado_por, u.whatsapp,
          (SELECT nome FROM usuarios c WHERE c.id = u.convidado_por) AS convidante_nome
        FROM verificacoes v JOIN usuarios u ON u.id = v.usuario_id WHERE v.id = ?`).get(id));
    },
    ultimaDoUsuario(usuarioId) {
      return limpar(db.prepare('SELECT * FROM verificacoes WHERE usuario_id = ? ORDER BY id DESC LIMIT 1').get(usuarioId));
    },
    listar({ status = 'em_analise' } = {}) {
      const where = status ? 'WHERE v.status = ?' : '';
      const params = status ? [status] : [];
      return db.prepare(`SELECT v.*, u.nome, u.email, u.tipo, u.cidade, u.estado, u.foto, u.convidado_por,
          (SELECT nome FROM usuarios c WHERE c.id = u.convidado_por) AS convidante_nome
        FROM verificacoes v JOIN usuarios u ON u.id = v.usuario_id ${where} ORDER BY v.id ASC`).all(...params).map(limpar);
    },
    salvarAnaliseIa(id, { resumo, recomendacao }) {
      db.prepare('UPDATE verificacoes SET analise_ia = ?, recomendacao_ia = ? WHERE id = ?').run(resumo || '', recomendacao || '', id);
    },
    /** Decide e, ao aprovar/rejeitar, apaga os caminhos das fotos (quem chama remove os arquivos). */
    decidir(id, aprovado, motivo = '') {
      const v = verificacoes.buscar(id);
      if (!v) return null;
      const status = aprovado ? 'verificado' : 'rejeitado';
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE verificacoes SET status = ?, motivo_decisao = ?, decidido_em = ?, selfie = '', documento = '' WHERE id = ?")
          .run(status, motivo, agora(), id);
        db.prepare('UPDATE usuarios SET status_verificacao = ?, atualizado_em = ? WHERE id = ?').run(status, agora(), v.usuario_id);
        if (aprovado) {
          db.prepare('UPDATE usuarios SET convites_restantes = MAX(convites_restantes, ?) WHERE id = ?').run(CONVITES_INICIAIS, v.usuario_id);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { usuario_id: v.usuario_id, selfie: v.selfie, documento: v.documento };
    },
  };

  const posts = {
    criar({ usuario_id, texto, cidade = '' }) {
      const r = db.prepare('INSERT INTO posts (usuario_id, texto, cidade) VALUES (?, ?, ?)').run(usuario_id, texto, cidade);
      return Number(r.lastInsertRowid);
    },
    listar({ cidade, limite = 50 } = {}) {
      const where = ['p.removido = 0', 'u.banido = 0'];
      const params = [];
      if (cidade) { where.push('LOWER(p.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      params.push(limite);
      return db.prepare(`SELECT p.*, u.nome, u.foto, u.tipo, u.status_verificacao,
          (SELECT COUNT(*) FROM denuncias d WHERE d.post_id = p.id AND d.resolvida = 0) AS denuncias
        FROM posts p JOIN usuarios u ON u.id = p.usuario_id
        WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`).all(...params).map(limpar);
    },
    buscar(id) {
      return limpar(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
    },
    remover(id) {
      db.prepare('UPDATE posts SET removido = 1 WHERE id = ?').run(id);
    },
  };

  const denuncias = {
    criar({ post_id = null, usuario_alvo_id = null, autor_id, motivo = '' }) {
      const r = db.prepare('INSERT INTO denuncias (post_id, usuario_alvo_id, autor_id, motivo) VALUES (?, ?, ?, ?)').run(post_id, usuario_alvo_id, autor_id, motivo);
      return Number(r.lastInsertRowid);
    },
    listar({ resolvida = 0 } = {}) {
      return db.prepare(`SELECT d.*, a.nome AS autor_nome, p.texto AS post_texto, p.usuario_id AS post_autor_id,
          pa.nome AS post_autor_nome, al.nome AS alvo_nome
        FROM denuncias d
        JOIN usuarios a ON a.id = d.autor_id
        LEFT JOIN posts p ON p.id = d.post_id
        LEFT JOIN usuarios pa ON pa.id = p.usuario_id
        LEFT JOIN usuarios al ON al.id = d.usuario_alvo_id
        WHERE d.resolvida = ? ORDER BY d.id ASC`).all(resolvida ? 1 : 0).map(limpar);
    },
    resolver(id) {
      db.prepare('UPDATE denuncias SET resolvida = 1 WHERE id = ?').run(id);
    },
  };

  const vagas = {
    criar({ empresa_id, titulo, descricao = '', cidade = '', tipo = 'CLT' }) {
      const r = db.prepare('INSERT INTO vagas (empresa_id, titulo, descricao, cidade, tipo) VALUES (?, ?, ?, ?, ?)')
        .run(empresa_id, titulo, descricao, cidade, TIPOS_VAGA.includes(tipo) ? tipo : 'Outro');
      return Number(r.lastInsertRowid);
    },
    listar({ cidade, apenasAbertas = true, empresa_id } = {}) {
      const where = ['u.banido = 0'];
      const params = [];
      if (apenasAbertas) where.push('v.aberta = 1');
      if (cidade) { where.push('LOWER(v.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      if (empresa_id) { where.push('v.empresa_id = ?'); params.push(empresa_id); }
      return db.prepare(`SELECT v.*, u.nome AS empresa_nome, u.foto AS empresa_foto, u.categoria AS empresa_categoria,
          (SELECT COUNT(*) FROM candidaturas c WHERE c.vaga_id = v.id) AS candidaturas
        FROM vagas v JOIN usuarios u ON u.id = v.empresa_id WHERE ${where.join(' AND ')} ORDER BY v.id DESC`).all(...params).map(limpar);
    },
    buscar(id) {
      return limpar(db.prepare(`SELECT v.*, u.nome AS empresa_nome, u.foto AS empresa_foto, u.categoria AS empresa_categoria, u.cidade AS empresa_cidade
        FROM vagas v JOIN usuarios u ON u.id = v.empresa_id WHERE v.id = ?`).get(id));
    },
    fechar(id, aberta = false) {
      db.prepare('UPDATE vagas SET aberta = ? WHERE id = ?').run(aberta ? 1 : 0, id);
    },
    candidatar({ vaga_id, usuario_id, mensagem = '' }) {
      db.prepare('INSERT OR IGNORE INTO candidaturas (vaga_id, usuario_id, mensagem) VALUES (?, ?, ?)').run(vaga_id, usuario_id, mensagem);
    },
    candidaturas(vagaId) {
      return db.prepare(`SELECT c.*, u.nome, u.foto, u.cidade, u.email, u.whatsapp, u.instagram, u.bio, u.status_verificacao
        FROM candidaturas c JOIN usuarios u ON u.id = c.usuario_id WHERE c.vaga_id = ? ORDER BY c.id DESC`).all(vagaId).map(limpar);
    },
    jaCandidatou(vagaId, usuarioId) {
      return Boolean(db.prepare('SELECT 1 FROM candidaturas WHERE vaga_id = ? AND usuario_id = ?').get(vagaId, usuarioId));
    },
  };

  const avaliacoes = {
    salvar({ empresa_id, autor_id, nota, texto = '' }) {
      const n = Math.max(1, Math.min(5, Number.parseInt(nota, 10) || 0));
      db.prepare(`INSERT INTO avaliacoes (empresa_id, autor_id, nota, texto) VALUES (?, ?, ?, ?)
        ON CONFLICT(empresa_id, autor_id) DO UPDATE SET nota = excluded.nota, texto = excluded.texto, criado_em = datetime('now')`)
        .run(empresa_id, autor_id, n, texto);
    },
    daEmpresa(empresaId) {
      return db.prepare(`SELECT a.*, u.nome AS autor_nome, u.foto AS autor_foto FROM avaliacoes a JOIN usuarios u ON u.id = a.autor_id
        WHERE a.empresa_id = ? AND u.banido = 0 ORDER BY a.id DESC`).all(empresaId).map(limpar);
    },
  };

  return { usuarios, convites, verificacoes, posts, denuncias, vagas, avaliacoes };
}

module.exports = {
  criarRepositorioRede,
  gerarHashSenha,
  conferirSenha,
  TIPOS_USUARIO,
  STATUS_VERIFICACAO,
  PAPEIS,
  TIPOS_VAGA,
  CATEGORIAS_EMPRESA,
  CONVITES_INICIAIS,
};
