// ============================================================================
//  cf-edge-nodes · 节点表生成器（带实测验证）
//  每天由 GitHub Actions 跑一次，产出 nodes.txt（纯接入地址，不含任何密钥）
//
//  产出格式：每行 `host:port#备注`，正是原 Worker 脚本 PREFERRED_LIST 里
//  URL 项的解析格式（见原代码 collectPreferred()：逐行 add(line)）。
//
//  为什么要实测验证：
//    公开"优选 IP"清单里混杂着大量非 Cloudflare 的边缘地址。实测发现同一份
//    清单里 45.76.195.48 连不上、179.253.255.7 却能正常连上 Worker。
//    ⇒ 靠 IP 段名单筛选不可靠，必须用「TLS 握手 + 用某个长期在线的 CF 域名做
//      SNI 校验证书」的方式逐个验证。验证通过的 IP，对任意 CF 前置域名都可用，
//      包括用户的 Worker 自定义域。
//
//  排序策略（Gemini 优先）：
//    ① 社区自动维护的 DDNS 优选域名 —— 域名背后的 IP 由维护方持续轮换，永不失效
//    ② 非港澳优选 IP（验证通过）
//    ③ 港澳优选 IP 放末尾并限量（依据 Google 官方名单：Gemini 网页版支持港澳，
//       但 Gemini API / AI Studio 不支持港澳）
// ============================================================================
import fs from 'node:fs';
import tls from 'node:tls';

const UA = 'Mozilla/5.0 (compatible; cf-edge-nodes/1.0)';
const OUT = process.argv[2] || 'nodes.txt';
const META = process.argv[3] || 'meta.json';
const MAX_OUT = 100;             // 与 Worker 内 cap = 100 对齐
const HK_TAIL_QUOTA = 10;        // 港澳条目最多保留条数（放末尾）
const FETCH_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 4000;
const PROBE_CONCURRENCY = 32;
const MAX_CANDIDATES = 500;      // 候选上限，控制 Actions 耗时
// 用这个长期在线的 CF 域名做 SNI，校验目标 IP 是否真的是 Cloudflare 边缘
const VERIFY_SNI = 'cloudflare.com';

// ---- ① 社区自动维护的 DDNS 优选域名（长期稳定，放最前，不参与验证）--------
const DDNS_DOMAINS = [
  ['cf.090227.xyz', 443, 'CMLiu-自动优选'],
  ['bestcf.030101.xyz', 443, 'MingYu-自动优选'],
  ['cf.877774.xyz', 443, 'QMS-通用'],
  ['ct.877774.xyz', 443, 'QMS-电信'],
  ['cu.877774.xyz', 443, 'QMS-联通'],
  ['cmcc.877774.xyz', 443, 'QMS-移动'],
  ['ct.cloudflare.byoip.top', 443, 'Byoip-电信'],
  ['cu.cloudflare.byoip.top', 443, 'Byoip-联通'],
  ['cm.cloudflare.byoip.top', 443, 'Byoip-移动'],
  ['yg1.ygkkk.dpdns.org', 443, 'YGKKK-自动优选'],
  ['cf.3666888.xyz', 443, 'HuTao-自动优选'],
  ['cf.tencentapp.cn', 443, 'KTFF-自动优选'],
  ['skk.moe', 443, 'Sukka-优选'],
];

// ---- ② 每日构建的优选 IP 源 ------------------------------------------------
const IP_SOURCES = [
  { kind: 'json', region: 'AUTO', urls: [
    'https://raw.githubusercontent.com/NiREvil/vless/refs/heads/main/sub/Cf-ipv4.json',
    'https://cdn.jsdelivr.net/gh/NiREvil/vless@main/sub/Cf-ipv4.json',
  ] },
  { kind: 'txt', region: 'US', urls: ['https://bestcf.pages.dev/random-region/US/100.txt'] },
  { kind: 'txt', region: 'JP', urls: ['https://bestcf.pages.dev/random-region/JP/100.txt'] },
  { kind: 'txt', region: 'SG', urls: ['https://bestcf.pages.dev/random-region/SG/100.txt'] },
  { kind: 'txt', region: 'TW', urls: ['https://bestcf.pages.dev/random-region/TW/100.txt'] },
  { kind: 'txt', region: 'HK', urls: ['https://bestcf.pages.dev/random-region/HK/100.txt'] },
  { kind: 'txt', region: 'AUTO', urls: [
    'https://raw.githubusercontent.com/joname1/BestCFip/refs/heads/main/ipv4.txt',
    'https://cdn.jsdelivr.net/gh/joname1/BestCFip@main/ipv4.txt',
  ] },
  { kind: 'txt', region: 'AUTO', urls: ['https://addressesapi.090227.xyz/CloudFlareYes'] },
  { kind: 'txt', region: 'AUTO', urls: ['https://ipdb.api.030101.xyz/?type=bestcf'] },
  { kind: 'txt', region: 'AUTO', urls: [
    'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt',
    'https://cdn.jsdelivr.net/gh/cmliu/WorkerVless2sub@main/addressesapi.txt',
  ] },
];

