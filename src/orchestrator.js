/**
 * 编排层：并发跑多路引擎，先回先合并，按 URL 去重，失败按原因冷却。
 *
 * 规则：
 *   - 主层 = 传入的引擎列表（自建 SearXNG 若配置则会带 priority 标记）；
 *   - 普通引擎先回先合并，单引擎最多贡献 perEngineCap 条，避免第一个回来的垄断列表；
 *   - 优先级引擎有专属等待窗口（priorityWaitMs），结果排在列表最前面；
 *   - 不足 minResults 条时先补跑剩余引擎（extraBudgetMs），仍不足才走 HTML 兜底
 *     （DuckDuckGo Lite → Bing → Bing 中国站）；
 *   - 失败按原因冷却：401/403 60min、402 60min、429 10min、超时 2min、其它 5min、空结果 60s。
 *     凑满结果后我们自己 abort 掉的慢引擎不算失败，不冷却。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULTS = {
  budgetMs: 5200,
  extraBudgetMs: 2500,
  priorityWaitMs: 2400,
  minResults: 3,
  perEngineCap: 5,
  priorityTake: 6,
  fallbackHtml: true,
  fetchTimeoutMs: 15000,
};

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', middot: '·', bull: '•',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
};

function safeCodePoint(code) {
  try { return String.fromCodePoint(code); } catch { return ''; }
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => NAMED[name.toLowerCase()] ?? whole);
}

function stripTags(html) {
  let text = decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/[\u200b-\u200f\ufeff]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  // 中文（含中文标点）两侧被标签撑出来的空格去掉，否则标题会变成 “桌面 客户端”
  return text
    .replace(/([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])\s+/g, '$1')
    .replace(/\s+([\u3000-\u303f\u4e00-\u9fff\uff00-\uffef])/g, '$1');
}

function unwrapDdgLink(href) {
  let full = href.trim();
  if (full.startsWith('//')) full = `https:${full}`;
  try {
    const url = new URL(full);
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname) && url.pathname.startsWith('/l/')) {
      const target = url.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : null;
    }
    return /^https?:\/\//i.test(full) ? full : null;
  } catch {
    return null;
  }
}

function unwrapBingLink(href) {
  let full = href.trim();
  if (full.startsWith('//')) full = `https:${full}`;
  try {
    const url = new URL(full);
    if (!/(^|\.)bing\.com$/i.test(url.hostname) || !url.pathname.startsWith('/ck/a')) {
      return /^https?:\/\//i.test(full) ? full : null;
    }
    const raw = url.searchParams.get('u');
    if (!raw || !raw.startsWith('a1')) return null;
    const decoded = Buffer.from(raw.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function pickPageAge(html) {
  const m = html.match(/(\d{4}年\d{1,2}月\d{1,2}日|\d{1,2}\s*(?:分钟|小时|天|周|个月)前|[A-Z][a-z]{2} \d{1,2}, \d{4})/);
  return m ? m[1] : void 0;
}

/** 解析 DuckDuckGo Lite 结果页。 */
export function parseDdgLite(html, limit = 10) {
  const results = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*class=['"][^'"]*result-link[^'"]*['"][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html)) !== null && results.length < limit) {
    const href = match[0].match(/\bhref="([^"]+)"/i)?.[1];
    if (href === void 0) continue;
    const url = unwrapDdgLink(decodeEntities(href));
    if (url === null || seen.has(url)) continue;
    const title = stripTags(match[1]);
    if (title.length === 0) continue;
    const tail = html.slice(anchor.lastIndex, anchor.lastIndex + 3000);
    const snippet = tail.match(/<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/i);
    seen.add(url);
    results.push({ title, url, ...snippet !== null ? { snippet: stripTags(snippet[1]) } : {} });
  }
  return results.filter((item) => item.snippet !== '');
}

/** 解析 Bing 结果页（<li class="b_algo">）。 */
export function parseBing(html, limit = 10) {
  const results = [];
  const seen = new Set();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) ?? [];
  for (const block of blocks) {
    let href;
    let titleHtml;
    const h2 = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (h2 !== null) {
      href = h2[1];
      titleHtml = h2[2];
    } else {
      const anchor = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]{3,200}?)<\/a>/i);
      if (anchor === null) continue;
      href = anchor[1];
      titleHtml = anchor[2];
    }
    const url = unwrapBingLink(decodeEntities(href));
    if (url === null || seen.has(url)) continue;
    const title = stripTags(titleHtml ?? '');
    if (title.length === 0) continue;
    const paragraph = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = paragraph !== null ? stripTags(paragraph[1]) : '';
    const pageAge = pickPageAge(block);
    seen.add(url);
    results.push({
      title,
      url,
      ...snippet.length > 0 ? { snippet } : {},
      ...pageAge !== void 0 ? { page_age: pageAge } : {},
    });
    if (results.length >= limit) break;
  }
  return results;
}

