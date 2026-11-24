// src/llm.js : client IA universel (aucune dépendance, fetch natif de Node 20+).
//
// Trois formats sont pris en charge :
//  - "anthropic" : API Claude native (LLM_PROVIDER=anthropic)
//  - "openai"    : tout service compatible OpenAI /chat/completions : OpenAI, Groq, OpenRouter,
//                  Mistral, DeepSeek, Together, Gemini, xAI, Ollama, LM Studio, vLLM...
//  - "raw"       : n'importe quelle autre API HTTP, décrite par un modèle JSON dans le .env
//
// Les outils (tool calling) passent par l'API native quand elle les gère. Sinon, LLM_TOOLS=prompt
// les simule par un JSON dans le texte : le robot marche alors même avec un modèle sans tool calling.

const PRESETS = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  together: 'https://api.together.xyz/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  xai: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434/v1',
  lmstudio: 'http://localhost:1234/v1'
};

const KEYLESS = ['ollama', 'lmstudio', 'custom', 'raw'];

const env = (k, d = '') => {
  const v = process.env[k];
  return v === undefined || v.trim() === '' ? d : v.trim();
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function config() {
  let provider = env('LLM_PROVIDER').toLowerCase();
  if (!provider) {
    if (env('ANTHROPIC_API_KEY') && !env('LLM_API_KEY')) provider = 'anthropic';
    else if (env('OPENAI_API_KEY') && !env('LLM_API_KEY')) provider = 'openai';
    else if (env('LLM_BASE_URL')) provider = 'custom';
    else throw new Error('Aucune IA configurée : renseigne LLM_PROVIDER, LLM_API_KEY et LLM_MODEL dans le .env');
  }
  const format = provider === 'raw' ? 'raw'
    : (provider === 'anthropic' || env('LLM_FORMAT').toLowerCase() === 'anthropic') ? 'anthropic'
    : 'openai';
  const apiKey = env('LLM_API_KEY')
    || (provider === 'anthropic' ? env('ANTHROPIC_API_KEY') : provider === 'openai' ? env('OPENAI_API_KEY') : '');
  const model = env('LLM_MODEL') || env('MODEL');
  const baseUrl = env('LLM_BASE_URL') || PRESETS[provider] || (format === 'anthropic' ? 'https://api.anthropic.com' : '');

  if (!apiKey && !KEYLESS.includes(provider)) throw new Error(`LLM_API_KEY manquante pour le fournisseur "${provider}"`);
  if (!baseUrl) throw new Error('LLM_BASE_URL est obligatoire pour ce fournisseur (adresse de l\'API)');
  if (!model && format !== 'raw') throw new Error('LLM_MODEL manquant : indique le nom du modèle à utiliser');

  return {
    provider, format, apiKey, model, baseUrl,
    tools: env('LLM_TOOLS', format === 'raw' ? 'prompt' : 'native').toLowerCase(),
    timeoutMs: Number(env('LLM_TIMEOUT_MS', '120000')),
    maxTokensParam: env('LLM_MAX_TOKENS_PARAM', 'max_tokens')
  };
}

export function describeLlm() {
  const c = config();
  return `${c.provider} · modèle ${c.model || '(défini par le modèle JSON)'} · format ${c.format} · outils ${c.tools}`;
}

// ---------- HTTP ----------

async function http(url, { method = 'POST', headers = {}, body }, timeoutMs) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await res.text();
      if (res.ok) {
        try { return JSON.parse(text); } catch { return { __text: text }; }
      }
      const err = new Error(`API ${res.status} : ${text.slice(0, 300)}`);
      err.status = res.status;
      err.body = text;
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { lastErr = err; await sleep(1500 * (attempt + 1)); continue; }
      throw err;
    } catch (e) {
      if (e.status) throw e;
      lastErr = e;
      if (attempt < 2) { await sleep(1500 * (attempt + 1)); continue; }
      throw e;
    }
  }
  throw lastErr;
}

const joinUrl = (base, suffix) => {
  const b = base.replace(/\/+$/, '');
  return b.endsWith('/v1') && suffix.startsWith('/v1/') ? b + suffix.slice(3) : b + suffix;
};

function extraHeaders() {
  const raw = env('LLM_HEADERS');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('LLM_HEADERS doit être un JSON valide'); }
}

