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

const SISTEMA = `Você ajuda a organizar uma campanha de doações chamada "Corrente do Bem".
Uma pessoa (a beneficiária) viralizou e muita gente quer doar para ela. Ela tem uma lista de itens
que ainda precisa e itens que já recebeu. Quando alguém oferece algo que ela já recebeu, a doação
deve ser repassada para outra pessoa que registrou um pedido de ajuda.

Sua tarefa, dada uma oferta de doação:
1. Dizer a qual item da lista da beneficiária a oferta corresponde (necessidade_id), considerando
   sinônimos, variações regionais e descrições informais ("prótese dentária" = "dentadura",
   "rancho" = "cesta básica", "remédio de pressão" = "Losartana"). Se não corresponder a nenhum, null.
   Se a oferta já vier ligada a um item, mantenha esse item a menos que esteja claramente errado.
2. Listar os pedidos de outras pessoas que essa doação atende, do melhor para o pior, com pontuação
   de 0 a 100 e um motivo curto. Considere: o item é o mesmo ou serve para o mesmo fim; categoria;
   proximidade de cidade (entrega mais fácil); urgência descrita no pedido. Só inclua pedidos com
   pontuação 40 ou mais. Dinheiro/Pix pode atender quase qualquer pedido, mas priorize pedidos
   onde dinheiro resolve (remédio, conta, transporte).
   Liste sugestões mesmo quando o item ainda está aberto na lista da beneficiária: a organização
   pode ter mais ofertas do que o necessário e vai precisar repassar o excedente.
3. Escrever um resumo curto, em português do Brasil, direto e caloroso, para quem organiza.

Nunca invente IDs: use apenas os IDs fornecidos. Responda apenas com o JSON pedido.`;

function formatarNecessidades(necessidades) {
  if (!necessidades.length) return '(nenhum item cadastrado)';
  return necessidades
    .map((n) => `- id ${n.id}: ${n.titulo} [${n.categoria}] — ${n.status === 'recebida' ? 'JÁ RECEBEU' : 'ainda precisa'}${n.descricao ? ` — ${n.descricao}` : ''}`)
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
    const necessidades = db.necessidades.listar();
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
   * Pré-análise de uma verificação (selfie com documento + foto do documento + Instagram).
   * Só checa qualidade e coerência das imagens. Não decide: a moderação decide.
   * Retorna { recomendacao: 'aprovar'|'revisar'|'rejeitar', resumo, ... }.
   */
  async function analisarVerificacao({ selfieBase64, selfieTipo, documentoBase64, documentoTipo, nome, instagram, cidade, convidadoPor }) {
    if (!ativo) throw new Error('IA desativada: defina ANTHROPIC_API_KEY');
    const conteudo = [];
    if (selfieBase64) {
      conteudo.push({ type: 'text', text: 'Imagem 1: selfie da pessoa segurando o documento.' });
      conteudo.push({ type: 'image', source: { type: 'base64', media_type: selfieTipo, data: selfieBase64 } });
    }
    if (documentoBase64) {
      conteudo.push({ type: 'text', text: 'Imagem 2: foto do documento (RG ou CNH).' });
      conteudo.push({ type: 'image', source: { type: 'base64', media_type: documentoTipo, data: documentoBase64 } });
    }
    conteudo.push({
      type: 'text',
      text: [
        `Nome informado no cadastro: ${nome}`,
        `Cidade informada: ${cidade || '(não informada)'}`,
        `Instagram informado: ${instagram ? '@' + instagram : '(não informado)'}`,
        `Entrou por convite de membro verificado: ${convidadoPor ? 'sim' : 'não'}`,
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
      documento_legivel: Boolean(bruto.documento_legivel),
      rosto_visivel: Boolean(bruto.rosto_visivel),
      mesma_pessoa: String(bruto.mesma_pessoa || 'incerto'),
      nome_confere: String(bruto.nome_confere || 'incerto'),
    };
  }

  /** Lê as imagens da verificação, chama a IA e grava a recomendação. */
  async function analisarVerificacaoEAplicar(db, uploads, verificacaoId) {
    const fs = require('node:fs');
    const path = require('node:path');
    const v = db.verificacoes.buscar(verificacaoId);
    if (!v || v.status !== 'em_analise') return null;
    const ler = (nome) => {
      if (!nome) return null;
      const caminho = uploads.caminhoPrivado(nome);
      if (!fs.existsSync(caminho)) return null;
      const ext = path.extname(caminho).toLowerCase();
      const tipo = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { base64: fs.readFileSync(caminho).toString('base64'), tipo };
    };
    const selfie = ler(v.selfie);
    const documento = ler(v.documento);
    const analise = await analisarVerificacao({
      selfieBase64: selfie && selfie.base64, selfieTipo: selfie && selfie.tipo,
      documentoBase64: documento && documento.base64, documentoTipo: documento && documento.tipo,
      nome: v.nome, instagram: v.instagram, cidade: [v.cidade, v.estado].filter(Boolean).join('/'), convidadoPor: v.convidado_por,
    });
    db.verificacoes.salvarAnaliseIa(verificacaoId, { resumo: analise.resumo, recomendacao: analise.recomendacao });
    return analise;
  }

  return { ativo, modelo, analisarOferta, analisarEAplicar, analisarLote, analisarEmSegundoPlano, validar, analisarVerificacao, analisarVerificacaoEAplicar };
}

const ESQUEMA_VERIFICACAO = {
  type: 'object',
  properties: {
    documento_legivel: { type: 'boolean', description: 'A foto do documento está nítida e dá para ler nome e foto.' },
    rosto_visivel: { type: 'boolean', description: 'Na selfie aparece um rosto real segurando um documento.' },
    mesma_pessoa: { type: 'string', enum: ['sim', 'provavel', 'nao', 'incerto'], description: 'A pessoa da selfie parece ser a mesma da foto do documento.' },
    nome_confere: { type: 'string', enum: ['sim', 'nao', 'incerto'], description: 'O nome legível no documento bate com o nome do cadastro.' },
    recomendacao: { type: 'string', enum: ['aprovar', 'revisar', 'rejeitar'] },
    resumo: { type: 'string', description: 'Duas ou três frases para o moderador, em português, sem transcrever números do documento.' },
  },
  required: ['documento_legivel', 'rosto_visivel', 'mesma_pessoa', 'nome_confere', 'recomendacao', 'resumo'],
  additionalProperties: false,
};

const SISTEMA_VERIFICACAO = `Você faz a triagem de verificações de identidade de uma rede social brasileira.
Cada verificação tem uma selfie da pessoa segurando um documento e uma foto do documento (RG ou CNH).

Avalie apenas:
- se o documento está legível (nome e foto visíveis);
- se a selfie mostra um rosto real segurando um documento (não é foto de tela, não é imagem baixada);
- se a pessoa da selfie parece a mesma da foto do documento;
- se o nome do documento bate com o nome do cadastro (empresas podem cadastrar o nome do responsável).

Recomende "aprovar" quando tudo confere com clareza, "rejeitar" quando há sinal forte de fraude ou as imagens
não servem (ilegíveis, não é documento, não é selfie), e "revisar" em qualquer dúvida.
Nunca avalie aparência, opinião, religião ou política da pessoa; isso não é critério.
No resumo, nunca transcreva números de documento, CPF ou endereço. Responda apenas com o JSON pedido.`;

module.exports = { criarIa, ESQUEMA_RESPOSTA, SISTEMA, ESQUEMA_VERIFICACAO, SISTEMA_VERIFICACAO };