// ---- 工具 ------------------------------------------------------------------
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)
  && s.split('.').every(n => Number(n) >= 0 && Number(n) <= 255);

async function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

// TLS 实测：目标 IP 能否以 VERIFY_SNI 完成一次证书校验通过的握手
// 通过 ⇒ 该 IP 就是 Cloudflare 边缘，可用于任意 CF 前置域名（含用户的 Worker 域名）
function probe(host, port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* ignore */ }
      resolve(ok);
    };
    let sock;
    try {
      sock = tls.connect({
        host, port,
        servername: VERIFY_SNI,
        rejectUnauthorized: true,
        timeout: PROBE_TIMEOUT_MS,
      });
    } catch (e) { return resolve(false); }
    sock.once('secureConnect', () => finish(sock.authorized === true));
    sock.once('error', () => finish(false));
    sock.once('timeout', () => finish(false));
  });
}

// 并发池
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { out[i] = await fn(items[i], i); } catch { out[i] = false; }
    }
  });
  await Promise.all(workers);
  return out;
}

// 从任意文本里提取 `ip[:port][#remark]`
function extractFromText(text, region, acc) {
  for (const rawLine of String(text).split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const m = /(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{2,5}))?/.exec(line);
    if (!m) continue;
    const host = m[1];
    if (!isIPv4(host)) continue;
    const port = m[2] ? parseInt(m[2], 10) : 443;
    if (!(port > 0 && port <= 65535)) continue;
    const key = host + ':' + port;
    if (acc.seen.has(key)) continue;
    acc.seen.add(key);
    const hash = line.indexOf('#');
    const remark = hash >= 0 ? line.slice(hash + 1).trim() : '';
    // bestcf 的备注形如「地区随机 | 日本 JP | NRT | ip:port」，region 单独给的是 US/JP/...
    const regionTag = (region && region !== 'AUTO')
      ? region
      : (/香港|澳门|HKG|MACAU|MACAO/i.test(remark) ? 'HK'
        : /台湾|中国台湾|TW\b/i.test(remark) ? 'TW'
        : /日本|JP\b/i.test(remark) ? 'JP'
        : /美国|US\b/i.test(remark) ? 'US'
        : /新加坡|SG\b/i.test(remark) ? 'SG'
        : 'AUTO');
    // 备注统一成干净的「地区-序号」：bestcf 的原始备注形如
    // 「地区随机 | 日本 JP | NRT | ip:port」，直接用会重复且冗长。
    acc.items.push({ host, port, region: regionTag, name: '' });
  }
}

// ---- 主流程 ----------------------------------------------------------------
const acc = { items: [], seen: new Set() };
const sourceReport = [];

for (const src of IP_SOURCES) {
  let ok = false;
  for (const url of src.urls) {
    try {
      const text = await fetchWithTimeout(url);
      let added = 0;
      if (src.kind === 'json') {
        try {
          const j = JSON.parse(text);
          const flat = [];
          const walk = (v) => {
            if (typeof v === 'string') flat.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (v && typeof v === 'object') {
              for (const k of ['ip', 'host', 'address', 'addr', 'ipv4', 'data', 'list']) if (v[k] != null) walk(v[k]);
            }
          };
          walk(j);
          const before = acc.items.length;
          extractFromText(flat.join('\n'), src.region, acc);
          added = acc.items.length - before;
          if (!added) { extractFromText(text, src.region, acc); added = acc.items.length - before; }
        } catch {
          const before = acc.items.length;
          extractFromText(text, src.region, acc);
          added = acc.items.length - before;
        }
      } else {
        const before = acc.items.length;
        extractFromText(text, src.region, acc);
        added = acc.items.length - before;
      }
      ok = added > 0;
      sourceReport.push({ url, kind: src.kind, region: src.region, ok, added });
      if (ok) break;
    } catch (e) {
      sourceReport.push({ url, kind: src.kind, region: src.region, ok: false, added: 0, error: String((e && e.message) || e) });
    }
  }
}

