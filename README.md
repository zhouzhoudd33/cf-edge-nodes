# cf-edge-nodes

每天自动更新一份 Cloudflare 边缘接入地址清单（`nodes.txt`），供单文件 Worker 代理脚本在运行时拉取。

**本仓库不含任何密钥。** `nodes.txt` 里只有公开的边缘 IP / 优选域名，没有 UUID、没有域名、没有任何凭证。

---

## 产出

| 文件 | 说明 |
|---|---|
| `nodes.txt` | 接入地址清单，每行 `host:port#备注` |
| `meta.json` | 本次生成的时间、条数、各源状态、验证通过数 |

更新频率：**每天两次**（UTC 00:00 / 12:00，即北京时间 08:00 / 20:00），也可在 Actions 页手动触发。

## 它是怎么用的

单文件 Worker 脚本里有一个配置项 `PREFERRED_LIST`。它的每一项**既可以是 `host:port`，也可以是一个 URL** —— 原脚本的 `collectPreferred()` 会对 URL 项执行 `fetch()`，并把返回内容**逐行**按 `host:port#备注` 解析成接入节点（自带 `cf: { cacheTtl: 300 }`，5 分钟边缘缓存）。

所以只要把这个值改成指向本仓库的 `nodes.txt`，Worker 每次冷启动就会自动拉取最新节点，**之后永远不需要再改代码、再部署**：

```js
const PREFERRED_LIST = 'https://raw.githubusercontent.com/zhouzhoudd33/cf-edge-nodes/main/nodes.txt';
```

> 国内网络拉不到 raw 时，可换成 jsDelivr 镜像（内容相同，CDN 缓存 12 小时）：
> `https://cdn.jsdelivr.net/gh/zhouzhoudd33/cf-edge-nodes@main/nodes.txt`
> 也可以两个 URL 都放进 `PREFERRED_LIST`（逗号分隔），第一个拉不到自动用第二个。

## 生成逻辑

1. **拉取候选**：从 10 个每日/高频构建的公开源收集候选 IP（含 jsDelivr 镜像兜底）。
2. **实测验证（关键）**：对每个候选做一次 **TLS 握手**，SNI 用 `cloudflare.com` 并要求**证书校验通过**。
   - 通过 ⇒ 该 IP 确实是 Cloudflare 边缘，对**任意** CF 前置域名都可用（包括你自己的 Worker 自定义域）。
   - 这一步是必须的：公开清单里混着大量非 CF 地址。实测同一份清单里 `45.76.195.48` 连不上、`179.253.255.7` 却能正常连上 Worker —— **靠 IP 段名单猜不可靠，只能实测**。
3. **排序（Gemini 优先）**：
   - ① 13 条社区自动维护的 DDNS 优选域名放最前（域名背后的 IP 由维护方持续轮换，永不失效）
   - ② 非港澳优选 IP
   - ③ 港澳优选 IP 限量 10 条，**放在最末尾**
4. 取前 100 条 IP（与 Worker 内 `cap = 100` 对齐）输出。

### 为什么港澳要放末尾

依据 Google 官方支持地区名单（2026-10-16 核对）：

- Gemini **网页版 / App** 支持名单 —— **包含中国香港、中国澳门**
- Gemini **API / AI Studio** 支持名单 —— **不包含**中国香港、中国澳门、中国大陆

所以非港澳节点能同时覆盖「网页版 + API」，港澳节点只能覆盖网页版。港澳条目不是剔除，而是降权放末尾，仍可手动选用。

> 注意：这里排序的是**接入地址**（客户端连 CF 边缘用哪一跳）。
> 「能否用上 Gemini API」还取决于 **Worker 的出口地区**。原脚本 `selectRelayRegion()` 把
> HKG/SIN/NRT/KIX/TYO/OSA/ICN/SEL 这些 colo **全部映射到 HK 出口**，而 HK 不在 Gemini API 名单里。
> 原脚本支持用**环境变量 `PROXYIP`** 固定出口（`CUSTOM_RELAY = env.PROXYIP`），
> 在 CF 后台把它设成 `ProxyIP.JP.CMLiussss.net` 之类的非港澳中继即可，**无需改代码**。

## 本地运行

```bash
node scripts/update-nodes.mjs nodes.txt meta.json
```

无第三方依赖，只需要 Node 18+（用到内置 `fetch` 与 `node:tls`）。