const HTML_FALLBACK = [
  { label: 'lite.duckduckgo.com', build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`, parse: parseDdgLite },
  { label: 'www.bing.com', build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
  { label: 'cn.bing.com', build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBing },
];

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
      },
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, html: await response.text() };
  } catch (error) {
    return { ok: false, reason: `${error?.name === 'AbortError' ? '超时' : error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
  }
}

/** id -> { until, reason }，进程内状态。 */
const cooldown = new Map();

function classify(error) {
  const status = Number(error?.status);
  if (status === 401 || status === 403) return { ms: 60 * 60 * 1000, reason: `HTTP ${status}` };
  if (status === 402) return { ms: 60 * 60 * 1000, reason: 'HTTP 402' };
  if (status === 429) return { ms: 10 * 60 * 1000, reason: 'HTTP 429' };
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { ms: 2 * 60 * 1000, reason: '超时' };
  return { ms: 5 * 60 * 1000, reason: String(error?.message ?? error).slice(0, 120) };
}

function cooled(id) {
  const entry = cooldown.get(id);
  if (entry === void 0) return void 0;
  if (Date.now() >= entry.until) { cooldown.delete(id); return void 0; }
  return entry;
}

function setCooldown(id, ms, reason) {
  cooldown.set(id, { until: Date.now() + ms, reason });
}

async function runEngine(engine, query, { limit, signal, state }) {
  const skip = cooled(engine.id);
  if (skip !== void 0) throw Object.assign(new Error(`冷却中（${skip.reason}）`), { cooled: true });
  try {
    const list = await engine.search(query, { limit, signal });
    if (list.length === 0) {
      setCooldown(engine.id, 60 * 1000, '空结果');
      throw new Error('0 条结果');
    }
    cooldown.delete(engine.id);
    return list;
  } catch (error) {
    // 已经凑满结果、我们自己 abort 掉慢引擎，不算它失败，别冤枉性冷却
    if (error?.cooled !== true && state?.settled !== true) {
      const info = classify(error);
      setCooldown(engine.id, info.ms, info.reason);
    }
    throw error;
  }
}

function mergeInto(merged, seen, list, limit, cap) {
  let added = 0;
  for (const item of list) {
    if (merged.length >= limit || added >= cap) break;
    const key = normalizeUrlLite(item.url);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    added += 1;
  }
  return added;
}

/** 与 engines.normalizeUrl 等价；这里内联一份，避免循环依赖。 */
function normalizeUrlLite(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|gclid$|fbclid$|spm$|ref_?$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    }
    const search = url.searchParams.toString();
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${search === '' ? '' : `?${search}`}`;
  } catch {
    return String(raw ?? '');
  }
}

function delay(ms) {
  return new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); });
}

/**
 * 带优先级引擎的并发。
 * @returns {Promise<{ merged: Array, served: string[], failures: string[] }>}
 */
async function raceWithPriority(engines, query, { limit, budgetMs, signal, state, perEngineCap, priorityWaitMs, priorityTake }) {
  const priority = engines.find((engine) => engine.priority === true);
  const others = engines.filter((engine) => engine !== priority);
  const failures = [];
  const served = [];
  const normal = [];
  const seen = new Set();
  const started = Date.now();

  const priorityPromise = priority === void 0
    ? Promise.resolve(null)
    : runEngine(priority, query, { limit: Math.min(limit, priorityTake), signal, state }).then(
        (list) => ({ label: priority.label, list }),
        (error) => ({ label: priority.label, error }),
      );

  const pending = new Map();
  for (const engine of others) {
    pending.set(engine.id, runEngine(engine, query, { limit, signal, state }).then(
      (list) => ({ id: engine.id, label: engine.label, list }),
      (error) => ({ id: engine.id, label: engine.label, error }),
    ));
  }

  while (pending.size > 0) {
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) break;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), remaining); });
    const winner = await Promise.race([...pending.values(), timeout]);
    clearTimeout(timer);
    if (winner === null) break;
    pending.delete(winner.id);
    if (winner.error !== void 0) {
      failures.push(`${winner.label}: ${winner.error?.message ?? winner.error}`.slice(0, 200));
      continue;
    }
    const added = mergeInto(normal, seen, winner.list, limit, perEngineCap);
    if (added > 0) served.push(winner.label);
    if (normal.length >= limit) break;
  }

  let priorityHits = [];
  if (priority !== void 0) {
    const wait = Math.max(0, priorityWaitMs - (Date.now() - started));
    const result = await Promise.race([priorityPromise, delay(wait).then(() => null)]);
    if (result === null) {
      failures.push(`${priority.label}: 等待超时（${priorityWaitMs}ms）`);
    } else if (result.error !== void 0) {
      failures.push(`${result.label}: ${result.error?.message ?? result.error}`.slice(0, 200));
    } else {
      priorityHits = result.list;
    }
  }

  const merged = [];
  const seenFinal = new Set();
  const took = mergeInto(merged, seenFinal, priorityHits, limit, priorityTake);
  if (took > 0) served.unshift(priority.label);
  mergeInto(merged, seenFinal, normal, limit, limit);
  return { merged, served, failures };
}

/**
 * 搜索入口。
 * @param {string} query
 * @param {{ limit?: number, engines: Array, signal?: AbortSignal, config?: object }} options
 * @returns {Promise<{ results: Array, served: string[], failures: string[] }>}
 */
export async function searchWeb(query, options) {
  const config = { ...DEFAULTS, ...(options.config ?? {}) };
  const limit = Math.max(1, Math.min(Number(options.limit) || 10, 20));
  const engines = options.engines ?? [];
  const controller = new AbortController();
  const state = { settled: false };
  const failures = [];
  let merged = [];
  let served = [];

  try {
    const raced = await raceWithPriority(engines, query, {
      limit,
      budgetMs: Math.min(config.budgetMs, config.fetchTimeoutMs),
      signal: controller.signal,
      state,
      perEngineCap: config.perEngineCap,
      priorityWaitMs: config.priorityWaitMs,
      priorityTake: config.priorityTake,
    });
    merged = raced.merged;
    served = raced.served;
    failures.push(...raced.failures);

    if (merged.length < config.minResults && engines.length > 0) {
      const rest = engines.filter((engine) => !engine.priority);
      if (rest.length > 0) {
        // 主层不够时，把没被选中的引擎（例如按语言池错开的）再补一轮
        const extra = await raceWithPriority(rest.slice(1), query, {
          limit,
          budgetMs: Math.min(config.extraBudgetMs, config.fetchTimeoutMs),
          signal: controller.signal,
          state,
          perEngineCap: config.perEngineCap,
          priorityWaitMs: 0,
          priorityTake: 0,
        });
        const seen = new Set(merged.map((item) => normalizeUrlLite(item.url)));
        mergeInto(merged, seen, extra.merged, limit, limit);
        served.push(...extra.served.filter((label) => !served.includes(label)));
        failures.push(...extra.failures);
      }
    }

    state.settled = true;
    controller.abort();
  } catch (error) {
    failures.push(String(error?.message ?? error));
  }

  if (merged.length < config.minResults && config.fallbackHtml) {
    const seen = new Set(merged.map((item) => normalizeUrlLite(item.url)));
    for (const engine of HTML_FALLBACK) {
      const page = await fetchHtml(engine.build(query), config.fetchTimeoutMs);
      if (!page.ok) {
        failures.push(`${engine.label}: ${page.reason}`);
        continue;
      }
      const list = engine.parse(page.html, limit);
      if (list.length === 0) {
        failures.push(`${engine.label}: 没解析出结果（可能是验证页或空结果）`);
        continue;
      }
      const added = mergeInto(merged, seen, list, limit, limit);
      if (added > 0) served.push(engine.label);
      if (merged.length >= limit) break;
    }
  }

  return { results: merged.slice(0, limit), served, failures };
}

/** 诊断：当前处于冷却的引擎。 */
export function cooldownStatus() {
  const now = Date.now();
  return [...cooldown.entries()].map(([id, entry]) => ({
    id,
    reason: entry.reason,
    secondsLeft: Math.max(0, Math.round((entry.until - now) / 1000)),
  }));
}
