'use strict';

/**
 * Tabelas e regras da rede (perfis, convites, verificação, feed, vagas, avaliações).
 * Usa o mesmo banco SQLite da Corrente do Bem.
 */

const crypto = require('node:crypto');

const TIPOS_USUARIO = ['pessoa', 'empresa'];
const STATUS_VERIFICACAO = ['pendente', 'em_analise', 'verificado', 'rejeitado'];
/** membro: comum · verificador: só aprova/recusa pedidos de selo · moderador: painel inteiro */
const PAPEIS = ['membro', 'verificador', 'moderador'];
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

CREATE TABLE IF NOT EXISTS curtidas (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (post_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS comentarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  texto TEXT NOT NULL,
  removido INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comentarios_post ON comentarios(post_id);

CREATE TABLE IF NOT EXISTS pontos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  acao TEXT NOT NULL,
  pontos INTEGER NOT NULL,
  referencia TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (usuario_id, acao, referencia)
);

CREATE TABLE IF NOT EXISTS negocios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  empresa_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  cliente_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  descricao TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pendente',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  decidido_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_pontos_usuario ON pontos(usuario_id);
CREATE INDEX IF NOT EXISTS idx_negocios_empresa ON negocios(empresa_id, status);
CREATE INDEX IF NOT EXISTS idx_negocios_cliente ON negocios(cliente_id);
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

function migrarRede(db) {
  const colunasDe = (tabela) => new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name));
  const v = colunasDe('verificacoes');
  if (!v.has('outras_redes')) db.exec("ALTER TABLE verificacoes ADD COLUMN outras_redes TEXT NOT NULL DEFAULT ''");
  if (!v.has('fotos')) db.exec("ALTER TABLE verificacoes ADD COLUMN fotos TEXT NOT NULL DEFAULT '[]'");
  if (!v.has('decidido_por')) db.exec('ALTER TABLE verificacoes ADD COLUMN decidido_por INTEGER');
  const p = colunasDe('posts');
  if (!p.has('midias')) db.exec("ALTER TABLE posts ADD COLUMN midias TEXT NOT NULL DEFAULT '[]'");
  const u = colunasDe('usuarios');
  if (!u.has('procura_emprego')) db.exec('ALTER TABLE usuarios ADD COLUMN procura_emprego INTEGER NOT NULL DEFAULT 0');
  if (!u.has('profissao')) db.exec("ALTER TABLE usuarios ADD COLUMN profissao TEXT NOT NULL DEFAULT ''");
  if (!u.has('curriculo')) db.exec("ALTER TABLE usuarios ADD COLUMN curriculo TEXT NOT NULL DEFAULT ''");
  if (!u.has('curriculo_arquivo')) db.exec("ALTER TABLE usuarios ADD COLUMN curriculo_arquivo TEXT NOT NULL DEFAULT ''");
}

