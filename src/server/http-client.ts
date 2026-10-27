// 统一 HTTP 客户端：直连通道的 TLS 指纹伪装（P0-2）。
// 背景：undici/Node 原生 fetch 的 TLS 握手（JA3/JA4）与真浏览器差异显著，是五层检测模型里
// 本项目最大的缺口。impit（curl-impersonate 思路的 Node 绑定）按浏览器逐项对齐
// 密码套件顺序/GREASE/HTTP2 参数，让 mtop/vip/京东探针与直连通道的握手与真浏览器一致。
//
// 降级链：impit 可用 → 伪装请求；impit 缺失/请求抛错（如原生二进制不兼容）→ undici 原路兜底。
// 注意（调研报告 3.3）：HTTPS 经 HTTP 中间人代理会用代理自身栈重新握手，TLS 伪装白做；
// SOCKS5 不改写指纹——有 SOCKS 代理时伪装仍然有效。
// 统一返回轻量 Response 接口 { status, text(), json(), headers.getSetCookie() }，调用方无感切换。
import { fetch as undiciFetch } from 'undici';

type ImpResp = {
  status: number;
  text(): Promise<string>;
  json(): Promise<any>;
  headers: { getSetCookie?: () => string[]; get?: (k: string) => string | null };
};

let _impitMod: any | undefined; // undefined=未探测, null=不可用
let _impitDisabled = false; // 运行期自愈：impit 连续失败后本轮直接走 undici，避免每个请求都白试一次

async function impitMod() {
  if (_impitMod !== undefined) return _impitMod;
  try {
    _impitMod = await import('impit');
  } catch {
    console.warn('[http-client] impit 不可用（未安装或平台不支持），TLS 伪装降级为 Node 原生 TLS');
    _impitMod = null;
  }
  return _impitMod;
}

// Impit 实例按 proxyUrl+redirectMode 缓存（实例持有连接池；per-request proxy 不被支持）
const _impitClients = new Map<string, any>();
const IMPIT_TIMEOUT_MS = 30000;

async function impitFor(proxy?: string, redirect: 'follow' | 'manual' = 'follow') {
  const mod = await impitMod();
  if (!mod) return null;
  const key = `${proxy || '__direct__'}|${redirect}`;
  if (_impitClients.has(key)) return _impitClients.get(key);
  try {
    const client = new mod.Impit({
      browser: 'chrome', // 与指纹池主力浏览器对齐（Chrome 份额最高，伪装收益最大）
      ...(proxy ? { proxyUrl: proxy } : {}),
      requestTimeout: IMPIT_TIMEOUT_MS,
      followRedirects: redirect !== 'manual', // 探针需要 manual 观察 302 落点
    });
    _impitClients.set(key, client);
    return client;
  } catch (e) {
    console.warn(`[http-client] Impit 实例创建失败（proxy=${proxy || '直连'}）：${e.message?.slice?.(0, 80)}`);
    return null;
  }
}

export interface ImpersonatedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  proxy?: string;
  timeout?: number;
  /** 'manual' 时跟随重定向关闭（探针观察 302 落点用） */
  redirect?: 'follow' | 'manual';
  /** SOCKS 代理 impit 支持有限：false 时调用方可直接选 undici 路径 */
  allowImpersonate?: boolean;
}

/** 用浏览器 TLS 指纹发请求；失败自动降级 undici。返回统一轻量响应。 */
export async function impersonatedFetch(req: ImpersonatedRequest): Promise<ImpResp & { engine: 'impit' | 'undici' }> {
  const { url, method = 'GET', headers = {}, body, proxy, timeout, redirect = 'follow' } = req;
  const allow = req.allowImpersonate !== false && !_impitDisabled && !/^socks/i.test(proxy || '');
  if (allow) {
    const client = await impitFor(proxy, redirect);
    if (client) {
      try {
        const r = (await client.fetch(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
        })) as any;
        return wrapResponse(r, 'impit');
      } catch (e) {
        // impit 层失败：记录一次并降级。连续 5 次失败认为环境不可用，本轮关闭探测。
        _impitFailCount++;
        if (_impitFailCount >= 5) {
          _impitDisabled = true;
          console.warn('[http-client] impit 连续失败 5 次，TLS 伪装已自动关闭（全部走 undici 兜底）');
        }
        console.warn(`[http-client] impit 请求失败，降级 undici：${String(e.message).slice(0, 100)}`);
      }
    }
  }
  // undici 兜底（保持与旧行为完全一致：dispatcher 支持全部代理类型）
  const dispatcher = proxy ? (await getDispatcher(proxy)) : undefined;
  const r = await undiciFetch(url, {
    method: method as any,
    headers: headers as any,
    ...(body !== undefined ? { body } : {}),
    ...(dispatcher ? { dispatcher } as any : {}),
    ...(redirect === 'manual' ? { redirect: 'manual' } : {}),
    signal: AbortSignal.timeout(timeout || 30000),
  });
  return wrapResponse(r, 'undici');
}

let _impitFailCount = 0;

function wrapResponse(r: any, engine: 'impit' | 'undici'): ImpResp & { engine: 'impit' | 'undici' } {
  return {
    engine,
    status: r.status,
    text: () => r.text(),
    json: () => r.json(),
    headers: r.headers,
  };
}

// dispatcher 复用 proxy-pool 的缓存（http→ProxyAgent，socks→fetch-socks）
async function getDispatcher(proxy: string) {
  const { getProxyDispatcher } = await import('./proxy-pool.ts');
  return getProxyDispatcher(proxy);
}