// 统一起名：按地区分组编号，客户端里看得清、不重复
{
  const counters = {};
  for (const it of acc.items) {
    const r = it.region && it.region !== 'AUTO' ? it.region : 'CF';
    counters[r] = (counters[r] || 0) + 1;
    it.name = r + '-' + String(counters[r]).padStart(2, '0');
  }
}

// ---- 实测验证（关键步骤）---------------------------------------------------
let candidates = acc.items.filter(it => it.port === 443);
if (candidates.length > MAX_CANDIDATES) candidates = candidates.slice(0, MAX_CANDIDATES);
const nonHkCand = candidates.filter(it => it.region !== 'HK');
const hkCand = candidates.filter(it => it.region === 'HK');

const t0 = Date.now();
const probeList = nonHkCand.concat(hkCand);
const results = await mapLimit(probeList, PROBE_CONCURRENCY, (it) => probe(it.host, it.port));
const verified = probeList.filter((it, i) => results[i] === true);
const probeMs = Date.now() - t0;

// 验证结果为空（例如 Actions 网络异常）时，退回未验证清单，宁可给出候选也不要空表
const usable = verified.length ? verified : candidates;
const verifyFallback = verified.length === 0;

const vNonHk = usable.filter(it => it.region !== 'HK');
const vHk = usable.filter(it => it.region === 'HK');
// 非港澳占满 (MAX_OUT - HK_TAIL_QUOTA)，港澳配额放在最末尾。
// 修：先前写成 vNonHk.concat(...).slice(0, MAX_OUT)，非港澳满 100 时会把港澳整段切掉。
const picked = vNonHk.slice(0, Math.max(0, MAX_OUT - HK_TAIL_QUOTA))
  .concat(vHk.slice(0, HK_TAIL_QUOTA));

// ---- 输出 ------------------------------------------------------------------
const lines = [];
for (const [host, port, name] of DDNS_DOMAINS) lines.push(`${host}:${port}#${name}`);
for (const it of picked) lines.push(`${it.host}:${it.port}#${it.name}`);
const uniq = [...new Set(lines)];
fs.writeFileSync(OUT, uniq.join('\n') + '\n', 'utf8');

const meta = {
  generated_utc: new Date().toISOString(),
  generated_utc8: new Date(Date.now() + 8 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
  lines_total: uniq.length,
  ddns_domains: DDNS_DOMAINS.length,
  candidates_probed: probeList.length,
  verified_ok: verified.length,
  verify_fallback_used: verifyFallback,
  probe_seconds: Math.round(probeMs / 1000),
  ip_entries_final: picked.length,
  hk_kept: Math.min(vHk.length, HK_TAIL_QUOTA),
  hk_total_seen: acc.items.filter(it => it.region === 'HK').length,
  sources: sourceReport,
};
fs.writeFileSync(META, JSON.stringify(meta, null, 2), 'utf8');

console.log('生成完成:', OUT, '总行数 =', uniq.length);
console.log('  优选域名', DDNS_DOMAINS.length, '条 + 优选 IP', picked.length, '条（已验证）');
console.log('  探测', probeList.length, '个候选，通过', verified.length, '个，耗时', Math.round(probeMs / 1000), '秒',
  verifyFallback ? '⚠ 全部未通过，已退回未验证清单' : '');
console.log('  港澳：命中', meta.hk_total_seen, '条，保留', meta.hk_kept, '条在末尾');
console.log('  源状态：', sourceReport.filter(r => r.ok).length, '成功 /', sourceReport.length, '次尝试');
for (const r of sourceReport) console.log('   ', r.ok ? '✅' : '❌', String(r.added).padStart(4), r.url.slice(0, 76), r.error ? ('(' + r.error + ')') : '');