// ---------- Anthropic ----------

function toAnthropic(messages) {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} });
      return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(vide)' }] };
    }
    return {
      role: 'user',
      content: m.results.map(r => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.content ?? '') || '(vide)' }))
    };
  });
}

async function callAnthropic(c, { system, messages, tools, maxTokens }) {
  const body = { model: c.model, max_tokens: maxTokens, messages: toAnthropic(messages) };
  if (system) body.system = system;
  if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const data = await http(joinUrl(c.baseUrl, '/v1/messages'), {
    headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', ...extraHeaders() },
    body
  }, c.timeoutMs);
  const blocks = data.content || [];
  return {
    text: blocks.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input || {} }))
  };
}

// ---------- OpenAI-compatible ----------

function toOpenAI(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map(c => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input || {}) }
        }));
      }
      out.push(msg);
    } else {
      for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') || '(vide)' });
    }
  }
  return out;
}

async function callOpenAI(c, { system, messages, tools, maxTokens }) {
  const build = param => {
    const body = { model: c.model, messages: toOpenAI(system, messages), [param]: maxTokens };
    if (tools.length) {
      body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    return body;
  };
  const headers = { ...(c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {}), ...extraHeaders() };
  const url = joinUrl(c.baseUrl, '/v1/chat/completions');
  let data;
  try {
    data = await http(url, { headers, body: build(c.maxTokensParam) }, c.timeoutMs);
  } catch (e) {
    // Certains modèles récents exigent max_completion_tokens au lieu de max_tokens
    if (e.status === 400 && /max_completion_tokens/.test(e.body || '') && c.maxTokensParam !== 'max_completion_tokens') {
      data = await http(url, { headers, body: build('max_completion_tokens') }, c.timeoutMs);
    } else throw e;
  }
  if (data.error && !data.choices) throw new Error('API : ' + (data.error.message || JSON.stringify(data.error)));
  const msg = data.choices?.[0]?.message || {};
  let text = msg.content;
  if (Array.isArray(text)) text = text.map(p => p.text || '').join('');
  const toolCalls = (msg.tool_calls || []).map((tc, i) => {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* arguments invalides */ }
    return { id: tc.id || `call_${Date.now()}_${i}`, name: tc.function?.name, input };
  });
  return { text: text || '', toolCalls };
}

// ---------- Raw : n'importe quelle API HTTP ----------
// LLM_BASE_URL         adresse complète (peut contenir {{key}} et {{model}})
// LLM_REQUEST_TEMPLATE corps JSON avec {{prompt}}, {{system}}, {{model}}, {{key}}, {{max_tokens}}
// LLM_HEADERS          en-têtes JSON (défaut : Authorization: Bearer <clé>)
// LLM_RESPONSE_PATH    chemin du texte dans la réponse, ex. choices.0.message.content

function fill(node, vars) {
  if (typeof node === 'string') {
    const exact = node.match(/^\{\{(\w+)\}\}$/);
    if (exact) return vars[exact[1]] ?? '';
    return node.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
  }
  if (Array.isArray(node)) return node.map(n => fill(n, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v, vars)]));
  return node;
}

