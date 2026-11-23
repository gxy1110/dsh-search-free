import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMcpText, normalizeUrl, source, buildEngines } from '../src/engines.js';
import { searchWeb, cooldownStatus, parseDdgLite } from '../src/orchestrator.js';
import { apply, PROVIDER_ID } from '../src/index.js';

test('parseMcpText: 单帧 JSON', () => {
  const json = { jsonrpc: '2.0', id: 1, result: { content: [] } };
  assert.deepEqual(parseMcpText(JSON.stringify(json)), json);
});

test('parseMcpText: SSE 多帧取第一个可用对象', () => {
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hello"}]}}',
    '',
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{}}',
  ].join('\n');
  const parsed = parseMcpText(sse);
  assert.equal(parsed.id, 1);
  assert.equal(parsed.result.content[0].text, 'hello');
});

test('parseMcpText: 空响应抛错', () => {
  assert.throws(() => parseMcpText('   '), /empty MCP response/);
});

test('normalizeUrl: 去 utm/锚点/尾斜杠并小写主机', () => {
  const a = normalizeUrl('https://Example.COM/a/?utm_source=x&utm_medium=y#frag');
  const b = normalizeUrl('https://example.com/a');
  assert.equal(a, b);
  assert.equal(a, 'https://example.com/a');
});

test('normalizeUrl: 保留有意义的 query', () => {
  assert.equal(normalizeUrl('https://x.com/s?q=abc'), 'https://x.com/s?q=abc');
});

test('source: 归一化日期，丢弃非法 URL', () => {
  const ok = source('标题', 'https://a.com/x', '摘要', '2026-11-20T10:00:00Z');
  assert.equal(ok.page_age, '2026-11-20');
  const cn = source('标题', 'https://a.com/x', '摘要', '2026年11月20日');
  assert.equal(cn.page_age, '2026年11月20日');
  assert.equal(source('x', 'javascript:alert(1)', 's'), null);
});

test('buildEngines: 留空 engines 时全部启用；配了 searxng 才加它', () => {
  const plain = buildEngines({});
  assert.equal(plain.length, 6);
  assert.ok(!plain.some((engine) => engine.id === 'searxng'));

  const withSearxng = buildEngines({ searxng: ['http://192.168.31.62:8888/'] });
  assert.equal(withSearxng.length, 7);
  assert.equal(withSearxng[0].id, 'searxng');
  assert.equal(withSearxng[0].priority, true);

  const subset = buildEngines({ engines: ['exa', 'you'] });
  assert.deepEqual(subset.map((engine) => engine.id), ['exa', 'you']);
});

test('searchWeb: 合并去重，单引擎不超过 perEngineCap', async () => {
  const engines = [
    {
      id: 'a', label: 'a', langs: ['en'], rank: 1,
      search: async () => [
        { title: 'A1', url: 'https://a.com/1', snippet: 's1' },
        { title: 'A2', url: 'https://a.com/2', snippet: 's2' },
        { title: 'A2-dup', url: 'https://a.com/2/?utm_source=x', snippet: 's2' },
      ],
    },
    {
      id: 'b', label: 'b', langs: ['en'], rank: 2,
      search: async () => [{ title: 'B1', url: 'https://b.com/1', snippet: 'sb' }],
    },
  ];
  const out = await searchWeb('q', { limit: 10, engines, config: { fallbackHtml: false, budgetMs: 2000 } });
  assert.equal(out.results.length, 3);
  assert.deepEqual(out.results.map((item) => item.url), ['https://a.com/1', 'https://a.com/2', 'https://b.com/1']);
  assert.deepEqual(out.served, ['a', 'b']);
});

test('searchWeb: 优先级引擎排在结果最前', async () => {
  const engines = [
    {
      id: 'slow', label: 'slow', langs: ['en'], rank: 0, priority: true,
      search: async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return [{ title: 'P1', url: 'https://p.com/1', snippet: 'sp' }];
      },
    },
    {
      id: 'fast', label: 'fast', langs: ['en'], rank: 1,
      search: async () => [{ title: 'F1', url: 'https://f.com/1', snippet: 'sf' }],
    },
  ];
  const out = await searchWeb('q', {
    limit: 10,
    engines,
    config: { fallbackHtml: false, budgetMs: 2000, priorityWaitMs: 1000 },
  });
  assert.equal(out.results[0].url, 'https://p.com/1');
  assert.equal(out.served[0], 'slow');
});

test('searchWeb: 引擎失败只记录失败并按原因冷却，不影响其它引擎', async () => {
  const engines = [
    {
      id: 'boom', label: 'boom', langs: ['en'], rank: 1,
      search: async () => { throw Object.assign(new Error('HTTP 429: slow down'), { status: 429 }); },
    },
    {
      id: 'good', label: 'good', langs: ['en'], rank: 2,
      search: async () => [{ title: 'G', url: 'https://g.com/1' }],
    },
  ];
  const out = await searchWeb('cooldown-probe', {
    limit: 10,
    engines,
    config: { fallbackHtml: false, budgetMs: 2000 },
  });
  assert.equal(out.results.length, 1);
  assert.match(out.failures.join(' '), /HTTP 429/);
  const status = cooldownStatus().find((entry) => entry.id === 'boom');
  assert.ok(status !== undefined, '失败引擎应进入冷却');
  assert.equal(status.reason, 'HTTP 429');
});

test('searchWeb: 空引擎列表且关闭 HTML 兜底时返回空结果', async () => {
  const out = await searchWeb('q', { limit: 10, engines: [], config: { fallbackHtml: false } });
  assert.deepEqual(out.results, []);
});

test('parseDdgLite: 解析跳转链与摘要', () => {
  const html = `
    <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x">标题 A</a>
    <td class="result-snippet">摘要 A</td>`;
  const out = parseDdgLite(html, 5);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://example.com/a');
  // 中文两侧被标签撑出来的空格会被并掉，这是解析器有意的行为
  assert.equal(out[0].snippet, '摘要A');
});

test('apply: 空引擎列表时不发网络请求，返回空 sources', async () => {
  let registered;
  const ctx = {
    web: { registerSearchProvider(provider) { registered = provider; return () => { registered = undefined; }; } },
    effect(fn) { fn(); },
    logger: { info() {} },
  };
  apply(ctx, { engines: [], fallbackHtml: false });
  assert.ok(registered !== undefined);
  assert.equal(registered.id, PROVIDER_ID);
  // 显式空数组 = 一个引擎都不用，provider 自报不可用
  assert.equal(registered.available(), false);

  const result = await registered.search({ query: 'q', maxResults: 5 });
  assert.deepEqual(result, { sources: [], truncated: false });
});

test('apply: 省略 engines 时全部引擎可用；显式空数组则没有', () => {
  let captured;
  const makeCtx = () => ({
    web: { registerSearchProvider(provider) { captured = provider; return () => {}; } },
    effect() {},
  });
  apply(makeCtx(), {});
  assert.equal(captured.available(), true);
  apply(makeCtx(), { engines: [] });
  assert.equal(captured.available(), false);
});

test('apply: 注册返回的清理函数交给 effect 保管', () => {
  let disposed = false;
  const disposers = [];
  const ctx = {
    web: { registerSearchProvider() { return () => { disposed = true; }; } },
    effect(fn) { disposers.push(fn()); },
  };
  apply(ctx, {});
  assert.equal(disposers.length, 1);
  assert.equal(disposed, false, 'effect 只登记，不应立刻清理');
  disposers[0]();
  assert.equal(disposed, true);
});
