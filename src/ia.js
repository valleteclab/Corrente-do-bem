'use strict';

/**
 * Integração com a Claude API para:
 *  1. Entender o que o doador quer doar e ligar a oferta a um item da lista
 *     da beneficiária (mesmo que ele tenha escrito com outras palavras).
 *  2. Se o item já foi recebido, sugerir para quais pedidos de outras
 *     pessoas a doação pode ser repassada, com uma justificativa.
 *
 * A IA só sugere. Quem decide e confirma o repasse é a organização, no painel.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODELO = process.env.IA_MODELO || 'claude-opus-5-5';

const ESQUEMA_RESPOSTA = {
  type: 'object',
  properties: {
    necessidade_id: {
      type: ['integer', 'null'],
      description: 'ID do item da lista da beneficiária que corresponde à oferta, ou null se não corresponde a nenhum.',
    },
    resumo: {
      type: 'string',
      description: 'Uma ou duas frases, em português, explicando a análise para a pessoa que organiza a campanha.',
    },
    sugestoes: {
      type: 'array',
      description: 'Pedidos de outras pessoas que essa doação pode atender, do melhor para o pior. Vazio se nenhum combina.',
      items: {
        type: 'object',
        properties: {
          pedido_id: { type: 'integer' },
          pontuacao: { type: 'integer', description: 'De 0 a 100: quanto a doação atende o pedido.' },
          motivo: { type: 'string', description: 'Uma frase curta explicando por que combina.' },
        },
        required: ['pedido_id', 'pontuacao', 'motivo'],
        additionalProperties: false,
      },
    },
  },
  required: ['necessidade_id', 'resumo', 'sugestoes'],
  additionalProperties: false,
};

const SISTEMA = `Você ajuda a organizar a "Corrente do Bem", o módulo de ajuda mútua de uma rede comunitária.
Membros criam campanhas para pessoas que precisam de ajuda, cada campanha com uma lista de itens que
ainda faltam e itens que já foram recebidos. Além disso, outras pessoas registram pedidos individuais.
Quando alguém oferece algo que uma campanha já recebeu, a doação deve ser repassada para o próximo
da fila: um pedido individual ou outro item ainda aberto.

Sua tarefa, dada uma oferta de doação:
1. Dizer a qual item de campanha a oferta corresponde (necessidade_id), considerando sinônimos,
   variações regionais e descrições informais ("prótese dentária" = "dentadura", "rancho" = "cesta
   básica", "remédio de pressão" = "Losartana"). Prefira itens ainda abertos; se o único item
   correspondente já foi recebido, aponte-o mesmo assim (isso libera o repasse). Se não corresponder
   a nenhum, null. Se a oferta já vier ligada a um item, mantenha-o a menos que esteja claramente errado.
2. Listar os pedidos individuais que essa doação atende, do melhor para o pior, com pontuação de 0 a
   100 e um motivo curto. Considere: o item é o mesmo ou serve para o mesmo fim; categoria;
   proximidade de cidade (entrega mais fácil); urgência descrita no pedido. Só inclua pedidos com
   pontuação 40 ou mais. Dinheiro/Pix pode atender quase qualquer pedido, mas priorize pedidos
   onde dinheiro resolve (remédio, conta, transporte).
   Liste sugestões mesmo quando o item ainda está aberto: pode haver mais ofertas do que o necessário.
3. Escrever um resumo curto, em português do Brasil, direto e caloroso, para quem organiza.

Nunca invente IDs: use apenas os IDs fornecidos. Responda apenas com o JSON pedido.`;

function formatarNecessidades(necessidades) {
  if (!necessidades.length) return '(nenhum item cadastrado)';
  return necessidades
    .map((n) => `- id ${n.id}: ${n.titulo} [${n.categoria}]${n.campanha_beneficiario ? ` (campanha de ${n.campanha_beneficiario})` : ''} — ${n.status === 'recebida' ? 'JÁ RECEBEU' : 'ainda precisa'}${n.descricao ? ` — ${n.descricao}` : ''}`)
    .join('\n');
}

function formatarPedidos(pedidos) {
  if (!pedidos.length) return '(nenhum pedido aberto)';
  return pedidos
    .map((p) => `- id ${p.id}: ${p.item} [${p.categoria}]${p.cidade ? ` — ${p.cidade}` : ''}${p.descricao ? ` — ${p.descricao}` : ''}`)
    .join('\n');
}

function formatarOferta(oferta, necessidadeAtual) {
  const linhas = [
    `Item oferecido: ${oferta.item}`,
    `Categoria escolhida pelo doador: ${oferta.categoria}`,
  ];
  if (oferta.cidade) linhas.push(`Cidade do doador: ${oferta.cidade}`);
  if (oferta.descricao) linhas.push(`Detalhes: ${oferta.descricao}`);
  if (necessidadeAtual) linhas.push(`O doador escolheu na lista o item id ${necessidadeAtual.id} (${necessidadeAtual.titulo}).`);
  return linhas.join('\n');
}

function criarIa({ client, modelo = MODELO, logger = console } = {}) {
  const ativo = Boolean(client || process.env.ANTHROPIC_API_KEY);
  const anthropic = client || (ativo ? new Anthropic() : null);

  /**
   * Analisa uma oferta. Retorna { necessidade_id, resumo, sugestoes } já validados
   * contra as listas fornecidas, ou lança erro se a API falhar.
   */
  async function analisarOferta(oferta, { necessidades, pedidos }) {
    if (!ativo) throw new Error('IA desativada: defina ANTHROPIC_API_KEY');

    const necessidadeAtual = oferta.necessidade_id ? necessidades.find((n) => n.id === oferta.necessidade_id) : null;
    const prompt = [
      '## Oferta de doação',
      formatarOferta(oferta, necessidadeAtual),
      '',
      '## Lista da beneficiária',
      formatarNecessidades(necessidades),
      '',
      '## Pedidos abertos de outras pessoas',
      formatarPedidos(pedidos),
    ].join('\n');

    const resposta = await anthropic.beta.messages.create({
      model: modelo,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA_RESPOSTA } },
      messages: [{ role: 'user', content: prompt }],
    });

    if (resposta.stop_reason === 'refusal') {
      throw new Error('A IA não conseguiu analisar esta oferta.');
    }
    const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let bruto;
    try { bruto = JSON.parse(texto); } catch { throw new Error('Resposta da IA fora do formato esperado.'); }
    return validar(bruto, { necessidades, pedidos });
  }

  function validar(bruto, { necessidades, pedidos }) {
    const idsNecessidades = new Set(necessidades.map((n) => n.id));
    const idsPedidos = new Set(pedidos.map((p) => p.id));
    const necessidade_id = Number.isInteger(bruto.necessidade_id) && idsNecessidades.has(bruto.necessidade_id) ? bruto.necessidade_id : null;
    const vistos = new Set();
    const sugestoes = (Array.isArray(bruto.sugestoes) ? bruto.sugestoes : [])
      .filter((s) => s && Number.isInteger(s.pedido_id) && idsPedidos.has(s.pedido_id) && !vistos.has(s.pedido_id) && vistos.add(s.pedido_id))
      .map((s) => ({
        pedido_id: s.pedido_id,
        pontuacao: Math.max(0, Math.min(100, Number.parseInt(s.pontuacao, 10) || 0)),
        motivo: String(s.motivo || '').trim().slice(0, 300),
      }))
      .sort((a, b) => b.pontuacao - a.pontuacao)
      .slice(0, 5);
    return { necessidade_id, resumo: String(bruto.resumo || '').trim().slice(0, 600), sugestoes };
  }

  /**
   * Analisa uma oferta do banco e grava o resultado:
   *  - liga a oferta ao item da lista, se a IA identificou um;
   *  - se o item já foi recebido e o doador autorizou, marca a oferta como disponível para repasse;
   *  - salva as sugestões de repasse para o painel.
   */
  async function analisarEAplicar(db, ofertaId) {
    const oferta = db.ofertas.buscar(ofertaId);
    if (!oferta) return null;
    const necessidades = db.necessidades.listar({ apenasAtivas: true });
    const pedidos = db.pedidos.listar({ status: 'aberto' }).filter((p) => p.id !== oferta.pedido_id);

    const analise = await analisarOferta(oferta, { necessidades, pedidos });

    if (analise.necessidade_id && analise.necessidade_id !== oferta.necessidade_id) {
      db.ofertas.vincularNecessidade(ofertaId, analise.necessidade_id);
    }
    const necessidade = analise.necessidade_id ? necessidades.find((n) => n.id === analise.necessidade_id) : null;
    if (necessidade && necessidade.status === 'recebida' && oferta.status === 'nova' && oferta.autoriza_repasse) {
      db.ofertas.mudarStatus(ofertaId, 'disponivel');
    }
    db.ofertas.salvarAnaliseIa(ofertaId, analise);
    return analise;
  }

  /** Analisa várias ofertas com concorrência limitada. Erros individuais não param o lote. */
  async function analisarLote(db, ids, { concorrencia = 3 } = {}) {
    const fila = [...ids];
    const resultado = { ok: 0, erros: 0 };
    async function trabalhador() {
      while (fila.length) {
        const id = fila.shift();
        try { await analisarEAplicar(db, id); resultado.ok += 1; } catch (e) { resultado.erros += 1; logger.error(`IA: erro na oferta ${id}:`, e.message); }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concorrencia, fila.length) }, trabalhador));
    return resultado;
  }

  /** Roda a análise em segundo plano, sem nunca lançar erro. */
  function analisarEmSegundoPlano(db, ids) {
    if (!ativo || !ids.length) return;
    analisarLote(db, ids).catch((e) => logger.error('IA: erro em segundo plano:', e.message));
  }

  // ---------- triagem de verificação de identidade ----------

  /**
   * Pré-análise de um pedido de selo (redes sociais informadas + até 3 fotos).
   * Só checa se o perfil parece real e consistente. Não decide: a moderação decide.
   * Retorna { recomendacao: 'aprovar'|'revisar'|'rejeitar', resumo, ... }.
   */
  async function analisarVerificacao({ fotos = [], nome, tipo, bio, instagram, outrasRedes, cidade, observacao }) {
    if (!ativo) throw new Error('IA desativada: defina ANTHROPIC_API_KEY');
    const conteudo = [];
    fotos.forEach((f, i) => {
      conteudo.push({ type: 'text', text: `Foto ${i + 1} enviada pelo membro.` });
      conteudo.push({ type: 'image', source: { type: 'base64', media_type: f.tipo, data: f.base64 } });
    });
    conteudo.push({
      type: 'text',
      text: [
        `Tipo de perfil: ${tipo === 'empresa' ? 'empresa' : 'pessoa'}`,
        `Nome informado no cadastro: ${nome}`,
        `Cidade informada: ${cidade || '(não informada)'}`,
        `Bio: ${bio || '(vazia)'}`,
        `Instagram informado: ${instagram ? '@' + instagram : '(não informado)'}`,
        `Outras redes: ${outrasRedes || '(nenhuma)'}`,
        `Observação do membro: ${observacao || '(nenhuma)'}`,
        fotos.length ? '' : 'Nenhuma foto foi enviada: avalie só pelos dados.',
      ].join('\n'),
    });

    const resposta = await anthropic.beta.messages.create({
      model: modelo,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SISTEMA_VERIFICACAO, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ESQUEMA_VERIFICACAO } },
      messages: [{ role: 'user', content: conteudo }],
    });
    if (resposta.stop_reason === 'refusal') throw new Error('A IA não conseguiu analisar esta verificação.');
    const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let bruto;
    try { bruto = JSON.parse(texto); } catch { throw new Error('Resposta da IA fora do formato esperado.'); }
    const recomendacao = ['aprovar', 'revisar', 'rejeitar'].includes(bruto.recomendacao) ? bruto.recomendacao : 'revisar';
    return {
      recomendacao,
      resumo: String(bruto.resumo || '').trim().slice(0, 800),
      fotos_reais: String(bruto.fotos_reais || 'incerto'),
      dados_consistentes: Boolean(bruto.dados_consistentes),
      sinais_de_fraude: Array.isArray(bruto.sinais_de_fraude) ? bruto.sinais_de_fraude.map(String).slice(0, 5) : [],
    };
  }

  /** Lê as fotos da verificação, chama a IA e grava a recomendação. */
  async function analisarVerificacaoEAplicar(db, uploads, verificacaoId) {
    const fs = require('node:fs');
    const path = require('node:path');
    const v = db.verificacoes.buscar(verificacaoId);
    if (!v || v.status !== 'em_analise') return null;
    const fotos = [];
    for (const nome of v.fotos || []) {
      const caminho = uploads.caminhoPrivado(nome);
      if (!fs.existsSync(caminho)) continue;
      const ext = path.extname(caminho).toLowerCase();
      fotos.push({ base64: fs.readFileSync(caminho).toString('base64'), tipo: ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg' });
    }
    const analise = await analisarVerificacao({
      fotos, nome: v.nome, tipo: v.tipo, bio: v.bio, instagram: v.instagram, outrasRedes: v.outras_redes,
      cidade: [v.cidade, v.estado].filter(Boolean).join('/'), observacao: v.observacao,
    });
    db.verificacoes.salvarAnaliseIa(verificacaoId, { resumo: analise.resumo, recomendacao: analise.recomendacao });
    return analise;
  }

  return { ativo, modelo, analisarOferta, analisarEAplicar, analisarLote, analisarEmSegundoPlano, validar, analisarVerificacao, analisarVerificacaoEAplicar };
}

const ESQUEMA_VERIFICACAO = {
  type: 'object',
  properties: {
    fotos_reais: { type: 'string', enum: ['sim', 'provavel', 'nao', 'incerto', 'sem_fotos'], description: 'As fotos parecem de uma pessoa/empresa real (não são imagens de banco, capturas de tela, memes ou geradas).' },
    dados_consistentes: { type: 'boolean', description: 'Nome, bio, cidade e redes informadas são coerentes entre si e com as fotos.' },
    sinais_de_fraude: { type: 'array', items: { type: 'string' }, description: 'Sinais de conta falsa ou spam, se houver. Lista vazia se nada.' },
    recomendacao: { type: 'string', enum: ['aprovar', 'revisar', 'rejeitar'] },
    resumo: { type: 'string', description: 'Duas ou três frases para o moderador, em português.' },
  },
  required: ['fotos_reais', 'dados_consistentes', 'sinais_de_fraude', 'recomendacao', 'resumo'],
  additionalProperties: false,
};

const SISTEMA_VERIFICACAO = `Você faz a triagem de pedidos de selo de uma rede social brasileira de comércio e trabalho entre membros.
O membro informa suas redes sociais (Instagram e outras) e pode enviar até 3 fotos. Você não tem acesso à internet,
então não pode abrir os perfis: avalie só o que foi enviado.

Avalie apenas:
- se as fotos parecem de uma pessoa ou empresa real (não são imagens de banco, capturas de tela, memes, logos
  genéricos ou imagens geradas);
- se nome, bio, cidade e redes informadas são coerentes entre si e com as fotos (ex.: o handle do Instagram
  lembra o nome; a empresa tem cara de empresa);
- sinais de spam ou conta falsa (nome genérico, handle aleatório, texto copiado, nada de concreto).

Recomende "aprovar" quando tudo parece real e consistente, "rejeitar" quando há sinal forte de conta falsa
ou as imagens claramente não servem, e "revisar" em qualquer dúvida ou quando há pouca informação.
Nunca avalie aparência, religião ou opinião política da pessoa; isso não é critério para você.
Responda apenas com o JSON pedido.`;

module.exports = { criarIa, ESQUEMA_RESPOSTA, SISTEMA, ESQUEMA_VERIFICACAO, SISTEMA_VERIFICACAO };
