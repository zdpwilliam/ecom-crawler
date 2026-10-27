// 平台登录状态检测：每个平台「是否需要登录 / 是否已保存 Cookie / 登录态是否真实有效」。
// 检测方式分两层：
//   ① 实测探针（api）：用已保存 Cookie 真实调用一次该平台的轻量接口，
//      依据响应区分「有效 / 已失效 / 未知（风控或网络原因无法判定）」；
//   ② Cookie 有效期启发式（cookie-expiry）：无可用探针的平台，检查 Cookie 文件里
//      是否存在且未全部过期（expires<now），只能给「疑似有效」而非保证。
// 调度：按 settings.loginCheckMin 定时全量检测（0=关闭），结果持久化 data/login-status.json。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mtopCall } from './adapters/scrape/mtop-api.ts';
import { fetchVipProducts } from './adapters/scrape/vip-api.ts';
import { PLATFORMS } from './adapters/registry.ts';
import { loadSettings } from './settings.ts';
import { runLog } from './runlog.ts';
import { DATA_DIR } from './paths.ts';
import { acquireSession } from './session-pool.ts';
import { impersonatedFetch } from './http-client.ts';

const COOKIES_DIR = path.join(DATA_DIR, 'cookies');
const STATUS_FILE = path.join(DATA_DIR, 'login-status.json');

// 平台是否需要登录（与前端 PLATFORM_META 口径一致；此处为服务端单一来源）
export const NEED_LOGIN = {
  taobao: '必需',
  xianyu: '必需',
  vip: '必需',
  pdd: '必需',
  jd: '推荐',
  dewu: '推荐',
  suning: '不需要',
  huawei: '不需要',
  amazon: '不需要',
  // 2026-10-26 扩展四平台：网页端均无匿名公开数据入口（见 config.js 各平台探测结论）
  xiaohongshu: '必需',
  douyin: '必需',
  tiktok: '必需',
  kuaishou: '必需',
};

const statusText = {
  valid: '已登录 · 有效',
  invalid: '登录态已失效',
  probable: '疑似有效（未实测）',
  expired: 'Cookie 已全部过期',
  absent: '未登录（无 Cookie）',
  unknown: '无法判定（风控/网络）',
  none: '无需登录',
};

export function platformIds() {
  return PLATFORMS.map((p) => p.id);
}

