/**
 * 引擎适配层：把各家的返回统一成 { title, url, snippet?, page_age? }。
 *
 * 全部是公开的匿名/免 key 档，没有 API key、没有 SDK：
 *   - anysearch / tavily / you   纯 REST
 *   - exa / parallel / keenable  公开 MCP 端点，JSON-RPC + SSE，自己解帧
 *   - searxng                    自建实例，GET /search?format=json
 *
 * 这些端点的可用性会随对方策略变化，所以调用方必须把它们当成「可以被跳过的一层」：
 * 任何一个失败都只是少一路结果，绝不阻塞整个搜索。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MCP_ACCEPT = 'application/json, text/event-stream';

function signalWith(timeoutMs, outer) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (outer !== undefined) signals.push(outer);
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals);
}

async function request(url, init, timeoutMs, outerSignal) {
  const response = await fetch(url, { redirect: 'error', ...init, signal: signalWith(timeoutMs, outerSignal) });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    error.status = response.status;
    throw error;
  }
  return text;
}

/** MCP 流式响应的解帧：单帧 JSON 直接解析，SSE 逐帧拼 data: 后取第一个可用对象。 */
export function parseMcpText(text) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') throw new Error('empty MCP response');
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  for (const chunk of trimmed.split(/\n\n+/)) {
    const payload = chunk
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (payload === '') continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* 继续看下一帧 */ }
  }
  throw new Error('unparsable MCP response');
}

function mcpBody(tool, args) {
  return JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name: tool, arguments: args } });
}

function mcpText(json) {
  if (json?.error) throw new Error(`rpc error: ${json.error.message ?? JSON.stringify(json.error).slice(0, 120)}`);
  const blocks = (json?.result?.content ?? []).filter((block) => block?.type === 'text' && typeof block.text === 'string');
  const text = blocks.map((block) => block.text).join('\n');
  if (json?.result?.isError === true) throw new Error(`tool error: ${text.slice(0, 160)}`);
  return text;
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

function source(title, url, snippet, pageAge) {
  const href = clean(url);
  if (!/^https?:\/\//i.test(href)) return null;
  const heading = clean(title) || href;
  const body = clean(snippet).slice(0, 400);
  const rawAge = clean(pageAge);
  // ISO 时间戳只保留日期，和 Bing 那种「2026年11月20日 / 3天前」的粒度保持一致
  const iso = rawAge.match(/^(\d{4}-\d{2}-\d{2})/);
  const age = iso ? iso[1] : rawAge;
  return {
    title: heading.slice(0, 240),
    url: href,
    ...body !== '' ? { snippet: body } : {},
    .../^\d{4}-\d{2}-\d{2}$/.test(age) || /^\d{1,4}\s*(年|月|天|小时|分钟)/.test(age) ? { page_age: age.slice(0, 40) } : {},
  };
}

/** 解析 "Title: / URL: / Published: / Highlights|Snippets:" 这种文本块（Exa / Keenable）。 */
function parseLabeledBlocks(text) {
  const out = [];
  for (const block of String(text).split(/\n(?=Title:)/)) {
    const url = block.match(/^URL:\s*(\S+)$/m)?.[1];
    if (url === void 0) continue;
    const title = block.match(/^Title:\s*(.+)$/m)?.[1];
    const published = block.match(/^(?:Published|Acquired):\s*(.+)$/m)?.[1];
    const body = block.split(/^(?:Highlights|Snippets):\s*$/m)[1]
      ?.split('\n')
      .filter((line) => line.trim() !== '' && !line.trim().startsWith('...'))
      .slice(0, 3)
      .join(' ');
    const item = source(title, url, body, published);
    if (item !== null) out.push(item);
  }
  return out;
}

const anysearch = {
  id: 'anysearch',
  label: 'api.anysearch.com',
  langs: ['zh', 'en'],
  rank: 2,
  async search(query, { limit, signal }) {
    const text = await request('https://api.anysearch.com/v1/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query, max_results: limit }),
    }, 10000, signal);
    const data = JSON.parse(text);
    if (data?.code !== 0) throw new Error(`api code ${data?.code ?? '?'}: ${data?.message ?? ''}`.trim());
    return (data?.data?.results ?? [])
      .map((item) => source(item.title, item.url, item.snippet ?? item.content ?? item.description, item.date ?? item.publish_date))
      .filter(Boolean);
  },
};

const tavily = {
  id: 'tavily',
  label: 'api.tavily.com',
  langs: ['en', 'zh'],
  rank: 3,
  async search(query, { limit, signal }) {
    const text = await request('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-tavily-access-mode': 'keyless' },
      body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    }, 15000, signal);
    return (JSON.parse(text)?.results ?? [])
      .map((item) => source(item.title, item.url, item.content, item.published_date))
      .filter(Boolean);
  },
};

const you = {
  id: 'you',
  label: 'api.you.com',
  langs: ['en', 'zh'],
  rank: 4,
  async search(query, { limit, signal }) {
    const params = new URLSearchParams({ query, count: String(Math.min(Math.max(limit, 1), 20)) });
    const text = await request(`https://api.you.com/v1/agents/search?${params}`, {
      headers: { accept: 'application/json', 'user-agent': 'deepseek-harness/free-search' },
    }, 15000, signal);
    return (JSON.parse(text)?.results?.web ?? [])
      .map((item) => {
        const body = Array.isArray(item.snippets) && item.snippets.length > 0
          ? item.snippets.filter((part) => typeof part === 'string' && part !== '').join(' ')
          : item.description;
        return source(item.title, item.url, body, item.page_age ?? item.published_date);
      })
      .filter(Boolean);
  },
};