function criarRepositorioRede(db) {
  db.exec(SCHEMA_REDE);
  migrarRede(db);
  const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
  const limpar = (l) => (l ? { ...l } : null);
  const semSenha = (u) => { if (!u) return null; const { senha_hash, ...resto } = u; return resto; };

  const COLUNAS_PUBLICAS = `u.id, u.tipo, u.nome, u.cidade, u.estado, u.bio, u.foto, u.instagram, u.site, u.categoria,
    u.status_verificacao, u.papel, u.banido, u.criado_em`;

  const usuarios = {
    /** Quem entra por convite de membro verificado já nasce verificado (o convidante responde por ele). */
    criar({ tipo = 'pessoa', nome, email, senha, cidade = '', estado = '', whatsapp = '', instagram = '', categoria = '', convidado_por = null }) {
      const verificado = Boolean(convidado_por);
      const r = db.prepare(`INSERT INTO usuarios (tipo, nome, email, senha_hash, cidade, estado, whatsapp, instagram, categoria, convidado_por, consentimento_em, status_verificacao, convites_restantes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(TIPOS_USUARIO.includes(tipo) ? tipo : 'pessoa', nome, email.toLowerCase(), gerarHashSenha(senha), cidade, estado, whatsapp, instagram, categoria, convidado_por, agora(),
          verificado ? 'verificado' : 'pendente', verificado ? CONVITES_INICIAIS : 0);
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
    atualizarCurriculo(id, { procura_emprego, profissao, curriculo }) {
      db.prepare('UPDATE usuarios SET procura_emprego = ?, profissao = ?, curriculo = ?, atualizado_em = ? WHERE id = ?')
        .run(procura_emprego ? 1 : 0, profissao, curriculo, agora(), id);
    },
    atualizarCurriculoArquivo(id, arquivo) {
      db.prepare('UPDATE usuarios SET curriculo_arquivo = ?, atualizado_em = ? WHERE id = ?').run(arquivo, agora(), id);
    },
    /** Pessoas com selo que estão procurando trabalho. */
    talentos({ cidade, busca, limite = 200 } = {}) {
      const where = ["u.status_verificacao = 'verificado'", 'u.banido = 0', "u.tipo = 'pessoa'", 'u.procura_emprego = 1'];
      const params = [];
      if (cidade) { where.push('LOWER(u.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      if (busca) { where.push('(LOWER(u.profissao) LIKE ? OR LOWER(u.curriculo) LIKE ? OR LOWER(u.nome) LIKE ?)'); const b = `%${busca.toLowerCase()}%`; params.push(b, b, b); }
      params.push(limite);
      return db.prepare(`SELECT ${COLUNAS_PUBLICAS}, u.profissao, u.curriculo, u.curriculo_arquivo FROM usuarios u WHERE ${where.join(' AND ')} ORDER BY u.atualizado_em DESC LIMIT ?`).all(...params).map(limpar);
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
      const u = limpar(db.prepare(`SELECT ${COLUNAS_PUBLICAS}, u.whatsapp, u.convidado_por, u.procura_emprego, u.profissao, u.curriculo, u.curriculo_arquivo,
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

  const comFotos = (v) => (v ? { ...v, fotos: safeLista(v.fotos) } : null);

  const verificacoes = {
    /** Verificação por redes sociais e/ou fotos. As fotos ficam privadas e são apagadas após a decisão. */
    criar({ usuario_id, instagram = '', outras_redes = '', fotos = [], observacao = '' }) {
      db.exec('BEGIN');
      try {
        const r = db.prepare('INSERT INTO verificacoes (usuario_id, instagram, outras_redes, fotos, observacao) VALUES (?, ?, ?, ?, ?)')
          .run(usuario_id, instagram, outras_redes, JSON.stringify(fotos), observacao);
        db.prepare("UPDATE usuarios SET status_verificacao = 'em_analise', instagram = CASE WHEN ? <> '' THEN ? ELSE instagram END, atualizado_em = ? WHERE id = ?")
          .run(instagram, instagram, agora(), usuario_id);
        db.exec('COMMIT');
        return Number(r.lastInsertRowid);
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    buscar(id) {
      return comFotos(db.prepare(`SELECT v.*, u.nome, u.email, u.tipo, u.cidade, u.estado, u.foto, u.convidado_por, u.whatsapp, u.bio,
          (SELECT nome FROM usuarios c WHERE c.id = u.convidado_por) AS convidante_nome
        FROM verificacoes v JOIN usuarios u ON u.id = v.usuario_id WHERE v.id = ?`).get(id));
    },
    ultimaDoUsuario(usuarioId) {
      return comFotos(db.prepare('SELECT * FROM verificacoes WHERE usuario_id = ? ORDER BY id DESC LIMIT 1').get(usuarioId));
    },
    listar({ status = 'em_analise' } = {}) {
      const where = status ? 'WHERE v.status = ?' : '';
      const params = status ? [status] : [];
      return db.prepare(`SELECT v.*, u.nome, u.email, u.tipo, u.cidade, u.estado, u.foto, u.convidado_por, u.bio,
          (SELECT nome FROM usuarios c WHERE c.id = u.convidado_por) AS convidante_nome,
          (SELECT nome FROM usuarios d WHERE d.id = v.decidido_por) AS decidido_por_nome
        FROM verificacoes v JOIN usuarios u ON u.id = v.usuario_id ${where} ORDER BY v.id ASC`).all(...params).map(comFotos);
    },
    /** Quantos selos cada verificador/moderador já decidiu. */
    contarDecisoes(usuarioId) {
      return Number(db.prepare('SELECT COUNT(*) n FROM verificacoes WHERE decidido_por = ?').get(usuarioId).n);
    },
    salvarAnaliseIa(id, { resumo, recomendacao }) {
      db.prepare('UPDATE verificacoes SET analise_ia = ?, recomendacao_ia = ? WHERE id = ?').run(resumo || '', recomendacao || '', id);
    },
    /** Decide e, ao aprovar/rejeitar, apaga os caminhos das fotos (quem chama remove os arquivos). */
    decidir(id, aprovado, motivo = '', decididoPor = null) {
      const v = verificacoes.buscar(id);
      if (!v) return null;
      const status = aprovado ? 'verificado' : 'rejeitado';
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE verificacoes SET status = ?, motivo_decisao = ?, decidido_em = ?, decidido_por = ?, fotos = '[]' WHERE id = ?")
          .run(status, motivo, agora(), decididoPor, id);
        db.prepare('UPDATE usuarios SET status_verificacao = ?, atualizado_em = ? WHERE id = ?').run(status, agora(), v.usuario_id);
        if (aprovado) {
          db.prepare('UPDATE usuarios SET convites_restantes = MAX(convites_restantes, ?) WHERE id = ?').run(CONVITES_INICIAIS, v.usuario_id);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return { usuario_id: v.usuario_id, fotos: v.fotos };
    },
  };

  // ---------- gamificação: pontos e negócios ----------
  const pontos = {
    /** Dá pontos uma única vez por (usuário, ação, referência). Retorna true se creditou. */
    dar(usuarioId, acao, quantidade, referencia = '') {
      const r = db.prepare('INSERT OR IGNORE INTO pontos (usuario_id, acao, pontos, referencia) VALUES (?, ?, ?, ?)').run(usuarioId, acao, quantidade, String(referencia));
      return r.changes > 0;
    },
    total(usuarioId) {
      return Number(db.prepare('SELECT COALESCE(SUM(pontos), 0) n FROM pontos WHERE usuario_id = ?').get(usuarioId).n);
    },
    contarAcao(usuarioId, acao, { hoje = false } = {}) {
      const sql = hoje
        ? "SELECT COUNT(*) n FROM pontos WHERE usuario_id = ? AND acao = ? AND date(criado_em) = date('now')"
        : 'SELECT COUNT(*) n FROM pontos WHERE usuario_id = ? AND acao = ?';
      return Number(db.prepare(sql).get(usuarioId, acao).n);
    },
    historico(usuarioId, limite = 30) {
      return db.prepare('SELECT * FROM pontos WHERE usuario_id = ? ORDER BY id DESC LIMIT ?').all(usuarioId, limite).map(limpar);
    },
    /** Estatísticas usadas para níveis e conquistas. */
    estatisticas(usuarioId) {
      const n = (sql, ...p) => Number(db.prepare(sql).get(...p).n);
      return {
        pontos: pontos.total(usuarioId),
        convidados_verificados: n("SELECT COUNT(*) n FROM usuarios WHERE convidado_por = ? AND status_verificacao = 'verificado'", usuarioId),
        negocios_como_cliente: n("SELECT COUNT(*) n FROM negocios WHERE cliente_id = ? AND status = 'confirmado'", usuarioId),
        negocios_como_empresa: n("SELECT COUNT(*) n FROM negocios WHERE empresa_id = ? AND status = 'confirmado'", usuarioId),
        avaliacoes_feitas: n('SELECT COUNT(*) n FROM avaliacoes WHERE autor_id = ?', usuarioId),
        avaliacoes_recebidas: n('SELECT COUNT(*) n FROM avaliacoes WHERE empresa_id = ?', usuarioId),
        posts: n('SELECT COUNT(*) n FROM posts WHERE usuario_id = ? AND removido = 0', usuarioId),
        vagas: n('SELECT COUNT(*) n FROM vagas WHERE empresa_id = ?', usuarioId),
        candidaturas: n('SELECT COUNT(*) n FROM candidaturas WHERE usuario_id = ?', usuarioId),
      };
    },
    ranking({ tipo, cidade, limite = 20 } = {}) {
      const where = ["u.status_verificacao = 'verificado'", 'u.banido = 0'];
      const params = [];
      if (tipo) { where.push('u.tipo = ?'); params.push(tipo); }
      if (cidade) { where.push('LOWER(u.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      params.push(limite);
      return db.prepare(`SELECT u.id, u.nome, u.tipo, u.foto, u.cidade, u.estado, u.categoria,
          COALESCE((SELECT SUM(p.pontos) FROM pontos p WHERE p.usuario_id = u.id), 0) AS pontos,
          (SELECT COUNT(*) FROM negocios n WHERE (n.empresa_id = u.id OR n.cliente_id = u.id) AND n.status = 'confirmado') AS negocios,
          (SELECT ROUND(AVG(nota), 1) FROM avaliacoes a WHERE a.empresa_id = u.id) AS nota_media
        FROM usuarios u WHERE ${where.join(' AND ')} ORDER BY pontos DESC, negocios DESC, u.id ASC LIMIT ?`).all(...params).map(limpar);
    },
  };

  const negocios = {
    criar({ empresa_id, cliente_id, descricao = '' }) {
      const r = db.prepare('INSERT INTO negocios (empresa_id, cliente_id, descricao) VALUES (?, ?, ?)').run(empresa_id, cliente_id, descricao);
      return Number(r.lastInsertRowid);
    },
    buscar(id) {
      return limpar(db.prepare(`SELECT n.*, e.nome AS empresa_nome, c.nome AS cliente_nome, c.foto AS cliente_foto, c.cidade AS cliente_cidade
        FROM negocios n JOIN usuarios e ON e.id = n.empresa_id JOIN usuarios c ON c.id = n.cliente_id WHERE n.id = ?`).get(id));
    },
    daEmpresa(empresaId, status) {
      const where = status ? 'AND n.status = ?' : '';
      const params = status ? [empresaId, status] : [empresaId];
      return db.prepare(`SELECT n.*, c.nome AS cliente_nome, c.foto AS cliente_foto, c.cidade AS cliente_cidade, c.tipo AS cliente_tipo
        FROM negocios n JOIN usuarios c ON c.id = n.cliente_id WHERE n.empresa_id = ? ${where} ORDER BY n.id DESC`).all(...params).map(limpar);
    },
    doCliente(clienteId) {
      return db.prepare(`SELECT n.*, e.nome AS empresa_nome, e.foto AS empresa_foto
        FROM negocios n JOIN usuarios e ON e.id = n.empresa_id WHERE n.cliente_id = ? ORDER BY n.id DESC`).all(clienteId).map(limpar);
    },
    pendentesHoje(clienteId, empresaId) {
      return Number(db.prepare("SELECT COUNT(*) n FROM negocios WHERE cliente_id = ? AND empresa_id = ? AND status = 'pendente'").get(clienteId, empresaId).n);
    },
    decidir(id, confirmado) {
      db.prepare('UPDATE negocios SET status = ?, decidido_em = ? WHERE id = ? AND status = ?').run(confirmado ? 'confirmado' : 'recusado', agora(), id, 'pendente');
    },
    contarConfirmados(usuarioId) {
      return Number(db.prepare("SELECT COUNT(*) n FROM negocios WHERE (empresa_id = ? OR cliente_id = ?) AND status = 'confirmado'").get(usuarioId, usuarioId).n);
    },
  };

  const comMidias = (p) => (p ? { ...p, midias: safeLista(p.midias) } : null);

  const posts = {
    /** midias: [{ tipo: 'imagem'|'video', arquivo }] */
    criar({ usuario_id, texto = '', cidade = '', midias = [] }) {
      const r = db.prepare('INSERT INTO posts (usuario_id, texto, cidade, midias) VALUES (?, ?, ?, ?)').run(usuario_id, texto, cidade, JSON.stringify(midias));
      return Number(r.lastInsertRowid);
    },
    /** Lista para o feed. `usuarioId` marca os posts que a pessoa curtiu. `apenasVideos` = reels. */
    listar({ cidade, autorId, apenasVideos = false, usuarioId = null, limite = 50 } = {}) {
      const where = ['p.removido = 0', 'u.banido = 0'];
      const params = [usuarioId];
      if (cidade) { where.push('LOWER(p.cidade) LIKE ?'); params.push(`%${cidade.toLowerCase()}%`); }
      if (autorId) { where.push('p.usuario_id = ?'); params.push(autorId); }
      if (apenasVideos) where.push("p.midias LIKE '%\"video\"%'");
      params.push(limite);
      const lista = db.prepare(`SELECT p.*, u.nome, u.foto, u.tipo, u.status_verificacao,
          (SELECT COUNT(*) FROM curtidas c WHERE c.post_id = p.id) AS curtidas,
          (SELECT COUNT(*) FROM comentarios c WHERE c.post_id = p.id AND c.removido = 0) AS total_comentarios,
          EXISTS(SELECT 1 FROM curtidas c WHERE c.post_id = p.id AND c.usuario_id = ?) AS curti
        FROM posts p JOIN usuarios u ON u.id = p.usuario_id
        WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT ?`).all(...params).map(comMidias);
      const ultimos = db.prepare(`SELECT c.*, u.nome, u.foto, u.tipo FROM comentarios c JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.post_id = ? AND c.removido = 0 AND u.banido = 0 ORDER BY c.id DESC LIMIT 3`);
      for (const p of lista) p.comentarios = ultimos.all(p.id).map(limpar).reverse();
      return lista;
    },
    buscar(id) {
      return comMidias(db.prepare('SELECT * FROM posts WHERE id = ?').get(id));
    },
    buscarCompleto(id, usuarioId = null) {
      const p = comMidias(db.prepare(`SELECT p.*, u.nome, u.foto, u.tipo, u.status_verificacao,
          (SELECT COUNT(*) FROM curtidas c WHERE c.post_id = p.id) AS curtidas,
          EXISTS(SELECT 1 FROM curtidas c WHERE c.post_id = p.id AND c.usuario_id = ?) AS curti
        FROM posts p JOIN usuarios u ON u.id = p.usuario_id WHERE p.id = ? AND p.removido = 0 AND u.banido = 0`).get(usuarioId, id));
      if (!p) return null;
      p.comentarios = db.prepare(`SELECT c.*, u.nome, u.foto, u.tipo FROM comentarios c JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.post_id = ? AND c.removido = 0 AND u.banido = 0 ORDER BY c.id ASC`).all(id).map(limpar);
      p.total_comentarios = p.comentarios.length;
      return p;
    },
    remover(id) {
      db.prepare('UPDATE posts SET removido = 1 WHERE id = ?').run(id);
    },
    /** Alterna curtida. Retorna true se passou a curtir. */
    curtir(postId, usuarioId) {
      const r = db.prepare('DELETE FROM curtidas WHERE post_id = ? AND usuario_id = ?').run(postId, usuarioId);
      if (r.changes > 0) return false;
      db.prepare('INSERT INTO curtidas (post_id, usuario_id) VALUES (?, ?)').run(postId, usuarioId);
      return true;
    },
    comentar({ post_id, usuario_id, texto }) {
      const r = db.prepare('INSERT INTO comentarios (post_id, usuario_id, texto) VALUES (?, ?, ?)').run(post_id, usuario_id, texto);
      return Number(r.lastInsertRowid);
    },
    buscarComentario(id) {
      return limpar(db.prepare('SELECT * FROM comentarios WHERE id = ?').get(id));
    },
    removerComentario(id) {
      db.prepare('UPDATE comentarios SET removido = 1 WHERE id = ?').run(id);
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

  return { usuarios, convites, verificacoes, posts, denuncias, vagas, avaliacoes, pontos, negocios };
}

function safeLista(texto) {
  try { const v = JSON.parse(texto || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
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
