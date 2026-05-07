// services/ia.js — abstração de provedor de IA (chat completion).
//
// Suporta dois providers, controlado por env:
//   IA_PROVIDER=openai      (default, mais barato — GPT-4o-mini)
//   IA_PROVIDER=anthropic   (Claude — melhor narrativa em PT-BR, ~15x mais caro)
//
// Ambos exportam a mesma interface:
//   chat({ system, messages, maxTokens, temperature, jsonMode }) -> { text, model, tokensIn, tokensOut, custo }
//   chatJson({ system, messages, ... })                          -> { ...chat, dados (object parseado) }
//
// Sem SDK — fetch nativo do Node 22.

const PROVIDER = (process.env.IA_PROVIDER || 'openai').toLowerCase();

// Tabela de pricing (USD por milhao de tokens). Mantenha atualizada.
const PRECOS = {
  // OpenAI
  'gpt-4o-mini':                { in: 0.15, out: 0.60 },
  'gpt-4o':                     { in: 2.50, out: 10.00 },
  'gpt-4o-2024-08-06':          { in: 2.50, out: 10.00 },
  // Anthropic
  'claude-sonnet-4-5-20250929': { in: 3,    out: 15 },
  'claude-sonnet-4-6':          { in: 3,    out: 15 },
  'claude-haiku-4-5-20251001':  { in: 1,    out: 5 },
  'claude-opus-4-7':            { in: 15,   out: 75 }
};

const calcularCusto = (modelo, tokensIn, tokensOut) => {
  const p = PRECOS[modelo];
  if (!p) return 0;
  return (tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out;
};

// ============ OpenAI adapter ============
const DEFAULT_MODEL_OPENAI = process.env.OPENAI_MODEL || 'gpt-4o-mini';

async function chatOpenAI ({ system, messages, model, maxTokens = 4000, temperature = 0.3, jsonMode = true } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY nao configurada no .env');

  const usedModel = model || DEFAULT_MODEL_OPENAI;
  const msgs = [];
  if (system) msgs.push({ role: 'system', content: system });
  for (const m of messages) msgs.push({ role: m.role, content: m.content });

  const body = {
    model: usedModel,
    messages: msgs,
    max_tokens: maxTokens,
    temperature
  };
  // JSON mode formal do OpenAI — exige a palavra "json" em alguma message
  if (jsonMode) {
    body.response_format = { type: 'json_object' };
    if (!msgs.some(m => /json/i.test(m.content))) {
      msgs[0].content += '\n\nResponda APENAS com JSON valido.';
    }
  }

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const txt = await r.text();
  if (!r.ok) {
    let detalhe = txt;
    try { detalhe = JSON.parse(txt)?.error?.message || txt; } catch {}
    throw new Error(`OpenAI ${r.status}: ${detalhe.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error('OpenAI respondeu com JSON invalido.'); }

  const text = json.choices?.[0]?.message?.content || '';
  const u = json.usage || {};
  const tokensIn  = u.prompt_tokens     || 0;
  const tokensOut = u.completion_tokens || 0;
  return { text, model: usedModel, tokensIn, tokensOut, custo: calcularCusto(usedModel, tokensIn, tokensOut) };
}

// ============ Anthropic adapter ============
const DEFAULT_MODEL_ANTHROPIC = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

async function chatAnthropic ({ system, messages, model, maxTokens = 4000, temperature = 0.3, jsonMode = true } = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY nao configurada no .env');

  const usedModel = model || DEFAULT_MODEL_ANTHROPIC;
  let sys = system || '';
  if (jsonMode) {
    sys += '\n\nIMPORTANTE: Responda EXCLUSIVAMENTE com um objeto JSON valido. Sem markdown, sem texto antes/depois, sem ```json. Apenas o JSON puro.';
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: usedModel,
      max_tokens: maxTokens,
      temperature,
      system: sys || undefined,
      messages: messages.map(m => ({ role: m.role, content: m.content }))
    })
  });
  const txt = await r.text();
  if (!r.ok) {
    let detalhe = txt;
    try { detalhe = JSON.parse(txt)?.error?.message || txt; } catch {}
    throw new Error(`Anthropic ${r.status}: ${detalhe.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(txt); } catch { throw new Error('Anthropic respondeu com JSON invalido.'); }

  const text = (json.content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  const u = json.usage || {};
  const tokensIn  = u.input_tokens  || 0;
  const tokensOut = u.output_tokens || 0;
  return { text, model: usedModel, tokensIn, tokensOut, custo: calcularCusto(usedModel, tokensIn, tokensOut) };
}

// ============ Roteamento + parser JSON ============
async function chat (opts) {
  if (PROVIDER === 'anthropic') return chatAnthropic(opts);
  return chatOpenAI(opts);
}

async function chatJson (opts) {
  const r = await chat({ ...opts, jsonMode: true });
  let raw = (r.text || '').trim();
  // Tolera ```json ... ``` que algum modelo possa devolver mesmo em JSON mode
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Se o modelo prepender texto, isola o objeto
  const inicio = raw.indexOf('{');
  const fim = raw.lastIndexOf('}');
  if (inicio > 0 && fim > inicio) raw = raw.slice(inicio, fim + 1);
  let dados;
  try { dados = JSON.parse(raw); }
  catch (e) { throw new Error('Resposta da IA nao eh JSON valido: ' + e.message + '\n---\n' + (r.text || '').slice(0, 400)); }
  return { ...r, dados };
}

module.exports = { chat, chatJson, PROVIDER, PRECOS };
