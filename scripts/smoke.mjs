/**
 * 联网冒烟：直接走插件注册出来的 provider，打印引擎、条数与样例。
 * 用法：node scripts/smoke.mjs [query...]
 *       SMOKE_SEARXNG=http://192.168.31.62:8888 node scripts/smoke.mjs
 */
import { apply } from '../src/index.js';

const queries = process.argv.length > 2
  ? process.argv.slice(2)
  : ['sing-box TUN fake-ip 原理', 'rust async runtime comparison'];

let registered;
const ctx = {
  web: { registerSearchProvider(provider) { registered = provider; return () => {}; } },
  effect() {},
  logger: { info: (line) => console.log(line) },
};

const searxng = (process.env.SMOKE_SEARXNG ?? '').split(/[\s,]+/).filter(Boolean);
apply(ctx, { searxng });

let bad = 0;
for (const query of queries) {
  const started = Date.now();
  const result = await registered.search({ query, maxResults: 10 });
  const ms = Date.now() - started;
  const broken = result.sources.filter((item) => !/^https?:\/\//.test(item.url)).length;
  const withSnippet = result.sources.filter((item) => typeof item.snippet === 'string' && item.snippet.length > 0).length;
  if (result.sources.length === 0 || broken > 0) bad += 1;

  console.log(`\n=== ${query}`);
  console.log(`sources=${result.sources.length} 摘要=${withSnippet}/${result.sources.length} ${ms}ms 异常=${broken}`);
  for (const item of result.sources.slice(0, 3)) {
    console.log(`  - ${(item.title ?? '').slice(0, 70)}`);
    console.log(`    ${item.url.slice(0, 100)}`);
    console.log(`    ${(item.snippet ?? '(无摘要)').slice(0, 90)}${item.publishedAt ? `  [${item.publishedAt}]` : ''}`);
  }
}

console.log(bad === 0 ? '\nOK: 全部查询通过' : `\nFAIL: ${bad} 条查询有问题`);
process.exitCode = bad === 0 ? 0 : 1;
