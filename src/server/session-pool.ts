// 会话池（SessionPool）：Cookie + 代理 IP + 指纹打包成一个「虚拟用户」整体轮换。
// 参考 Crawlee SessionPool 范式 + scrapy-rotating-proxies 的死代理/被封代理区分：
//   • 同一会话固定同一代理 + 同一指纹（三元绑定）——避免「烧掉的 IP 配新 Cookie」自相矛盾组合；
//   • 登录态通道（mtop/vip/jd 直连）按平台强制粘性：整个采集运行期间固定一个会话；
//   • 封禁语义化（session.retire() / markBad() 对齐 Crawlee）：
//       session-expired → 会话失效（Cookie 问题），提示重登，代理/指纹无罪；
//       ip-banned      → IP 被封，retire 整个会话（整包丢弃），换下一个会话；
//       challenge      → 风控挑战（滑块/验证码），降级浏览器渲染处置；
//       transient      → 网络抖动，markBad 轻记，连续 3 次自动 retire。
import { randomFingerprint, randomCookies, fingerprintEnabled } from './fingerprint.ts';
import { pickProxy, reportFailure, reportSuccess } from './proxy-pool.ts';
import { runLog } from './runlog.ts';

interface Session {
  sid: number;
  fp: any; // 请求档案口径字段（userAgent/acceptLanguage/viewport/mobile/...）
  cookies: any[];
  proxy?: string;
  uses: number;
  bads: number;
  retired: boolean;
  retiredAt?: string;
  lastUsedAt?: number;
}

let _sessions: Session[] = [];
let _sidSeq = 0;
// 平台 → 会话粘性绑定（登录态通道：同一平台整个运行期固定同一会话）
const _sticky = new Map<string, number>();
// 会话 retire 原因统计（面板/日志可读）
const _retireStats = { 'session-expired': 0, 'ip-banned': 0, 'challenge': 0, 'transient': 0 } as Record<string, number>;

/**
 * 重建会话池（每次采集运行前调用，对齐旧 refreshProfilePool 时机）。
 * n 个虚拟用户，代理从代理池轮询分配（保证会话之间代理尽量不同）。
 */
export function renewSessionPool(n = 10) {
  _sessions = [];
  _sidSeq = 0;
  _sticky.clear();
  if (!fingerprintEnabled()) {
    runLog('会话池未启用（指纹随机化已关闭）：单会话直连模式');
    return _sessions;
  }
  const usedProxy = new Set<string>();
  for (let i = 0; i < n; i++) {
    // 轮询式挑代理：优先选本次还没用过的，会话间代理重叠才轮换语义才有意义
    let proxy = pickProxy();
    let tries = 0;
    while (proxy && usedProxy.has(proxy) && tries < n * 2) {
      proxy = pickProxy();
      tries++;
    }
    if (proxy) usedProxy.add(proxy);
    _sessions.push({
      sid: ++_sidSeq,
      fp: randomFingerprint(),
      cookies: randomCookies(),
      proxy,
      uses: 0,
      bads: 0,
      retired: false,
    });
  }
  return _sessions;
}

/** 旧接口兼容：collectors.ts 调用点与指纹面板沿用「请求档案池」语义。 */
export function refreshProfilePool(n = 10) {
  return renewSessionPool(n).map(toProfile);
}

function toProfile(s: Session) {
  return { ...s.fp, cookies: s.cookies, proxy: s.proxy, sid: s.sid };
}

function alive() {
  return _sessions.filter((s) => !s.retired);
}

/**
 * 取一个会话的请求档案。sticky=true（登录态通道）时按平台粘性绑定：
 * 同一平台整个运行期返回同一会话（Cookie ↔ 代理 ↔ 指纹不变），除非该会话被 retire。
 * sticky=false（匿名列表页）时按 uses 最少 + 随机挑一个，保留轮换语义。
 */
export function acquireSession(platformId?: string, sticky = false): any {
  const pool = alive();
  if (!pool.length) {
    // 指纹随机化关闭：返回一个空壳档案（与旧 buildRequestProfile 关闭分支等价）
    return { sid: 0, proxy: pickProxy(), userAgent: '', acceptLanguage: 'zh-CN,zh;q=0.9', ip: '', locale: 'zh-CN', viewport: [1280, 800] };
  }
  if (sticky && platformId) {
    const bound = _sticky.get(platformId);
    const cur = pool.find((s) => s.sid === bound);
    if (cur) {
      cur.uses++;
      cur.lastUsedAt = Date.now();
      return toProfile(cur);
    }
    // 绑定健康度最好的会话（bads 最少，同分随机）
    const sorted = [...pool].sort((a, b) => a.bads - b.bads || Math.random() - 0.5);
    const s = sorted[0];
    _sticky.set(platformId, s.sid);
    s.uses++;
    runLog(`平台 ${platformId} 绑定会话#${s.sid}（Cookie+代理+指纹粘性，代理=${s.proxy || '直连'}）`);
    return toProfile(s);
  }
  // 非粘性：uses 最少优先（负载均衡）+ 随机打散
  const minUses = Math.min(...pool.map((s) => s.uses));
  const candidates = pool.filter((s) => s.uses === minUses);
  const s = candidates[Math.floor(Math.random() * candidates.length)];
  s.uses++;
  s.lastUsedAt = Date.now();
  return toProfile(s);
}

