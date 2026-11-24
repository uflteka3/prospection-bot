// src/websearch.js : recherche web universelle (aucune dépendance).
// Fournisseurs : serper, brave, tavily, searxng, duckduckgo (sans clé) et custom (n'importe quelle API).
// Chaque fournisseur renvoie la même forme : [{ title, link, snippet }].

import { getPath } from './llm.js';

const env = (k, d = '') => {
  const v = process.env[k];
  return v === undefined || v.trim() === '' ? d : v.trim();
};

export function searchConfig() {
  let provider = env('SEARCH_PROVIDER').toLowerCase();
  const key = env('SEARCH_API_KEY');
  if (!provider) {
    if (env('SERPER_API_KEY')) provider = 'serper';
    else if (env('BRAVE_API_KEY')) provider = 'brave';
    else if (env('TAVILY_API_KEY')) provider = 'tavily';
    else if (env('SEARCH_URL')) provider = 'custom';
    else if (env('SEARCH_BASE_URL')) provider = 'searxng';
    else provider = 'duckduckgo';
  }
  const apiKey = key || env({ serper: 'SERPER_API_KEY', brave: 'BRAVE_API_KEY', tavily: 'TAVILY_API_KEY' }[provider] || 'SEARCH_API_KEY');
  return { provider, apiKey, baseUrl: env('SEARCH_BASE_URL'), country: env('SEARCH_COUNTRY', 'bf'), lang: env('SEARCH_LANG', 'fr') };
}

export function describeSearch() {
  const c = searchConfig();
  return `${c.provider}${c.apiKey || c.provider === 'duckduckgo' || c.provider === 'searxng' ? '' : ' (clé manquante)'}`;
}

async function request(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DiaoProspectionBot/1.0)', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Recherche web ${res.status} : ${text.slice(0, 200)}`);
  return text;
}

const asJson = text => { try { return JSON.parse(text); } catch { return null; } };
const norm = r => ({ title: String(r.title || '').trim(), link: String(r.link || '').trim(), snippet: String(r.snippet || '').trim() });

// ---------- DuckDuckGo (sans clé, meilleur effort) ----------

const decodeEntities = s => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
const stripTags = s => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseDuckDuckGo(html) {
  const out = [];
  const anchors = [...html.matchAll(/<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g)];
  anchors.forEach((m, i) => {
    const href = (m[0].match(/href="([^"]*)"/) || [])[1] || '';
    let link = decodeEntities(href);
    const uddg = link.match(/[?&]uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
    else if (link.startsWith('//')) link = 'https:' + link;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const segment = html.slice(m.index + m[0].length, end);
    const sm = segment.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/);
    out.push({ title: stripTags(m[1]), link, snippet: sm ? stripTags(sm[1]) : '' });
  });
  return out;
}

// ---------- Fournisseurs ----------

