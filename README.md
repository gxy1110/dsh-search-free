# dsh-search-free

> 仓库：<https://github.com/gxy1110/dsh-search-free>

给 DeepSeek Harness（dsh）用的**免 key 多引擎搜索 provider**，挂在官方 web 能力接缝
（`ctx.web`）上。装上之后，模型看到的还是那个 `web_search` 工具，换掉的只是背后的检索通道。

- **不需要 API key**：六个公开的匿名搜索端点（Exa / Keenable / Parallel / AnySearch / Tavily / You.com）
- **可选自建 SearXNG**：填一个实例地址就自动优先使用；不填就完全不注册该引擎
- **无本地进程**：不像代理方案那样需要占用端口、开机自启、维护会话头
- **零构建、零依赖**：纯 ESM + 内置 `fetch`，`npm install` 不会跑任何构建脚本
- **跨平台**：Windows / macOS / Linux（x64、arm64 都行），Node ≥ 20
- **跨版本**：不 import 任何 `@deepseek-ai/*`，因此 0.1.x 与 0.2.x 的接缝都能加载

## 它解决什么问题

官方搜索 provider 需要 DeepSeek 官方 key，而且每次搜索都是一整个模型轮次。社区常见的替代做法是
在本机起一个 HTTP 代理、把请求伪造成 Anthropic Messages 响应——那套东西能跑，但要维护端口、
进程、开机自启，换台设备就得重新部署一遍。

这个插件的做法是直接实现接缝要的接口：

```ts
interface WebSearchProvider {
  id: string
  available(): boolean
  search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<{
    sources: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>
    truncated: boolean
  }>
}
```

于是没有中间进程、没有协议伪装，配置只有一个 JSON 段落。

## 安装

```sh
# Git 仓库（推荐，跨设备一条命令）
dsh plugin add git+https://github.com/gxy1110/dsh-search-free.git

# 或本地目录
dsh plugin add /path/to/dsh-search-free

# 或 tarball
dsh plugin add ./dsh-search-free-0.1.0.tgz
```

桌面客户端（独立 profile，不能用 `dsh` 命令）走自带 CLI：

```powershell
$env:ELECTRON_RUN_AS_NODE = "1"
& "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals `
  "C:\Users\<你>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
  plugin --profile desktop add "git+https://github.com/gxy1110/dsh-search-free.git"
```

## 更新

`git+` 依赖锁在安装时的提交上，更新要重新 add 一次（幂等，会拉到最新 main）：

```sh
dsh plugin add git+https://github.com/gxy1110/dsh-search-free.git
```

或者进 profile 目录直接让 pnpm 重解析：

```sh
cd ~/.dsh/profiles/<profile> && pnpm update dsh-search-free
```

更新后重启 dsh（bundle 列表在启动时读取）。只想换配置（`searxng` / `engines` 等）不需要重装，
改 `cordis.patch.yml` 热生效。

装完检查 `cordis.patch.yml` 里是否多了这两段（`dsh plugin add` 会把 bundle patch 追加进 profile）：

```yaml
- insert:
    - id: web-search-free
      name: 'dsh-search-free'
      config:
        searxng: []
        engines: [exa, keenable, parallel, anysearch, tavily, you]

- id: web
  config:
    searchProvider: dsh-search-free
    fetchProvider: http
```

然后重启 dsh（`dsh web` 或桌面客户端）。

> `dsh plugin add` 依赖 pnpm。如果 profile 里有未批准的构建脚本，pnpm 会返回非零码并让 dsh
> 跳过 bundle 对账——本插件没有构建脚本，正常不会触发；真遇到就手工把 `dsh-search-free`
> 补进 profile `package.json` 的 `dsh.profile.bundles`。

## 配置

配置写在上面那行 `web-search-free` 的 `config` 里：

| 字段 | 默认 | 说明 |
|---|---|---|
| `searxng` | `[]` | 自建 SearXNG 基址数组，如 `["http://192.168.31.62:8888"]`；多个按顺序回退；留空则不启用该引擎 |
| `engines` | 省略 = 全部 | 参与并发的引擎 id 列表；**写空数组 = 一个都不用**（便于临时全关） |
| `budgetMs` | `5200` | 主层总预算，到点就用手上已有结果 |
| `priorityWaitMs` | `2400` | 自建 SearXNG 的专属等待窗口 |
| `perEngineCap` | `5` | 单个引擎最多贡献条数，避免第一个回来的垄断列表 |
| `minResults` | `3` | 少于这个条数才跑补跑 / HTML 兜底 |
| `fallbackHtml` | `true` | 是否允许 DDG Lite / Bing 的 HTML 兜底 |

改完 patch 后 dsh 会热重载这一层；如果没生效就重启。

## 工作方式

```
web_search(query, maxResults)
  └── provider.search()
        ├── 自建 SearXNG（若配置）：单独等待窗口，结果排最前，最多 6 条
        ├── 公共引擎并发：先回先合并，单引擎最多 5 条，按规范化 URL 去重
        ├── 不足 3 条：补跑剩下的引擎（2.5s 预算）
        └── 仍不足：DuckDuckGo Lite → Bing → Bing 中国站（HTML 兜底）
```

失败按原因冷却：401/403 60 分钟、402 60 分钟、429 10 分钟、超时 2 分钟、其它 5 分钟、
空结果 60 秒。凑满结果后我们自己 abort 掉的慢引擎**不算失败**，不会误冷却。

## 自建 SearXNG（可选）

SearXNG 默认只输出 HTML，所以必须打开 JSON：

```yaml
server:
  base_url: "http://<host>:8888/"
  secret_key: "<随机串>"
  limiter: false          # 开了要 valkey，也会拦非浏览器请求
search:
  formats: [html, json]   # 少了 json，API 一律 403
```

验证：

```sh
curl -s "http://<host>:8888/search?q=test&format=json" | head -c 200
```

## 开发

```sh
npm test          # 15 项单元测试，不联网
npm run smoke     # 真实联网跑两条查询
SMOKE_SEARXNG=http://<host>:8888 npm run smoke
```

## 已知边界

- 这些公共引擎是**匿名免费档**，额度、限流、封禁策略随时可能变；插件对每个引擎单独冷却，
  全挂时还有 HTML 兜底，不会让搜索直接失败。
- HTML 兜底受对方 robots 与频率限制约束，只适合个人低频使用。
- 摘要来自引擎返回的片段，不是抓取正文。
- **卸载前请先删掉 `searchProvider: dsh-search-free` 那一行**，否则搜索会报
  `configured web provider "dsh-search-free" is not registered`。
- 本插件只注册 search，不动 `web_fetch`：抓取继续由你原有的 provider 负责
  （例如 fake-ip 环境下的 `dsh-web-fetch-fakeip`）。

## License

MIT