/** 会话 retire：整包丢弃（Cookie+代理+指纹一起作废），绑定在该会话上的平台下次 acquire 换新。 */
export function retireSession(sid: number, reason: keyof typeof _retireStats = 'transient') {
  const s = _sessions.find((x) => x.sid === sid);
  if (!s || s.retired) return;
  s.retired = true;
  s.retiredAt = new Date().toISOString();
  _retireStats[reason] = (_retireStats[reason] || 0) + 1;
  if (s.proxy) reportFailure(s.proxy); // 会话被烧大概率代理也进冷却，交给代理池统一裁决
  runLog(`会话#${sid} 已 retire（原因=${reason}，代理=${s.proxy || '直连'}）：整包丢弃，后续请求换新会话`);
}

/** 轻度记坏：连续 3 次自动 retire（区别于一次性硬封禁）。 */
export function markBadSession(sid: number, reason: keyof typeof _retireStats = 'transient') {
  const s = _sessions.find((x) => x.sid === sid);
  if (!s || s.retired) return;
  s.bads++;
  if (reason === 'ip-banned' || reason === 'session-expired') {
    retireSession(sid, reason);
    return;
  }
  if (s.bads >= 3) {
    retireSession(sid, reason);
  }
}

/** 请求成功回报：会话健康度恢复 + 代理报成功。 */
export function reportSessionOk(sid: number) {
  const s = _sessions.find((x) => x.sid === sid);
  if (!s) return;
  s.bads = Math.max(0, s.bads - 1);
  if (s.proxy) reportSuccess(s.proxy);
}

// ---------- 封禁语义化分类（P0-3） ----------
// 参考 Crawlee session.retire()/markBad()：先「分类」再「处置」，不再把挑战页粗暴归 unknown。

export type BanKind = 'ok' | 'session-expired' | 'ip-banned' | 'challenge' | 'transient' | 'soft-block';

const SESSION_EXPIRED_RE = /SESSION_EXPIRED|NEED_LOGIN|SESSION_OVERDUE|not.?logged|会话失效|登录已过期|302.*passport/i;
const CHALLENGE_RE = /RGV587|punish|验证码|滑块|captcha|nc_|\bsep-verify| verifies|Punish|风控拦截|Forbidden by TFS|安全验证/i;
const IP_BANNED_HINT_RE = /^\s*$/; // 403/429 + 空体 = 典型 IP 封禁
const SOFT_BLOCK_RE = /too many requests|rate.?limit|频繁|稍后再试/i;

/**
 * 把 HTTP 状态码 + 响应体（或 mtop ret）分类为封禁语义，并给出建议处置。
 * 返回 { kind, action, hint } —— kind 用于 retire/markBad 决策，action 用于通道降级。
 */
export function classifyBan({ status = 0, body = '', ret = '' }: { status?: number; body?: string; ret?: string }): { kind: BanKind; action: 'none' | 'relogin' | 'rotate' | 'browser-fallback' | 'retry' | 'backoff'; hint: string } {
  const text = String(ret || body || '').slice(0, 2000);
  if (ret && ret.startsWith('SUCCESS')) return { kind: 'ok', action: 'none', hint: '' };
  if (SESSION_EXPIRED_RE.test(text)) {
    return { kind: 'session-expired', action: 'relogin', hint: '登录态已失效：请到「爬虫设置 → 登录态」重新提取（代理与指纹无嫌疑）' };
  }
  if (CHALLENGE_RE.test(text)) {
    return { kind: 'challenge', action: 'browser-fallback', hint: '命中风控挑战（滑块/验证码）：降级浏览器渲染通道处置' };
  }
  if (status === 403 || status === 429) {
    if (IP_BANNED_HINT_RE.test(String(body || '')) || status === 429) {
      const kind: BanKind = status === 429 ? 'soft-block' : 'ip-banned';
      return {
        kind,
        action: kind === 'soft-block' ? 'backoff' : 'rotate',
        hint: status === 429 ? '触发频率限制：拉长间隔退避重试' : 'IP 被目标拒绝（403 空响应）：换代理/会话重试',
      };
    }
    // 403 但有内容：可能挑战页
    if (CHALLENGE_RE.test(text)) return { kind: 'challenge', action: 'browser-fallback', hint: '403 挑战页：降级浏览器渲染' };
    return { kind: 'ip-banned', action: 'rotate', hint: '403 拒绝：换代理/会话重试' };
  }
  if (SOFT_BLOCK_RE.test(text)) {
    return { kind: 'soft-block', action: 'backoff', hint: '软性限流：退避后重试' };
  }
  return { kind: 'transient', action: 'retry', hint: '' };
}

/** 分类结果 → 会话处置（acquireSession 拿到的 sid 用）。 */
export function applyBanToSession(sid: number, kind: BanKind) {
  if (!sid) return;
  if (kind === 'ip-banned') retireSession(sid, 'ip-banned');
  else if (kind === 'session-expired') retireSession(sid, 'session-expired');
  else if (kind === 'challenge') markBadSession(sid, 'challenge');
  else if (kind === 'transient' || kind === 'soft-block') markBadSession(sid, 'transient');
}

/** 会话池状态摘要（运行日志/诊断用）。 */
export function sessionStats() {
  const alive = _sessions.filter((s) => !s.retired);
  return {
    total: _sessions.length,
    alive: alive.length,
    retired: _sessions.length - alive.length,
    retireReasons: { ..._retireStats },
    sticky: [..._sticky.entries()].map(([p, sid]) => ({ platform: p, sid })),
  };
}