function loadCookieArr(platform) {
  const fp = path.join(COOKIES_DIR, `${platform}.json`);
  if (!fs.existsSync(fp)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

/** Cookie 文件最后修改时间（秒）；无文件返回 0。用于判断「缓存是否比文件旧」。 */
function cookieFileMtime(platform) {
  const fp = path.join(COOKIES_DIR, `${platform}.json`);
  try {
    return Math.floor(fs.statSync(fp).mtimeMs / 1000);
  } catch {
    return 0;
  }
}

function cookieStats(arr) {
  const now = Date.now() / 1000;
  let expired = 0;
  let named = [];
  for (const c of arr) {
    const exp = Number(c?.expires);
    if (Number.isFinite(exp) && exp > 0 && exp < now) expired++;
    if (c?.name && /sess|token|sid|login|unb|munb|lgc|tracknick|uid|member/i.test(c.name)) named.push(c.name);
  }
  return { count: arr.length, expired, sessionish: named };
}

// ---------- 各平台实测探针 ----------
// 所有探针/启发式均接收 log 回调，把「检测验证过程」逐条输出（前端弹窗展示 + 服务端可观测）。

// 淘宝/闲鱼：mtop 轻量搜索请求；ret 直接区分 会话失效 / 成功
async function probeMtop({ platform, host, api, version, data, log }: any) {
  const arr = loadCookieArr(platform);
  const cookieStr = arr.map((c) => `${c.name}=${c.value}`).join('; ');
  log(`探针目标：https://${host} mtop.${api.split('.').pop()} v${version}（注入 ${arr.length} 条 Cookie）`);
  const r = await mtopCall({ host, api, version, data, cookieStr, log });
  if (r.ok) return { status: 'valid', detail: `mtop 探针返回 SUCCESS（Cookie ${arr.length} 条已注入）` };
  const ret = String(r.ret || '');
  if (/SESSION|RGV587|NEED_LOGIN|FORBIDDEN|punish/i.test(ret)) {
    return { status: 'invalid', detail: `mtop ret=${ret.slice(0, 80)}（会话失效/风控）` };
  }
  return { status: 'unknown', detail: `mtop ret=${ret.slice(0, 80)}（非会话类错误，无法判定登录态）` };
}

// 唯品会：登录态必需的 rank/list 接口本身就是探针
async function probeVip(log: (m: string) => void) {
  try {
    log('探针目标：唯品会 mobile 搜索接口（登录态必需通道，query=手机 limit=1）');
    const rows = await fetchVipProducts({ query: '手机', limit: 1, log });
    if (rows.length) return { status: 'valid', detail: `唯品会接口返回 ${rows.length} 条商品（登录态有效）` };
    return { status: 'invalid', detail: '接口返回 0 条（登录态被拒或已失效）' };
  } catch (e) {
    if (/forbidden|TFS|403/i.test(e.message)) return { status: 'invalid', detail: `接口被风控拒绝：${String(e.message).slice(0, 80)}` };
    return { status: 'unknown', detail: `探针请求失败（网络/代理）：${String(e.message).slice(0, 80)}` };
  }
}

// 京东：订单中心需登录，302 到 passport 即失效
async function probeJd(log: (m: string) => void) {
  const arr = loadCookieArr('jd');
  const cookieStr = arr.map((c) => `${c.name}=${c.value}`).join('; ');
  // 会话三元绑定：探针与采集共用同一粘性会话的 UA（登录态 ↔ 指纹一致，避免 Cookie 换 UA 的错配信号）
  const sess = acquireSession('jd', true);
  const ua = sess.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  log('探针目标：https://order.jd.com/center/list.action（订单中心，需登录）');
  log(`注入 ${arr.length} 条 Cookie 发起请求（redirect=manual 观察跳转，引擎=${sess.userAgent ? `会话#${sess.sid}` : '默认'}）`);
  // TLS 伪装通道：impit 对齐真 Chrome 握手（undici 裸 TLS 一眼被识别为非浏览器）
  const r = await impersonatedFetch({
    url: 'https://order.jd.com/center/list.action',
    headers: { Cookie: cookieStr, 'User-Agent': ua },
    proxy: sess.proxy,
    redirect: 'manual',
  });
  log(`响应 HTTP ${r.status}（引擎=${r.engine}）`);
  const loc = r.headers.get?.('location') || (r.headers as any)?.location || '';
  if (r.status >= 300 && r.status < 400 && /passport|login/i.test(String(loc))) {
    log(`被重定向到 ${String(loc).slice(0, 70)} → 判定登录态失效`);
    return { status: 'invalid', detail: `订单中心 302 → ${String(loc).slice(0, 70)}（登录态失效）` };
  }
  if (r.status === 200) return { status: 'valid', detail: '订单中心返回 200（登录态有效）' };
  return { status: 'unknown', detail: `订单中心 HTTP ${r.status}，无法判定` };
}

// 无实测探针的平台：Cookie 有效期启发式
function probeHeuristic(platform: string, log: (m: string) => void) {
  const arr = loadCookieArr(platform);
  const st = cookieStats(arr);
  log('该平台暂无匿名可调探针接口，退回 Cookie 有效期启发式判定');
  log(`统计：共 ${st.count} 条，过期 ${st.expired} 条，会话类 Cookie：${st.sessionish.slice(0, 5).join(', ') || '未识别'}`);
  if (st.expired >= st.count) return { status: 'expired', detail: `共 ${st.count} 条 Cookie 已全部过期` };
  return {
    status: 'probable',
    detail: `共 ${st.count} 条（过期 ${st.expired}），含会话 Cookie：${st.sessionish.slice(0, 3).join(',') || '未识别'}；该平台暂无匿名可调探针，建议采集一次验证`,
  };
}

/** 检测核心（过程日志经 emit 输出）。 */
async function checkLoginCore(platform: string, emit: (m: string) => void) {
  const need = NEED_LOGIN[platform] || '推荐';
  const base = { platform, needLogin: need, checkedAt: new Date().toISOString(), method: '-', status: 'absent', count: 0, expired: 0, detail: '' };
  // 「不需要」登录的平台也支持设置登录信息（部分评论/问答等数据登录后才可见）：
  // 未保存 Cookie 时仍标记 absent 引导可选设置；保存了 Cookie 则照常走启发式判定。
  const arr = loadCookieArr(platform);
  if (need === '不需要' && !arr) {
    emit('该平台采集链路为匿名直连（无需登录）；如需查看登录后可见的评论等数据，可「提取登录态」保存 Cookie');
    return {
      ...base,
      status: 'absent',
      detail: '匿名可采（无需登录）；如需看登录后评论等数据，可「提取登录态」保存 Cookie',
    };
  }
  if (!arr) {
    emit(`未找到 Cookie 文件（cookies/${platform}.json 不存在或为空）`);
    return {
      ...base,
      detail: NEED_LOGIN[platform] === '必需' ? '必需登录态但尚未保存 Cookie，请先「提取登录态」' : '尚未保存 Cookie（可选，保存后可走更多通道）',
    };
  }
  const st = cookieStats(arr);
  emit(`读取 Cookie 文件 cookies/${platform}.json：共 ${st.count} 条，过期 ${st.expired} 条`);
  emit(`识别到会话类 Cookie：${st.sessionish.slice(0, 5).join(', ') || '未识别'}`);
  const withStats = { ...base, count: st.count, expired: st.expired };
  if (st.expired >= st.count) {
    emit('全部 Cookie 已过期 → 直接判定失效（跳过探针实测）');
    return { ...withStats, status: 'expired', method: 'cookie-expiry', detail: `共 ${st.count} 条 Cookie 已全部过期，请重新提取登录态` };
  }
  try {
    if (platform === 'taobao') {
      const r = await probeMtop({ platform, host: 'h5api.m.taobao.com', api: 'mtop.relationrecommend.wirelessrecommend.recommend', version: '2.0', data: { appId: '1092', q: '手机', page: 1, tabCode: 'ware' }, log: emit });
      return { ...withStats, ...r, method: 'api' };
    }
    if (platform === 'xianyu') {
      const r = await probeMtop({ platform, host: 'h5api.m.goofish.com', api: 'mtop.taobao.idlemtopsearch.pc.search', version: '1.0', data: { keyword: '手机', pageNum: 1 }, log: emit });
      return { ...withStats, ...r, method: 'api' };
    }
    if (platform === 'vip') {
      const r = await probeVip(emit);
      return { ...withStats, ...r, method: 'api' };
    }
    if (platform === 'jd') {
      const r = await probeJd(emit);
      return { ...withStats, ...r, method: 'api' };
    }
    const r = probeHeuristic(platform, emit);
    return { ...withStats, ...r, method: 'cookie-expiry' };
  } catch (e) {
    emit(`探针执行异常：${String(e.message).slice(0, 90)}`);
    return { ...withStats, status: 'unknown', method: 'api', detail: `探针异常：${String(e.message).slice(0, 90)}` };
  }
}

/** 检测单个平台登录态（不落盘；结果由调用方缓存/持久化）。
 *  返回值附带 logs：检测验证过程日志（带时间戳，前端弹窗展示）。 */
export async function checkLogin(platform: string, log: (m: string) => void = () => {}) {
  const logs: string[] = [];
  const emit = (m: string) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`;
    logs.push(line);
    log(line);
  };
  emit(`开始检测「${platform}」登录态（登录要求：${NEED_LOGIN[platform] || '推荐'}）`);
  const r = await checkLoginCore(platform, emit);
  emit(`结论：${statusText[r.status] || r.status} —— ${r.detail}`);
  return { ...r, logs };
}

// ---------- 缓存 / 持久化 / 调度 ----------

let cache = { at: null, results: {} };

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function loadPersisted() {
  try {
    if (fs.existsSync(STATUS_FILE)) cache = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
  } catch {
    /* ignore */
  }
}
loadPersisted();

/** 全量检测所有平台并持久化（缓存只存结果，不存过程日志）。 */
export async function checkAll() {
  const results = {};
  for (const p of platformIds()) {
    const { logs: _omit, ...r } = await checkLogin(p);
    results[p] = r;
  }
  cache = { at: new Date().toISOString(), results };
  persist();
  runLog(`登录态定时检测完成：${Object.values(results).filter((r: any) => r.status === 'valid').length} 个平台有效`);
  return cache;
}

/** 面板读取：两类平台先补一次启发式（不发网络请求）：
 *  ① 缓存缺失；② 缓存比 Cookie 文件旧（提取/重登保存后缓存未失效——修复「登录成功但面板仍显示未登录」）。 */
export function getStatus({ fillMissing = false } = {}) {
  if (fillMissing) {
    for (const p of platformIds()) {
      const cached = cache.results[p];
      const fileMtime = cookieFileMtime(p);
      const cachedAt = cached?.checkedAt ? Math.floor(new Date(cached.checkedAt).getTime() / 1000) : 0;
      const stale = cached && fileMtime > cachedAt; // 文件在检测之后被更新过（如一键提取刚保存）
      // 旧版本对「不需要」平台强制缓存 none（语义已改为可选登录态支持），重新计算一次
      if (cached && !stale && cached.status !== 'none') continue;
      const need = NEED_LOGIN[p] || '推荐';
      const arr = loadCookieArr(p);
      // 「不需要」平台同样按有无 Cookie 走 absent/启发式（可选登录态支持；不再强制覆盖为 none）
      if (!arr) cache.results[p] = { platform: p, needLogin: need, status: 'absent', detail: need === '不需要' ? '匿名可采（无需登录）；如需看登录后评论等数据，可「提取登录态」保存 Cookie' : '尚未保存 Cookie', count: 0, expired: 0, method: '-', checkedAt: null };
      else {
        const st = cookieStats(arr);
        const r = st.expired >= st.count
          ? { status: 'expired', detail: `共 ${st.count} 条 Cookie 已全部过期` }
          : probeHeuristic(p, () => {});
        cache.results[p] = { platform: p, needLogin: need, status: r.status, detail: r.detail, count: st.count, expired: st.expired, method: 'cookie-expiry', checkedAt: null };
      }
    }
    persist();
  }
  return { at: cache.at, results: cache.results };
}

/** 单平台检测并回写缓存（面板「检测」按钮用：否则检测结果被下一次面板读取覆盖回旧值）。
 *  过程日志仅随 HTTP 响应返回，不写入缓存/持久化文件。 */
export async function checkLoginCached(platform: string, log?: (m: string) => void) {
  const r = await checkLogin(platform, log);
  const { logs: _omit, ...cached } = r;
  cache.results[platform] = cached;
  cache.at = new Date().toISOString();
  persist();
  return r;
}

/** 手动保存登录信息：前端粘贴 Cookie JSON（Playwright/开发者工具导出的数组）。 */
export function saveCookieFile(platform, cookies) {
  if (!platformIds().includes(platform)) throw new Error(`未知平台：${platform}`);
  if (!Array.isArray(cookies) || !cookies.length) throw new Error('cookies 需为非空数组（每条含 name/value 字段）');
  const cleaned = cookies
    .filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string')
    .map((c) => ({ name: c.name, value: c.value, domain: c.domain || '', path: c.path || '/', expires: c.expires ?? c.expirationDate ?? null }));
  if (!cleaned.length) throw new Error('没有可识别的 Cookie 条目（每条需含 name 与 value）');
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  const fp = path.join(COOKIES_DIR, `${platform}.json`);
  fs.writeFileSync(fp, JSON.stringify(cleaned, null, 2), 'utf8');
  return { file: fp, count: cleaned.length };
}

let timer = null;
let lastRunAt = 0;
/** 定时检测调度：每轮运行时读取最新 settings.loginCheckMin（0=关闭），改设置即时生效。 */
export function startLoginCheckScheduler() {
  if (timer) clearInterval(timer);
  const tick = async () => {
    try {
      const s = await loadSettings();
      const min = Number(s.loginCheckMin) || 0;
      if (min <= 0) return;
      if (lastRunAt && Date.now() - lastRunAt < min * 60 * 1000 - 15000) return; // 未到周期
      lastRunAt = Date.now();
      await checkAll();
    } catch (e) {
      console.warn('[login-check] 定时检测失败：', e.message);
    }
  };
  // 启动 5 秒后先跑一轮（启动即有基线状态），之后每 5 分钟检查一次「该不该跑」
  setTimeout(tick, 5000);
  timer = setInterval(tick, 5 * 60 * 1000);
}
