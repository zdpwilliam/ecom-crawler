// 代理池：从环境变量 CRAWL_PROXY_POOL（逗号分隔）或 data/proxies.txt 载入，
// 轮询分配 + 按健康度自动剔除/冷却，请求失败时自动轮换到下一个健康代理。
// 兼容旧版单代理 CRAWL_PROXY（作为池中的一员）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 统一用 npm undici 的 fetch：Node 内置 fetch 与 npm undici v7 的 dispatcher 跨实例不兼容（报 UND_ERR_INVALID_ARG）
import { fetch as undiciFetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXIES_FILE = path.resolve(__dirname, '..', 'data', 'proxies.txt');

let pool = [];
let cursor = -1;
const health = new Map(); // proxy -> { failures, lastUsed, cooldownUntil }

function loadProxies() {
  pool = [];
  const fromEnv = (process.env.CRAWL_PROXY_POOL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (fromEnv.length) pool.push(...fromEnv);
  // 旧版单代理也并入池中
  if (process.env.CRAWL_PROXY && !pool.includes(process.env.CRAWL_PROXY)) {
    pool.push(process.env.CRAWL_PROXY);
  }
  if (fs.existsSync(PROXIES_FILE)) {
    const lines = fs
      .readFileSync(PROXIES_FILE, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => !l.startsWith('#'));
    pool.push(...lines);
  }
  pool = [...new Set(pool)];
  for (const p of pool) if (!health.has(p)) health.set(p, { failures: 0, lastUsed: 0, cooldownUntil: 0 });
  return pool;
}

loadProxies();

export function poolSize() {
  return pool.length;
}
export function listProxies() {
  return pool.map((p) => ({ proxy: p, ...health.get(p) }));
}

// 轮询挑选一个不在冷却期的代理；全部冷却则退而求其次返回下一个。
export function pickProxy() {
  if (!pool.length) return undefined;
  const now = Date.now();
  for (let i = 0; i < pool.length; i++) {
    cursor = (cursor + 1) % pool.length;
    const p = pool[cursor];
    const h = health.get(p);
    if (h.cooldownUntil <= now) return p;
  }
  return pool[(cursor + 1) % pool.length];
}

export function reportFailure(p) {
  if (!p) return;
  const h = health.get(p);
  if (!h) return;
  h.failures += 1;
  // 冷却时间随连续失败增长（5s → 10s → 20s … 上限 60s）
  h.cooldownUntil = Date.now() + Math.min(60000, 5000 * 2 ** (h.failures - 1));
}
export function reportSuccess(p) {
  if (!p) return;
  const h = health.get(p);
  if (!h) return;
  h.failures = Math.max(0, h.failures - 1);
  h.lastUsed = Date.now();
}

// ---------- 代理池管理：添加 / 删除 / 测速 ----------
const PROXY_RE = /^(https?|socks[45]?):\/\/\S+$/i;

// dispatcher 缓存（按代理地址复用，避免重复建连开销）
const _dispatchers = new Map();

/** 为代理创建 fetch dispatcher：http(s) → undici ProxyAgent；socks4/5 → fetch-socks。
 *  注意：undici 的 ProxyAgent 只支持 HTTP 代理——SOCKS5 走它会报「fetch failed」。 */
export async function getProxyDispatcher(proxy) {
  if (!proxy) return undefined;
  if (_dispatchers.has(proxy)) return _dispatchers.get(proxy);
  let d;
  try {
    if (/^socks[45]?:\/\//i.test(proxy)) {
      const { socksDispatcher } = await import('fetch-socks');
      const u = new URL(proxy);
      const opts: Record<string, any> = {
        type: u.protocol === 'socks4:' ? 4 : 5,
        host: u.hostname,
        port: Number(u.port) || (u.protocol === 'socks4:' ? 1080 : 1080),
      };
      if (u.username) {
        opts.userId = decodeURIComponent(u.username);
        if (u.password) opts.password = decodeURIComponent(u.password);
      }
      d = socksDispatcher(opts as any);
    } else {
      const { ProxyAgent } = await import('undici');
      d = new ProxyAgent(proxy);
    }
  } catch {
    d = undefined;
  }
  _dispatchers.set(proxy, d);
  return d;
}

/** 把 fetch 抛出的晦涩错误翻译成人话（fetch failed 会把真实原因藏在 e.cause 里）。 */
export function fetchErrText(e) {
  if (e?.name === 'TimeoutError') return '超时：代理不可达或响应过慢';
  const cause = e?.cause?.code || e?.cause?.message || '';
  const base = cause || e?.message || String(e);
  if (/ECONNREFUSED/i.test(base)) return '连接被拒绝：该端口没有服务在监听（VPN 未启动或端口填错）';
  if (/ENOTFOUND|EAI_AGAIN/i.test(base)) return '主机名解析失败：检查代理地址写法';
  if (/ECONNRESET/i.test(base)) return '连接被重置：端口有服务但不稳定，或协议类型不匹配（SOCKS 端口别填 http://）';
  if (/EACCES|EPERM/i.test(base)) return '无权限连接：检查端口是否被占用/防火墙';
  return base;
}

/** 规范化输入：127.0.0.1:7890 → http://127.0.0.1:7890（VPN 本地端口常省略协议头）。 */
function normalizeProxy(p) {
  p = String(p || '').trim();
  if (p && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = 'http://' + p;
  return p;
}

/** 添加一个代理到 data/proxies.txt（去重）并重新载入。 */
export function addProxy(input) {
  const p = normalizeProxy(input);
  if (!p || !PROXY_RE.test(p)) {
    throw new Error('代理格式应为 http://user:pass@host:port 或 socks5://host:port（VPN 本地端口可直接填 127.0.0.1:7890，会自动补 http://）');
  }
  const lines = fs.existsSync(PROXIES_FILE)
    ? fs.readFileSync(PROXIES_FILE, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((l) => l && !l.startsWith('#'))
    : [];
  if (lines.includes(p)) return { added: false, list: lines };
  lines.push(p);
  fs.writeFileSync(PROXIES_FILE, lines.join('\n') + '\n', 'utf8');
  reloadProxies();
  return { added: true, list: lines };
}

/** 从 data/proxies.txt 删除一个代理并重新载入。 */
export function removeProxy(p) {
  if (!fs.existsSync(PROXIES_FILE)) return { removed: false, list: [] };
  const lines = fs
    .readFileSync(PROXIES_FILE, 'utf8')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((l) => l && !l.startsWith('#'))
    .filter((l) => l !== String(p || '').trim());
  fs.writeFileSync(PROXIES_FILE, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  reloadProxies();
  return { removed: true, list: lines };
}

/** 测速：通过该代理请求一次目标站，返回延迟 ms；失败自动 reportFailure 进冷却。 */
export async function testProxy(p) {
  const start = Date.now();
  try {
    const dispatcher = await getProxyDispatcher(p);
    await undiciFetch('http://www.baidu.com/', {
      dispatcher,
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': 'Mozilla/5.0 (proxy-test)' },
    });
    const ms = Date.now() - start;
    const h = health.get(p);
    if (h) {
      h.lastLatencyMs = ms;
      h.lastTestAt = new Date().toISOString();
      h.lastError = '';
    }
    reportSuccess(p);
    return { proxy: p, ok: true, ms };
  } catch (e) {
    const msg = fetchErrText(e);
    const h = health.get(p);
    if (h) {
      h.lastLatencyMs = null;
      h.lastTestAt = new Date().toISOString();
      h.lastError = msg;
    }
    reportFailure(p);
    return { proxy: p, ok: false, error: msg };
  }
}

/** 一键测速：并行测所有代理。 */
export function testAllProxies() {
  return Promise.all(pool.map((p) => testProxy(p)));
}

// 重新载入（修改 proxies.txt / 环境变量后调用）
export function reloadProxies() {
  return loadProxies();
}