const providers = {
  async serper(q, c, num) {
    const data = asJson(await request(c.baseUrl || 'https://google.serper.dev/search', {
      method: 'POST', headers: { 'X-API-KEY': c.apiKey }, body: { q, gl: c.country, hl: c.lang, num }
    }));
    return (data?.organic || []).map(r => ({ title: r.title, link: r.link, snippet: r.snippet }));
  },
  async brave(q, c, num) {
    const url = `${c.baseUrl || 'https://api.search.brave.com/res/v1/web/search'}?q=${encodeURIComponent(q)}&count=${Math.min(num, 20)}&search_lang=${c.lang}`;
    const data = asJson(await request(url, { headers: { 'X-Subscription-Token': c.apiKey, Accept: 'application/json' } }));
    return (data?.web?.results || []).map(r => ({ title: r.title, link: r.url, snippet: r.description }));
  },
  async tavily(q, c, num) {
    const data = asJson(await request(c.baseUrl || 'https://api.tavily.com/search', {
      method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: { query: q, max_results: Math.min(num, 20) }
    }));
    return (data?.results || []).map(r => ({ title: r.title, link: r.url, snippet: r.content }));
  },
  async searxng(q, c) {
    const base = (c.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('SEARCH_BASE_URL manquante pour searxng');
    const data = asJson(await request(`${base}/search?q=${encodeURIComponent(q)}&format=json&language=${c.lang}`));
    return (data?.results || []).map(r => ({ title: r.title, link: r.url, snippet: r.content }));
  },
  async duckduckgo(q) {
    const html = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=fr-fr`);
    const list = parseDuckDuckGo(html);
    if (!list.length) throw new Error('DuckDuckGo n\'a rien renvoyé (blocage possible). Configure une clé Serper, Brave ou Tavily.');
    return list;
  },
  // Toute autre API : SEARCH_URL avec {query} et {key}, SEARCH_METHOD, SEARCH_BODY, SEARCH_HEADERS,
  // SEARCH_RESULTS_PATH, SEARCH_TITLE_FIELD, SEARCH_LINK_FIELD, SEARCH_SNIPPET_FIELD
  async custom(q, c, num) {
    const tpl = env('SEARCH_URL');
    if (!tpl) throw new Error('SEARCH_URL manquante pour le fournisseur custom');
    const fill = s => s.replaceAll('{query}', encodeURIComponent(q)).replaceAll('{key}', c.apiKey).replaceAll('{num}', String(num));
    const fillJson = node => typeof node === 'string' ? node.replaceAll('{query}', q).replaceAll('{key}', c.apiKey).replaceAll('{num}', String(num))
      : Array.isArray(node) ? node.map(fillJson)
      : node && typeof node === 'object' ? Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillJson(v)])) : node;
    const method = env('SEARCH_METHOD', 'GET').toUpperCase();
    const headers = env('SEARCH_HEADERS') ? fillJson(JSON.parse(env('SEARCH_HEADERS'))) : {};
    const body = method === 'POST' && env('SEARCH_BODY') ? fillJson(JSON.parse(env('SEARCH_BODY'))) : undefined;
    const text = await request(fill(tpl), { method, headers, body });
    const data = asJson(text);
    if (!data) return [{ title: '', link: '', snippet: text.slice(0, 4000) }];

    let arr = env('SEARCH_RESULTS_PATH') ? getPath(data, env('SEARCH_RESULTS_PATH')) : undefined;
    if (!Array.isArray(arr)) {
      arr = Array.isArray(data) ? data
        : ['organic', 'results', 'web.results', 'items', 'data'].map(p => getPath(data, p)).find(Array.isArray);
    }
    if (!Array.isArray(arr)) return [{ title: '', link: '', snippet: JSON.stringify(data).slice(0, 4000) }];

    const pick = (o, field, fallbacks) => [field, ...fallbacks].filter(Boolean).map(f => o[f]).find(v => typeof v === 'string') || '';
    return arr.map(o => ({
      title: pick(o, env('SEARCH_TITLE_FIELD'), ['title', 'name']),
      link: pick(o, env('SEARCH_LINK_FIELD'), ['link', 'url', 'href']),
      snippet: pick(o, env('SEARCH_SNIPPET_FIELD'), ['snippet', 'description', 'content', 'body', 'text'])
    }));
  }
};

export async function webSearch(query, { num = 20 } = {}) {
  const c = searchConfig();
  const fn = providers[c.provider];
  if (!fn) throw new Error(`Fournisseur de recherche inconnu : ${c.provider} (serper, brave, tavily, searxng, duckduckgo, custom)`);
  if (!c.apiKey && ['serper', 'brave', 'tavily'].includes(c.provider)) {
    throw new Error(`Clé API manquante pour la recherche "${c.provider}" (SEARCH_API_KEY)`);
  }
  const seen = new Set();
  return (await fn(query, c, num)).map(norm).filter(r => {
    const k = r.link || r.snippet;
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
