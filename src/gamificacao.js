'use strict';

/**
 * Gamificação: pontos por ações que fortalecem a rede (principalmente comércio
 * entre membros), níveis e conquistas. Tudo derivado do histórico de pontos e
 * das tabelas existentes, sem estado extra.
 */

const ACOES = {
  selo: { pontos: 50, rotulo: 'Ganhou o selo' },
  convidado_entrou: { pontos: 30, rotulo: 'Trouxe um membro' },
  perfil_completo: { pontos: 20, rotulo: 'Completou o perfil' },
  post: { pontos: 5, rotulo: 'Publicou no feed', limiteDia: 3 },
  comentou: { pontos: 2, rotulo: 'Comentou uma publicação', limiteDia: 10 },
  curriculo: { pontos: 15, rotulo: 'Cadastrou o currículo' },
  doou: { pontos: 20, rotulo: 'Doação entregue pela Corrente do Bem' },
  campanha: { pontos: 10, rotulo: 'Criou uma campanha de ajuda' },
  avaliou: { pontos: 10, rotulo: 'Avaliou uma empresa' },
  foi_avaliado: { pontos: 10, rotulo: 'Recebeu uma avaliação' },
  vaga: { pontos: 15, rotulo: 'Publicou uma vaga' },
  candidatura: { pontos: 5, rotulo: 'Candidatou-se a uma vaga' },
  negocio_cliente: { pontos: 25, rotulo: 'Comprou de um membro' },
  negocio_empresa: { pontos: 25, rotulo: 'Vendeu para um membro' },
};

const NIVEIS = [
  { nome: 'Recruta', minimo: 0, icone: '🌱' },
  { nome: 'Patriota', minimo: 100, icone: '🇧🇷' },
  { nome: 'Guardião', minimo: 300, icone: '🛡️' },
  { nome: 'Bandeirante', minimo: 700, icone: '⚔️' },
  { nome: 'Lenda', minimo: 1500, icone: '🏆' },
];

const CONQUISTAS = [
  { chave: 'primeiro_elo', nome: 'Primeiro Elo', icone: '🔗', descricao: 'Fechou o primeiro negócio dentro da rede.', condicao: (s) => s.negocios_como_cliente + s.negocios_como_empresa >= 1 },
  { chave: 'cliente_fiel', nome: 'Cliente da Comunidade', icone: '🛍️', descricao: 'Comprou de 5 empresas da rede.', condicao: (s) => s.negocios_como_cliente >= 5 },
  { chave: 'comerciante', nome: 'Comerciante', icone: '🏪', descricao: 'Fechou 10 negócios como empresa.', condicao: (s) => s.negocios_como_empresa >= 10 },
  { chave: 'anfitriao', nome: 'Anfitrião', icone: '🎟️', descricao: 'Trouxe 5 membros para a rede.', condicao: (s) => s.convidados_verificados >= 5 },
  { chave: 'avaliador', nome: 'Avaliador', icone: '⭐', descricao: 'Avaliou 10 empresas.', condicao: (s) => s.avaliacoes_feitas >= 10 },
  { chave: 'bem_avaliado', nome: 'Bem Avaliado', icone: '🏅', descricao: 'Recebeu 10 avaliações.', condicao: (s) => s.avaliacoes_recebidas >= 10 },
  { chave: 'empregador', nome: 'Empregador', icone: '💼', descricao: 'Publicou 3 vagas.', condicao: (s) => s.vagas >= 3 },
  { chave: 'voz_ativa', nome: 'Voz Ativa', icone: '📣', descricao: 'Fez 20 publicações.', condicao: (s) => s.posts >= 20 },
  { chave: 'mao_amiga', nome: 'Mão Amiga', icone: '💛', descricao: 'Teve 3 doações entregues pela Corrente do Bem.', condicao: (s) => s.doacoes >= 3 },
];

function nivelDe(pontos) {
  let atual = NIVEIS[0];
  for (const n of NIVEIS) if (pontos >= n.minimo) atual = n;
  const proximo = NIVEIS.find((n) => n.minimo > atual.minimo) || null;
  return { ...atual, proximo, faltam: proximo ? proximo.minimo - pontos : 0 };
}

function conquistasDe(stats) {
  return CONQUISTAS.map((c) => ({ ...c, conquistada: Boolean(c.condicao(stats)) }));
}

function criarGamificacao(db) {
  /** Credita a ação uma vez por referência. Respeita limite diário quando a ação tem um. */
  function premiar(usuarioId, acao, referencia = '') {
    const def = ACOES[acao];
    if (!def || !usuarioId) return false;
    if (def.limiteDia && db.pontos.contarAcao(usuarioId, acao, { hoje: true }) >= def.limiteDia) return false;
    return db.pontos.dar(usuarioId, acao, def.pontos, referencia);
  }

  /** Resumo para exibir no perfil: pontos, nível, conquistas, estatísticas. */
  function resumo(usuarioId) {
    const stats = db.pontos.estatisticas(usuarioId);
    return { stats, pontos: stats.pontos, nivel: nivelDe(stats.pontos), conquistas: conquistasDe(stats) };
  }

  /** Dá os pontos de "perfil completo" quando foto e bio existem. */
  function checarPerfilCompleto(usuario) {
    const u = db.usuarios.buscar(usuario.id);
    if (u && u.foto && u.bio) premiar(u.id, 'perfil_completo', 'perfil');
  }

  return { premiar, resumo, checarPerfilCompleto, ACOES, NIVEIS, CONQUISTAS, nivelDe };
}

module.exports = { criarGamificacao, ACOES, NIVEIS, CONQUISTAS, nivelDe, conquistasDe };
