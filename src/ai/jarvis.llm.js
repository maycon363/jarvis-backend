// src/ai/jarvis.llm.js
const axios  = require('axios');
const { format, isToday, isTomorrow, parseISO, isThisWeek, isValid } = require('date-fns');
const { ptBR } = require('date-fns/locale');

const gerarPromptBase = require('./jarvis.prompt');
const { GROQ_API_KEY, TAVILY_API_KEY } = require('../config/env');

// ─── Helper de data ───────────────────────────────────────────────────────────

function formatarDataExtenso(dataISO) {
  if (!dataISO) return 'em data indefinida';
  const data = typeof dataISO === 'string' ? parseISO(dataISO) : dataISO;
  if (!isValid(data)) return 'em uma data a confirmar';
  const hora = format(data, 'HH:mm');
  if (isToday(data))    return `hoje, às ${hora}`;
  if (isTomorrow(data)) return `amanhã, às ${hora}`;
  if (isThisWeek(data, { weekStartsOn: 1 })) {
    return `este ${format(data, 'eeee', { locale: ptBR })}, às ${hora}`;
  }
  return `no dia ${format(data, "dd 'de' MMMM", { locale: ptBR })}, às ${hora}`;
}

// ─── Sanitização de resposta ──────────────────────────────────────────────────
// Remove qualquer resquício de tags de função que o modelo vaze no content.