const exa = {
  id: 'exa',
  label: 'mcp.exa.ai',
  langs: ['en', 'zh'],
  rank: 1,
  async search(query, { limit, signal }) {
    const text = await request('https://mcp.exa.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: mcpBody('web_search_exa', { query, numResults: limit }),
    }, 12000, signal);
    return parseLabeledBlocks(mcpText(parseMcpText(text)));
  },
};

const parallel = {
  id: 'parallel',
  label: 'search.parallel.ai',
  langs: ['en', 'zh'],
  rank: 2,
  async search(query, { limit, signal }) {
    const text = await request('https://search.parallel.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT, 'user-agent': 'deepseek-harness/free-search' },
      body: mcpBody('web_search', { objective: query, search_queries: [query], session_id: `dsh-${Date.now().toString(16)}` }),
    }, 15000, signal);
    const body = mcpText(parseMcpText(text));
    let payload = null;
    for (const block of body.split(/\n(?=\{)/)) {
      try {
        const parsed = JSON.parse(block);
        if (Array.isArray(parsed?.results)) { payload = parsed; break; }
      } catch { /* 不是 JSON 的块跳过 */ }
    }
    if (payload === null) {
      try { payload = JSON.parse(body); } catch { payload = null; }
    }
    if (payload === null || !Array.isArray(payload.results)) throw new Error('no results array');
    return payload.results
      .map((item) => {
        const excerpt = (item.excerpts ?? []).find((entry) => clean(entry) !== '');
        return source(item.title, item.url, excerpt, item.publish_date);
      })
      .filter(Boolean)
      .slice(0, limit);
  },
};

const keenable = {
  id: 'keenable',
  label: 'api.keenable.ai',
  langs: ['zh', 'en'],
  rank: 1,
  async search(query, { limit, signal }) {
    const text = await request('https://api.keenable.ai/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: MCP_ACCEPT },
      body: mcpBody('search_web_pages', { query }),
    }, 12000, signal);
    return parseLabeledBlocks(mcpText(parseMcpText(text))).slice(0, limit);
  },
};

/** 自建 SearXNG：一个实例数组，按顺序试，第一个拿到结果的就赢。 */
function makeSearxng(instances) {
  return {
    id: 'searxng',
    label: 'searxng',
    langs: ['zh', 'en'],
    rank: 0,
    // 编排层会为它留一个专属等待窗口，不让它被更快的第三方 API 裁掉
    priority: true,
    async search(query, { limit, signal }) {
      const failures = [];
      const zh = /[\u3400-\u9fff]/.test(query);
      for (const base of instances) {
        try {
          const params = new URLSearchParams({
            q: query,
            format: 'json',
            categories: 'general',
            safesearch: '0',
            language: zh ? 'zh-CN' : 'en',
          });
          const text = await request(`${base}/search?${params}`, {
            headers: { accept: 'application/json', 'user-agent': UA },
            redirect: 'follow',
          }, 9000, signal);
          const data = JSON.parse(text);
          if (!Array.isArray(data?.results)) throw new Error('响应里没有 results 数组（多半是 format=json 没开）');
          const list = data.results
            .map((item) => source(item.title, item.url, item.content ?? item.snippet, item.publishedDate ?? item.published_date))
            .filter(Boolean)
            .slice(0, limit);
          if (list.length > 0) return list;
          failures.push(`${base}: 0 条结果`);
        } catch (error) {
          failures.push(`${base}: ${error?.message ?? error}`.slice(0, 120));
        }
      }
      throw new Error(failures.join(' | ') || 'searxng 没有配置实例');
    },
  };
}

/** 全部公共引擎，按 id 索引。 */
export const PUBLIC_ENGINES = [exa, keenable, parallel, anysearch, tavily, you];

/**
 * 按配置组装引擎列表。searxng 配了实例才注册，且排在所有公共引擎前面。
 * @param {{ searxng?: string[], engines?: string[] }} config
 */
export function buildEngines(config = {}) {
  const instances = (Array.isArray(config.searxng) ? config.searxng : [])
    .map((entry) => String(entry ?? '').trim().replace(/\/+$/, ''))
    .filter((entry) => /^https?:\/\/.+/i.test(entry));
  // 省略 engines 键 = 全部启用；显式写空数组 = 一个都不用（便于临时全关）
  const allowed = Array.isArray(config.engines)
    ? new Set(config.engines.map((id) => String(id).trim().toLowerCase()))
    : null;
  const publicOnes = PUBLIC_ENGINES.filter((engine) => allowed === null || allowed.has(engine.id));
  return [...(instances.length > 0 ? [makeSearxng(instances)] : []), ...publicOnes];
}

/** 去重用的规范化键：去锚点、去 utm/gclid/fbclid、去尾斜杠、主机小写。 */
export function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|spm$|ref_?$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    const search = url.searchParams.toString();
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}${search === '' ? '' : `?${search}`}`;
  } catch {
    return String(raw ?? '');
  }
}

export { clean, source };
