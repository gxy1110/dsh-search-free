/**
 * `dsh-search-free` —— 免 key 的多引擎 `WebSearchProvider`，注册进 `ctx.web`。
 *
 * 它替代的是一条「本机代理 + 伪造 Anthropic 响应」的旧路线：以前官方
 * `dsh-web-search-deepseek` 只会说 Anthropic Messages 协议，导致我们必须在本机
 * 起一个 8788 端口去截胡那类请求、自己合成 `web_search_tool_result` 块。作为
 * seam 上的 provider，这里直接返回接缝要的 `{ sources, truncated }`，不再需要
 * 任何中间进程、端口或协议伪装。
 *
 * 之所以能在不同 DSH 版本上跑：本模块**不 import 任何 `@deepseek-ai/*`**。注册
 * 只需要 `ctx.web.registerSearchProvider`，而它在 0.1.x 与 0.2.x 的接缝里签名
 * 一致；桌面客户端的 profile 侧会把 `@deepseek-ai/*` 解析到旧树（0.1.5-rc.2），
 * 零 import 正好绕开这个坑，也就不需要 `installSettingsSection` 这类 0.2.x 新 API。
 *
 * 配置来自 profile 的 `cordis.patch.yml`（见 `cordis.patch.yml`），可用字段：
 *   searxng        自建实例基址数组，留空则不注册该引擎
 *   engines        参与并发的公共引擎 id 列表，留空=全部
 *   budgetMs       主层总预算，默认 5200
 *   priorityWaitMs 自建实例专属等待窗口，默认 2400
 *   perEngineCap   单引擎最多贡献条数，默认 5
 *   minResults     低于多少条才跑补跑/HTML 兜底，默认 3
 *   fallbackHtml   是否允许 DDG Lite/Bing 的 HTML 兜底，默认 true
 *
 * @module dsh-search-free
 */

import { buildEngines } from './engines.js';
import { searchWeb, cooldownStatus } from './orchestrator.js';

/** provider id：写进 profile 的 `web.searchProvider`，必须稳定。 */
export const PROVIDER_ID = 'dsh-search-free';

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'web-search-free';

/** 注册进 web 能力接缝。 */
export const inject = ['web'];

const NUMERIC_KEYS = ['budgetMs', 'extraBudgetMs', 'priorityWaitMs', 'minResults', 'perEngineCap', 'priorityTake', 'fetchTimeoutMs'];

function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const out = {
    searxng: Array.isArray(config.searxng) ? config.searxng.filter((entry) => typeof entry === 'string') : [],
    fallbackHtml: config.fallbackHtml !== false,
  };
  // 只在真的写了这个键时才限制引擎集合：省略 = 全部启用，空数组 = 一个都不用
  if (Array.isArray(config.engines)) out.engines = config.engines.filter((entry) => typeof entry === 'string');
  for (const key of NUMERIC_KEYS) {
    const value = Number(config[key]);
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * 注册 provider。
 *
 * @param {object} ctx - Cordis 上下文；需要 `ctx.web`。
 * @param {object} rawConfig - patch 里这一行的 `config`。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const engines = buildEngines(config);

  const provider = {
    id: PROVIDER_ID,
    /** 本地判断：没有任何引擎可用时才认为不可用（不发网络请求）。 */
    available: () => engines.length > 0,
    async search(request, signal) {
      const query = String(request?.query ?? '').trim();
      if (query === '') return { sources: [], truncated: false };
      const limit = Number(request?.maxResults) > 0 ? Math.min(Number(request.maxResults), 20) : 10;

      const outcome = await searchWeb(query, { limit, engines, signal, config });
      const sources = outcome.results.map((item) => ({
        url: item.url,
        ...item.title !== undefined && item.title !== '' ? { title: item.title } : {},
        ...item.snippet !== undefined && item.snippet !== '' ? { snippet: item.snippet } : {},
        // 接缝只认 ISO-8601；"3天前"/"2026年11月20日" 这类形状宁可不给
        ...typeof item.page_age === 'string' && /^\d{4}-\d{2}-\d{2}/.test(item.page_age)
          ? { publishedAt: item.page_age }
          : {},
      }));

      return { sources, truncated: false };
    },
  };

  const dispose = ctx.web.registerSearchProvider(provider);
  // Cordis 约定：注册返回的清理函数挂到 effect 上，插件卸载时自动摘掉
  if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
  if (typeof ctx.logger?.info === 'function') {
    ctx.logger.info(`[dsh-search-free] 已注册 provider "${PROVIDER_ID}"，引擎 ${engines.length} 个${config.searxng.length > 0 ? `（含自建 searxng）` : ''}`);
  }
  return dispose;
}

/** 诊断辅助：当前处于冷却的引擎（不改变行为，仅暴露给测试/排查脚本）。 */
export { cooldownStatus };

export default { name, inject, apply };
