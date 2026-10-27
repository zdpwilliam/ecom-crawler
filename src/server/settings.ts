// 运行时设置：爬虫每次调用的参数，持久化到 data/settings.json，保存后立即生效（无需重启）。
// 生效机制：
//   - 网络参数直接改写 config.js 导出的 NETWORK 对象（generic.js 每次调用时读取，天然即时生效）
//   - 指纹随机化改写 process.env.RANDOMIZE_FINGERPRINT（fingerprint.js 每次调用时读取）
//   - 存储后端在保存时同步更新（由 index.js 调 setBackend）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NETWORK } from './adapters/scrape/config.ts';
import { setFingerprintMode } from './fingerprint.ts';
import { DATA_DIR } from './paths.ts';

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export const DEFAULTS = Object.freeze({
  storageBackend: 'sqlite', // sqlite | mongodb
  delayMin: 2000, // 请求间随机延迟下限(ms)——页面间全局节流也用它，防封号
  delayMax: 6000, // 请求间随机延迟上限(ms)
  timeout: 30000, // 单页超时(ms)
  retries: 3, // 失败重试次数
  renderWait: 1500, // Playwright 渲染等待(ms)
  usePlaywright: true, // 优先无头浏览器渲染
  randomizeFingerprint: true, // UA/IP/语言/视口 随机化
  loginCheckMin: 30, // 登录态定时检测间隔（分钟），0=关闭
  fpMode: 'mixed', // 指纹池端型筛选：mixed=混合（全部12套）/ desktop=仅桌面 / mobile=仅手机端（含平板）
  topAppKey: '', // 淘宝开放平台 AppKey（官方 API 凭证）
  topAppSecret: '', // 淘宝开放平台 AppSecret
  topSession: '', // 淘宝卖家授权 Session（可选，评价/自有商品接口需要）
});

let cache = null;

export async function loadSettings() {
  if (cache) return cache;
  let saved = {};
  try {
    if (fs.existsSync(SETTINGS_FILE)) saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    console.warn('[settings] 读取 settings.json 失败：', e.message);
  }
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export async function saveSettings(patch: Record<string, any> = {}) {
  await loadSettings();
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);
  if (patch.storageBackend) cache.storageBackend = patch.storageBackend === 'mongodb' ? 'mongodb' : 'sqlite';
  if ('delayMin' in patch) cache.delayMin = num(patch.delayMin, cache.delayMin);
  if ('delayMax' in patch) cache.delayMax = num(patch.delayMax, cache.delayMax);
  if ('timeout' in patch) cache.timeout = num(patch.timeout, cache.timeout);
  if ('retries' in patch) cache.retries = Math.max(1, num(patch.retries, cache.retries));
  if ('renderWait' in patch) cache.renderWait = num(patch.renderWait, cache.renderWait);
  if ('usePlaywright' in patch) cache.usePlaywright = patch.usePlaywright !== false && patch.usePlaywright !== 'false';
  if ('randomizeFingerprint' in patch)
    cache.randomizeFingerprint = patch.randomizeFingerprint !== false && patch.randomizeFingerprint !== 'false';
  if ('loginCheckMin' in patch) {
    const n = Number(patch.loginCheckMin);
    cache.loginCheckMin = Number.isFinite(n) && n >= 0 ? Math.round(n) : cache.loginCheckMin;
  }
  for (const k of ['topAppKey', 'topAppSecret', 'topSession']) {
    if (k in patch) (cache as Record<string, any>)[k] = String(patch[k] || '').trim();
  }
  if ('fpMode' in patch && ['mixed', 'desktop', 'mobile'].includes(patch.fpMode)) cache.fpMode = patch.fpMode;
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2), 'utf8');
  applySettings(cache);
  return cache;
}

/** 把设置套到运行时（NETWORK 对象 + 环境变量），每次调用即时读取，改完立即生效。 */
export function applySettings(s = cache || DEFAULTS) {
  NETWORK.delayMin = s.delayMin;
  NETWORK.delayMax = s.delayMax;
  NETWORK.timeout = s.timeout;
  NETWORK.retries = s.retries;
  NETWORK.renderWait = s.renderWait;
  NETWORK.usePlaywright = s.usePlaywright !== false;
  process.env.RANDOMIZE_FINGERPRINT = s.randomizeFingerprint === false ? 'false' : 'true';
  // 指纹池端型模式：后续 randomFingerprint/refreshProfilePool 只从对应子池抽取，保存即生效
  setFingerprintMode(s.fpMode);
  // 淘宝官方 API 凭证：适配器每次实例化都读环境变量，这里同步写入即保存生效
  process.env.TOP_APP_KEY = s.topAppKey || '';
  process.env.TOP_APP_SECRET = s.topAppSecret || '';
  process.env.TOP_SESSION = s.topSession || '';
}
