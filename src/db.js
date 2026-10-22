'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const CATEGORIAS = [
  'Saúde e remédios',
  'Alimentação',
  'Roupas e calçados',
  'Móveis e eletrodomésticos',
  'Moradia e reforma',
  'Serviços (dentista, médico, transporte...)',
  'Dinheiro / Pix',
  'Outros',
];

const STATUS_NECESSIDADE = ['aberta', 'recebida'];
const STATUS_OFERTA = ['nova', 'aceita', 'disponivel', 'repassada', 'concluida', 'cancelada'];
const STATUS_PEDIDO = ['aberto', 'atendido', 'cancelado'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS necessidades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  titulo TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT 'Outros',
  status TEXT NOT NULL DEFAULT 'aberta',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  contato TEXT NOT NULL,
  cidade TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT 'Outros',
  status TEXT NOT NULL DEFAULT 'aberto',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ofertas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  contato TEXT NOT NULL,
  cidade TEXT NOT NULL DEFAULT '',
  item TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  categoria TEXT NOT NULL DEFAULT 'Outros',
  necessidade_id INTEGER REFERENCES necessidades(id) ON DELETE SET NULL,
  pedido_id INTEGER REFERENCES pedidos(id) ON DELETE SET NULL,
  autoriza_repasse INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'nova',
  observacao_admin TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sugestoes_ia (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oferta_id INTEGER NOT NULL REFERENCES ofertas(id) ON DELETE CASCADE,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  pontuacao INTEGER NOT NULL DEFAULT 0,
  motivo TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sugestoes_oferta ON sugestoes_ia(oferta_id);
CREATE INDEX IF NOT EXISTS idx_ofertas_status ON ofertas(status);
CREATE INDEX IF NOT EXISTS idx_ofertas_necessidade ON ofertas(necessidade_id);
CREATE INDEX IF NOT EXISTS idx_ofertas_pedido ON ofertas(pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status);
`;

const CONFIG_PADRAO = {
  nome_campanha: 'Corrente do Bem',
  nome_beneficiaria: 'Tia',
  historia:
    'A história dela viralizou e muita gente quer ajudar. Esta página organiza o que ela ainda precisa, ' +
    'mostra o que já recebeu, e repassa as doações que sobrarem para outras pessoas que também precisam.',
  link_video: '',
  whatsapp_contato: '',
  cidade: '',
};

function abrirBanco(caminho) {
  const arquivo = caminho || process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'corrente.db');
  if (arquivo !== ':memory:') {
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  }
  const db = new DatabaseSync(arquivo);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrar(db);

  const inserirConfig = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
  for (const [chave, valor] of Object.entries(CONFIG_PADRAO)) {
    inserirConfig.run(chave, valor);
  }

  return criarRepositorio(db);
}

/** Adiciona colunas novas em bancos criados por versões anteriores. */
function migrar(db) {
  const colunas = new Set(db.prepare('PRAGMA table_info(ofertas)').all().map((c) => c.name));
  if (!colunas.has('analise_ia')) db.exec("ALTER TABLE ofertas ADD COLUMN analise_ia TEXT NOT NULL DEFAULT ''");
  if (!colunas.has('ia_analisada_em')) db.exec('ALTER TABLE ofertas ADD COLUMN ia_analisada_em TEXT');
}

function criarRepositorio(db) {
  const agora = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

  function limpar(linha) {
    return linha ? { ...linha } : null;
  }

  // ---------- config ----------
  const config = {
    todas() {
      const out = {};
      for (const row of db.prepare('SELECT chave, valor FROM config').all()) out[row.chave] = row.valor;
      return out;
    },
    salvar(valores) {
      const stmt = db.prepare('INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor');
      for (const chave of Object.keys(CONFIG_PADRAO)) {
        if (valores[chave] !== undefined) stmt.run(chave, String(valores[chave]).trim());
      }
    },
  };

  // ---------- necessidades ----------
  const necessidades = {
    listar(filtro = {}) {
      const where = [];
      const params = [];
      if (filtro.status) { where.push('status = ?'); params.push(filtro.status); }
      const sql = `SELECT n.*,
          (SELECT COUNT(*) FROM ofertas o WHERE o.necessidade_id = n.id AND o.status IN ('nova','aceita')) AS ofertas_pendentes
        FROM necessidades n ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE status WHEN 'aberta' THEN 0 ELSE 1 END, id DESC`;
      return db.prepare(sql).all(...params).map(limpar);
    },
    buscar(id) {
      return limpar(db.prepare('SELECT * FROM necessidades WHERE id = ?').get(id));
    },
    criar({ titulo, descricao = '', categoria = 'Outros' }) {
      const r = db.prepare('INSERT INTO necessidades (titulo, descricao, categoria) VALUES (?, ?, ?)').run(titulo, descricao, categoria);
      return Number(r.lastInsertRowid);
    },
    atualizar(id, { titulo, descricao, categoria }) {
      db.prepare('UPDATE necessidades SET titulo = ?, descricao = ?, categoria = ?, atualizado_em = ? WHERE id = ?')
        .run(titulo, descricao, categoria, agora(), id);
    },
    /**
     * Marca uma necessidade como recebida. Todas as ofertas ainda pendentes para
     * essa necessidade ficam "disponíveis" para serem repassadas a outra pessoa
     * (quando o doador autorizou o repasse).
     */
    marcarRecebida(id) {
      const tx = () => {
        db.prepare("UPDATE necessidades SET status = 'recebida', atualizado_em = ? WHERE id = ?").run(agora(), id);
        db.prepare(`UPDATE ofertas SET status = 'disponivel', atualizado_em = ?
                    WHERE necessidade_id = ? AND status IN ('nova','aceita') AND autoriza_repasse = 1`).run(agora(), id);
      };
      db.exec('BEGIN');
      try { tx(); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    reabrir(id) {
      db.prepare("UPDATE necessidades SET status = 'aberta', atualizado_em = ? WHERE id = ?").run(agora(), id);
    },
    remover(id) {
      db.prepare('DELETE FROM necessidades WHERE id = ?').run(id);
    },
  };

  // ---------- pedidos (outras pessoas que precisam) ----------
  const pedidos = {
    listar(filtro = {}) {
      const where = [];
      const params = [];
      if (filtro.status) { where.push('p.status = ?'); params.push(filtro.status); }
      if (filtro.categoria) { where.push('p.categoria = ?'); params.push(filtro.categoria); }
      const sql = `SELECT p.*,
          (SELECT COUNT(*) FROM ofertas o WHERE o.pedido_id = p.id AND o.status IN ('repassada','concluida')) AS ofertas_vinculadas
        FROM pedidos p ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE p.status WHEN 'aberto' THEN 0 WHEN 'atendido' THEN 1 ELSE 2 END, p.id DESC`;
      return db.prepare(sql).all(...params).map(limpar);
    },
    buscar(id) {
      return limpar(db.prepare('SELECT * FROM pedidos WHERE id = ?').get(id));
    },
    criar({ nome, contato, cidade = '', item, descricao = '', categoria = 'Outros' }) {
      const r = db.prepare('INSERT INTO pedidos (nome, contato, cidade, item, descricao, categoria) VALUES (?, ?, ?, ?, ?, ?)')
        .run(nome, contato, cidade, item, descricao, categoria);
      return Number(r.lastInsertRowid);
    },
    mudarStatus(id, status) {
      if (!STATUS_PEDIDO.includes(status)) throw new Error('status inválido');
      db.prepare('UPDATE pedidos SET status = ?, atualizado_em = ? WHERE id = ?').run(status, agora(), id);
    },
    remover(id) {
      db.prepare('DELETE FROM pedidos WHERE id = ?').run(id);
    },
  };

  // ---------- ofertas (quem quer doar) ----------
  const ofertas = {
    listar(filtro = {}) {
      const where = [];
      const params = [];
      if (filtro.status) { where.push('o.status = ?'); params.push(filtro.status); }
      const sql = `SELECT o.*, n.titulo AS necessidade_titulo, n.status AS necessidade_status,
          p.nome AS pedido_nome, p.item AS pedido_item, p.contato AS pedido_contato, p.cidade AS pedido_cidade
        FROM ofertas o
        LEFT JOIN necessidades n ON n.id = o.necessidade_id
        LEFT JOIN pedidos p ON p.id = o.pedido_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE o.status WHEN 'nova' THEN 0 WHEN 'disponivel' THEN 1 WHEN 'aceita' THEN 2 WHEN 'repassada' THEN 3 WHEN 'concluida' THEN 4 ELSE 5 END, o.id DESC`;
      return db.prepare(sql).all(...params).map(limpar);
    },
    buscar(id) {
      return limpar(db.prepare(`SELECT o.*, n.titulo AS necessidade_titulo, n.status AS necessidade_status,
          p.nome AS pedido_nome, p.item AS pedido_item
        FROM ofertas o
        LEFT JOIN necessidades n ON n.id = o.necessidade_id
        LEFT JOIN pedidos p ON p.id = o.pedido_id
        WHERE o.id = ?`).get(id));
    },
    /**
     * Registra uma oferta de doação. Se o doador escolheu uma necessidade que já
     * foi recebida, a oferta já nasce "disponível" para repasse (se autorizado).
     * Se o doador escolheu diretamente um pedido de outra pessoa, nasce "repassada".
     */
    criar({ nome, contato, cidade = '', item, descricao = '', categoria = 'Outros', necessidade_id = null, pedido_id = null, autoriza_repasse = true }) {
      let status = 'nova';
      let necessidade = null;
      let pedido = null;

      if (necessidade_id) {
        necessidade = necessidades.buscar(necessidade_id);
        if (!necessidade) necessidade_id = null;
        else if (necessidade.status === 'recebida') status = autoriza_repasse ? 'disponivel' : 'nova';
      }
      if (pedido_id) {
        pedido = pedidos.buscar(pedido_id);
        if (!pedido || pedido.status !== 'aberto') pedido_id = null;
        else status = 'repassada';
      }

      const r = db.prepare(`INSERT INTO ofertas
          (nome, contato, cidade, item, descricao, categoria, necessidade_id, pedido_id, autoriza_repasse, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(nome, contato, cidade, item, descricao, categoria, necessidade_id, pedido_id, autoriza_repasse ? 1 : 0, status);
      return { id: Number(r.lastInsertRowid), status, necessidade, pedido };
    },
    mudarStatus(id, status, observacao) {
      if (!STATUS_OFERTA.includes(status)) throw new Error('status inválido');
      if (observacao !== undefined) {
        db.prepare('UPDATE ofertas SET status = ?, observacao_admin = ?, atualizado_em = ? WHERE id = ?').run(status, observacao, agora(), id);
      } else {
        db.prepare('UPDATE ofertas SET status = ?, atualizado_em = ? WHERE id = ?').run(status, agora(), id);
      }
    },
    /** Repassa uma oferta para um pedido de outra pessoa. */
    repassar(id, pedidoId) {
      const pedido = pedidos.buscar(pedidoId);
      if (!pedido) throw new Error('pedido não encontrado');
      db.prepare("UPDATE ofertas SET pedido_id = ?, status = 'repassada', atualizado_em = ? WHERE id = ?").run(pedidoId, agora(), id);
    },
    /** Conclui a oferta. Se estava vinculada a um pedido, o pedido vira "atendido". */
    concluir(id) {
      const oferta = ofertas.buscar(id);
      if (!oferta) return;
      db.exec('BEGIN');
      try {
        db.prepare("UPDATE ofertas SET status = 'concluida', atualizado_em = ? WHERE id = ?").run(agora(), id);
        if (oferta.pedido_id) {
          db.prepare("UPDATE pedidos SET status = 'atendido', atualizado_em = ? WHERE id = ?").run(agora(), oferta.pedido_id);
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    vincularNecessidade(id, necessidadeId) {
      db.prepare('UPDATE ofertas SET necessidade_id = ?, atualizado_em = ? WHERE id = ?').run(necessidadeId, agora(), id);
    },
    /** Grava o resultado da análise da IA (resumo + sugestões de repasse), substituindo a anterior. */
    salvarAnaliseIa(id, { resumo = '', sugestoes = [] }) {
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE ofertas SET analise_ia = ?, ia_analisada_em = ?, atualizado_em = ? WHERE id = ?').run(resumo, agora(), agora(), id);
        db.prepare('DELETE FROM sugestoes_ia WHERE oferta_id = ?').run(id);
        const ins = db.prepare('INSERT INTO sugestoes_ia (oferta_id, pedido_id, pontuacao, motivo) VALUES (?, ?, ?, ?)');
        for (const s of sugestoes) ins.run(id, s.pedido_id, s.pontuacao, s.motivo);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    /** Sugestões da IA para um conjunto de ofertas: { [ofertaId]: [sugestão...] }. Só pedidos ainda abertos. */
    sugestoesIa(ids) {
      const out = {};
      if (!ids.length) return out;
      const marcadores = ids.map(() => '?').join(',');
      const linhas = db.prepare(`SELECT s.oferta_id, s.pedido_id, s.pontuacao, s.motivo,
          p.nome AS pedido_nome, p.item AS pedido_item, p.cidade AS pedido_cidade, p.status AS pedido_status
        FROM sugestoes_ia s JOIN pedidos p ON p.id = s.pedido_id
        WHERE s.oferta_id IN (${marcadores}) AND p.status = 'aberto'
        ORDER BY s.pontuacao DESC`).all(...ids);
      for (const l of linhas) (out[l.oferta_id] ||= []).push(limpar(l));
      return out;
    },
    /** IDs das ofertas que valem a pena analisar: ainda em andamento e sem análise (ou todas, se `todas`). */
    idsParaAnalise({ todas = false } = {}) {
      const sql = todas
        ? "SELECT id FROM ofertas WHERE status IN ('nova','aceita','disponivel') ORDER BY id"
        : "SELECT id FROM ofertas WHERE status IN ('nova','aceita','disponivel') AND ia_analisada_em IS NULL ORDER BY id";
      return db.prepare(sql).all().map((r) => Number(r.id));
    },
    remover(id) {
      db.prepare('DELETE FROM ofertas WHERE id = ?').run(id);
    },
  };

  const estatisticas = () => {
    const contar = (sql) => Number(db.prepare(sql).get().n);
    return {
      necessidades_abertas: contar("SELECT COUNT(*) n FROM necessidades WHERE status = 'aberta'"),
      necessidades_recebidas: contar("SELECT COUNT(*) n FROM necessidades WHERE status = 'recebida'"),
      ofertas_total: contar('SELECT COUNT(*) n FROM ofertas'),
      ofertas_novas: contar("SELECT COUNT(*) n FROM ofertas WHERE status = 'nova'"),
      ofertas_disponiveis: contar("SELECT COUNT(*) n FROM ofertas WHERE status = 'disponivel'"),
      ofertas_repassadas: contar("SELECT COUNT(*) n FROM ofertas WHERE status IN ('repassada','concluida') AND pedido_id IS NOT NULL"),
      pedidos_abertos: contar("SELECT COUNT(*) n FROM pedidos WHERE status = 'aberto'"),
      pedidos_atendidos: contar("SELECT COUNT(*) n FROM pedidos WHERE status = 'atendido'"),
    };
  };

  return {
    raw: db,
    config,
    necessidades,
    pedidos,
    ofertas,
    estatisticas,
    fechar: () => db.close(),
  };
}

module.exports = { abrirBanco, CATEGORIAS, STATUS_NECESSIDADE, STATUS_OFERTA, STATUS_PEDIDO };