export function getPath(obj, path) {
  return path.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

const COMMON_PATHS = [
  'choices.0.message.content', 'content.0.text', 'candidates.0.content.parts.0.text',
  'output_text', 'text', 'response', 'output', 'message.content', 'message', 'result', 'answer', 'data'
];

function toTranscript(messages) {
  return messages
    .map(m => `${m.role === 'user' ? 'Utilisateur' : 'Assistant'} : ${m.role === 'user' ? m.content : m.text}`)
    .join('\n\n') + '\n\nAssistant :';
}

async function callRaw(c, { system, messages, maxTokens }) {
  const tpl = env('LLM_REQUEST_TEMPLATE');
  if (!tpl) throw new Error('LLM_REQUEST_TEMPLATE est obligatoire avec LLM_PROVIDER=raw');
  let template;
  try { template = JSON.parse(tpl); } catch { throw new Error('LLM_REQUEST_TEMPLATE doit être un JSON valide'); }
  const usesSystem = tpl.includes('{{system}}');
  let prompt = toTranscript(messages);
  if (!usesSystem && system) prompt = system + '\n\n' + prompt;
  const vars = { prompt, system, model: c.model, key: c.apiKey, max_tokens: maxTokens };

  const url = fill(c.baseUrl, vars);
  const headers = env('LLM_HEADERS')
    ? fill(extraHeaders(), vars)
    : (c.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {});
  const data = await http(url, { headers, body: fill(template, vars) }, c.timeoutMs);
  if (data.__text !== undefined) return { text: data.__text, toolCalls: [] };

  const path = env('LLM_RESPONSE_PATH');
  let text = path ? getPath(data, path) : undefined;
  if (text === undefined && !path) {
    for (const p of COMMON_PATHS) {
      const v = getPath(data, p);
      if (typeof v === 'string') { text = v; break; }
    }
  }
  if (typeof text !== 'string') {
    throw new Error('Réponse illisible : ajuste LLM_RESPONSE_PATH. Réponse reçue : ' + JSON.stringify(data).slice(0, 300));
  }
  return { text, toolCalls: [] };
}

// ---------- Outils simulés par le prompt ----------

function toolPrompt(tools) {
  const list = tools.map(t => {
    const props = JSON.stringify(t.input_schema?.properties || {});
    const req = (t.input_schema?.required || []).join(', ') || 'aucun';
    return `- ${t.name} : ${t.description} Arguments : ${props} ; obligatoires : ${req}`;
  }).join('\n');
  return `\n\nOUTILS DISPONIBLES :\n${list}\n\n` +
    'Pour utiliser un outil, réponds UNIQUEMENT avec un objet JSON, sans aucun texte autour : ' +
    '{"outil":"nom_de_l_outil","arguments":{...}}\n' +
    'Un seul outil à la fois. Quand le résultat de l\'outil arrive, continue ou réponds en texte simple. ' +
    'Si tu n\'as pas besoin d\'outil, réponds directement en texte.';
}

function toPlain(messages) {
  return messages.map(m => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push(m.text);
      for (const c of m.toolCalls || []) parts.push(JSON.stringify({ outil: c.name, arguments: c.input }));
      return { role: 'assistant', text: parts.join('\n') || '(vide)' };
    }
    return { role: 'user', content: m.results.map(r => `Résultat de l'outil ${r.name} :\n${r.content}`).join('\n\n') };
  });
}

function* jsonObjects(text) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { yield { obj: JSON.parse(text.slice(i, j + 1)), start: i, end: j + 1 }; } catch { /* pas du JSON */ }
          break;
        }
      }
    }
  }
}

let callCounter = 0;
function parseToolCall(text, tools) {
  const names = new Set(tools.map(t => t.name));
  for (const { obj, start, end } of jsonObjects(text)) {
    const name = obj.outil || obj.tool || obj.name;
    if (typeof name === 'string' && names.has(name)) {
      const input = obj.arguments || obj.input || obj.parametres || {};
      const rest = (text.slice(0, start) + text.slice(end)).replace(/```(?:json)?/gi, '').trim();
      return { text: rest, toolCalls: [{ id: `call_${++callCounter}`, name, input }] };
    }
  }
  return { text, toolCalls: [] };
}

// ---------- API publique ----------

const clean = t => String(t || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

/**
 * Messages (format neutre) :
 *   { role:'user', content }
 *   { role:'assistant', text, toolCalls:[{id,name,input}] }
 *   { role:'tool', results:[{id,name,content}] }
 * Retourne { text, toolCalls }.
 */
export async function chat({ system = '', messages, tools = [], maxTokens = 2000 }) {
  const c = config();
  const simulate = tools.length > 0 && (c.tools === 'prompt' || c.format === 'raw');
  let sys = system, msgs = messages, toolList = tools;
  if (simulate) { sys = system + toolPrompt(tools); msgs = toPlain(messages); toolList = []; }

  const send = c.format === 'anthropic' ? callAnthropic : c.format === 'raw' ? callRaw : callOpenAI;
  const out = await send(c, { system: sys, messages: msgs, tools: toolList, maxTokens });
  out.text = clean(out.text);
  return simulate ? parseToolCall(out.text, tools) : out;
}

export async function ask(prompt, { system = '', maxTokens = 2000 } = {}) {
  const { text } = await chat({ system, messages: [{ role: 'user', content: prompt }], maxTokens });
  return text;
}

export function extractJsonArray(text) {
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a === -1 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}