function sanitizarResposta(texto) {
  if (!texto || typeof texto !== 'string') return texto;

  return texto
    .replace(/<function[^>]*>[\s\S]*?<\/function>/gi, '')
    .replace(/<function[^>]*\/>/gi, '')
    .replace(/<function[^>]*>/gi, '')
    .replace(/\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:[\s\S]*?\}\}/g, '')
    .replace(/\{"termo_busca"[^}]*\}/g, '')
    .replace(/\{"titulo"[^}]*\}/g, '')
    .replace(/^\s*[<{].*[>}]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ─── Detecta tool call vazada como texto (bug do LLM) ────────────────────────

function extrairToolCallDoTexto(content) {
  if (!content) return null;

  const matchTag = content.match(/<function=(\w+)>([\s\S]*?)<\/function>/i)
                || content.match(/<function=(\w+)>([\s\S]*?)(?:<|$)/i);
  if (matchTag) {
    try { return { name: matchTag[1], args: JSON.parse(matchTag[2]) }; } catch {}
  }

  const matchOpen = content.match(/<function=(\w+)>\s*(\{[\s\S]*?\})/i);
  if (matchOpen) {
    try { return { name: matchOpen[1], args: JSON.parse(matchOpen[2]) }; } catch {}
  }

  return null;
}

// ─── Pesquisa web ─────────────────────────────────────────────────────────────

async function pesquisarWeb(termo) {
  console.log(`🔍 Pesquisando: "${termo}"`);

  // Tentativa 1: Tavily
  try {
    const { data } = await axios.post(
      'https://api.tavily.com/search',
      {
        api_key:        TAVILY_API_KEY,
        query:          termo,
        search_depth:   'basic',
        include_answer: true,
        max_results:    4,
      },
      { timeout: 12_000 }
    );

    if (data.answer) {
      const fontes = (data.results ?? [])
        .slice(0, 3)
        .map(r => `Fonte: ${r.url}\n${r.content?.substring(0, 500)}`)
        .join('\n\n');
      return `Resposta direta: ${data.answer}\n\n${fontes}`;
    }

    const resultados = data.results ?? [];
    if (resultados.length === 0) return 'Nenhum resultado relevante encontrado.';

    return resultados
      .map(r => `Fonte: ${r.url}\n${r.content?.substring(0, 800)}`)
      .join('\n\n')
      .substring(0, 4000);

  } catch (err) {
    console.error('❌ Tavily falhou:', err.message);
  }

  // Tentativa 2: DuckDuckGo
  try {
    const { data } = await axios.get('https://api.duckduckgo.com/', {
      params: { q: termo, format: 'json', no_html: 1, skip_disambig: 1 },
      timeout: 8_000,
    });
    const texto = data.AbstractText || data.Answer || '';
    if (texto) return `Fonte alternativa (DuckDuckGo): ${texto}`;
  } catch (err) {
    console.error('❌ DuckDuckGo fallback falhou:', err.message);
  }

  return 'Senhor, os canais de busca estão temporariamente indisponíveis.';
}

// ─── Definição das ferramentas ────────────────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pesquisa_web',
      description:
        'Busca informações em tempo real na internet. ' +
        'Use para notícias, cotações, eventos recentes, ou qualquer dado que possa ter mudado desde seu treinamento. ' +
        'NUNCA escreva a chamada como texto — use o campo tool_calls.',
      parameters: {
        type: 'object',
        properties: {
          termo_busca: {
            type:        'string',
            description: 'Termo de busca claro e específico em português.',
          },
        },
        required: ['termo_busca'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'anotar_compromisso',
      description:
        'Registra um compromisso, lembrete ou nota. ' +
        'Use SOMENTE quando o usuário pedir explicitamente para salvar algo. ' +
        'O compromisso é salvo localmente no navegador do usuário, não em um servidor.',
      parameters: {
        type: 'object',
        properties: {
          titulo:      { type: 'string', description: 'Título curto do compromisso.' },
          detalhes:    { type: 'string', description: 'Descrição completa.' },
          data_evento: { type: 'string', description: 'Data ISO 8601 (YYYY-MM-DDTHH:mm). Omitir se não especificado.' },
          categoria:   { type: 'string', enum: ['compromisso', 'nota', 'lembrete'] },
        },
        required: ['titulo', 'detalhes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ver_agenda',
      description: 'Lista os compromissos salvos do usuário (armazenados localmente no navegador dele).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ─── Instrução anti-leak para reforçar durante tool calling ──────────────────

const ANTI_LEAK_REMINDER = {
  role:    'system',
  content: 'CRÍTICO: Ao chamar ferramentas, use EXCLUSIVAMENTE o campo tool_calls da API. NUNCA escreva chamadas de função como texto no conteúdo da mensagem. Se precisar pesquisar algo, acione pesquisa_web via tool_calls e aguarde o resultado antes de responder.',
};

// ─── Chamada ao Groq com retry ────────────────────────────────────────────────

async function chamarGroq(mensagens, usarTools = true, tentativa = 1) {
  try {
    const body = {
      model:       'openai/gpt-oss-120b',
      messages:    mensagens,
      temperature: 0.6,
      max_tokens:  800, // Reduzido: respostas mais concisas por padrão
    };

    if (usarTools) {
      body.tools       = TOOLS;
      body.tool_choice = 'auto';
    }

    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      body,
      {
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        timeout: 25_000,
      }
    );

    return data.choices[0].message;

  } catch (err) {
    const status = err.response?.status;

    if ((status === 429 || status >= 500) && tentativa < 3) {
      const espera = tentativa * 2_000;
      console.warn(`⚠️ Groq ${status} — aguardando ${espera}ms (tentativa ${tentativa})...`);
      await new Promise(r => setTimeout(r, espera));
      return chamarGroq(mensagens, usarTools, tentativa + 1);
    }

    console.error('❌ Groq erro:', err.response?.data ?? err.message);
    throw err;
  }
}

// ─── Executa uma tool pelo nome e argumentos ──────────────────────────────────
// Não há mais persistência em banco: 'anotar_compromisso' apenas monta o objeto
// e devolve para o chamador salvar (o front-end grava no localStorage).
// 'ver_agenda' lê da lista de compromissos que o cliente enviou na requisição.

function executarTool(nome, args, compromissosAtuais = []) {
  if (nome === 'pesquisa_web') {
    return pesquisarWeb(args.termo_busca ?? '').then(resultado => ({ resultado }));
  }

  if (nome === 'anotar_compromisso') {
    const novoCompromisso = {
      id:          `local_${Date.now()}`,
      titulo:      args.titulo      ?? 'Sem título',
      detalhes:    args.detalhes    ?? '',
      data_evento: args.data_evento ?? null,
      categoria:   args.categoria   ?? 'nota',
      criado_em:   new Date().toISOString(),
      concluido:   false,
    };
    return Promise.resolve({
      resultado: `Compromisso "${novoCompromisso.titulo}" registrado com sucesso.`,
      novoCompromisso,
    });
  }

  if (nome === 'ver_agenda') {
    const lista   = Array.isArray(compromissosAtuais) ? compromissosAtuais : [];
    const ativos  = lista.filter(c => !c.concluido);
    const resultado = ativos.length > 0
      ? ativos
          .map(c => `- ${c.titulo}${c.data_evento ? ' · ' + formatarDataExtenso(c.data_evento) : ''}`)
          .join('\n')
      : 'Nenhum compromisso agendado.';
    return Promise.resolve({ resultado });
  }

  return Promise.resolve({ resultado: 'Ferramenta desconhecida.' });
}

// ─── Normaliza histórico ──────────────────────────────────────────────────────
// Garante que só roles válidos com content string entrem nas mensagens.
// O histórico agora chega inteiramente do cliente (localStorage) — não há
// mais fallback de banco de dados.

function normalizarHistorico(historicoBruto) {
  const ROLES_VALIDOS = ['system', 'user', 'assistant'];
  if (!Array.isArray(historicoBruto)) return [];
  return historicoBruto
    .filter(m =>
      m &&
      ROLES_VALIDOS.includes(m.role) &&
      typeof m.content === 'string' &&
      m.content.trim().length > 0
    )
    .map(m => ({ role: m.role, content: m.content.trim() }));
}

// ─── Função principal ─────────────────────────────────────────────────────────

module.exports = async function jarvisLLM({
  pergunta,
  historico:    historicoParam    = [],
  compromissos: compromissosParam = [],
  climaContexto,
  agora,
}) {
  let novoCompromissoCriado = null;

  try {
    // 1. Histórico vem inteiramente do que o cliente mandou (localStorage).
    const historicoFinal = normalizarHistorico(historicoParam);

    // 2. Monta mensagens base com anti-leak antes da pergunta do usuário
    const mensagensBase = [
      gerarPromptBase({ agora, climaContexto }),
      ANTI_LEAK_REMINDER,
      ...historicoFinal,
      { role: 'user', content: pergunta },
    ];

    // 3. Primeira chamada ao Groq
    const choice = await chamarGroq(mensagensBase, true);
    let respostaFinal = null;

    // 4a. Tool call via campo correto (tool_calls) ─────────────────────────
    if (choice.tool_calls?.length > 0) {
      const call = choice.tool_calls[0];

      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        console.error('❌ Falha ao parsear argumentos da tool:', call.function.arguments);
      }

      console.log(`🔧 Tool (tool_calls): ${call.function.name}`, args);
      const { resultado: toolResult, novoCompromisso } = await executarTool(
        call.function.name,
        args,
        compromissosParam
      );
      if (novoCompromisso) novoCompromissoCriado = novoCompromisso;

      const mensagensComTool = [
        ...mensagensBase,
        {
          // Inclui o objeto choice inteiro para preservar tool_calls
          role:       'assistant',
          content:    choice.content ?? null,
          tool_calls: choice.tool_calls,
        },
        {
          role:         'tool',
          tool_call_id: call.id,
          name:         call.function.name,
          content:      toolResult || 'Sem resultado.',
        },
      ];

      const choiceFinal = await chamarGroq(mensagensComTool, false);
      respostaFinal = sanitizarResposta(choiceFinal.content?.trim());

    // 4b. Tool call vazou como texto (bug do LLM) — fallback de recuperação
    } else if (choice.content && extrairToolCallDoTexto(choice.content)) {
      const leaked = extrairToolCallDoTexto(choice.content);
      console.warn(`⚠️ Tool call vazou como texto: ${leaked.name}`, leaked.args);

      const { resultado: toolResult, novoCompromisso } = await executarTool(
        leaked.name,
        leaked.args,
        compromissosParam
      );
      if (novoCompromisso) novoCompromissoCriado = novoCompromisso;

      const callId = `call_recovered_${Date.now()}`;

      const mensagensComTool = [
        ...mensagensBase,
        {
          role:    'assistant',
          content: null,
          tool_calls: [{
            id:   callId,
            type: 'function',
            function: {
              name:      leaked.name,
              arguments: JSON.stringify(leaked.args),
            },
          }],
        },
        {
          role:         'tool',
          tool_call_id: callId,
          name:         leaked.name,
          content:      toolResult || 'Sem resultado.',
        },
      ];

      const choiceFinal = await chamarGroq(mensagensComTool, false);
      respostaFinal = sanitizarResposta(choiceFinal.content?.trim());
    }

    // 5. Sem tool call — resposta direta
    if (!respostaFinal) {
      respostaFinal = sanitizarResposta(choice.content?.trim())
        || 'Senhor, houve um erro no processamento.';
    }

    return {
      payload:        respostaFinal,
      type:           'message',
      novoCompromisso: novoCompromissoCriado,
    };

  } catch (err) {
    console.error('❌ Erro no JARVIS LLM:', err.response?.data ?? err.message);
    return {
      payload:        'Senhor, os protocolos principais falharam. Sistemas em diagnóstico.',
      type:           'message',
      novoCompromisso: null,
    };
  }
};