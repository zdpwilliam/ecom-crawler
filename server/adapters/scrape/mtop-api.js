// 淘宝/闲鱼共享 mtop h5 签名通道。
// 签名机制：mtop 要求 _m_h5_tk token（匿名可引导获取）+ sign = md5(token&t&appKey&data)。
// 实测：匿名引导 token 成功、签名验证通过；但搜索接口要求登录态
// （淘宝匿名 ret=request is forbidden，闲鱼匿名触发 SM 滑块 RGV587）。
// 因此：data/cookies/<平台>.json 有登录态时走接口直连；无登录态返回空数组回退浏览器渲染路径。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch } from 'undici';
import { mapApiProducts, apiProductsFromBodies } from './api-parse.js';
import { isStopped } from '../../stop-flag.js';
import { netThrottle } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const APP_KEY = '12574478';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function loadCookies(platformId, log) {
  const file = path.join(process.cwd(), 'data', 'cookies', `${platformId}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    log(`登录态文件 ${platformId}.json 读取失败，忽略`);
    return null;
  }
}

/**
 * mtop h5 请求（token 引导 + md5 签名）——完整版：返回 {ok, ret, data}，
 * 供采集（只关心 data）与登录态检测（需要区分 FAIL_SYS_SESSION_EXPIRED 等错误码）共用。
 */
export async function mtopCall({ host, api, version, data, cookieStr = '', log = () => {} }) {
  const referer = `https://${host.replace('h5api.', '')}`;
  const baseHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': UA,
    Referer: referer,
    Origin: new URL(referer).origin,
  };
  // 1) token 引导：无 token 请求返回 FAIL_SYS_TOKEN_EMPTY 并 set-cookie _m_h5_tk
  let jar = [];
  if (cookieStr) jar = cookieStr.split('; ').filter(Boolean);
  await netThrottle(log); // 全局节流：token 引导也是真实请求
  const t0 = String(Date.now());
  const r0 = await undiciFetch(`https://${host}/h5/${api}/${version}/?jsv=2.7.2&appKey=${APP_KEY}&t=${t0}`, {
    method: 'POST',
    headers: { ...baseHeaders, ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
    body: `data=${encodeURIComponent(JSON.stringify(data))}`,
  });
  const sc = r0.headers.getSetCookie?.() || [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    if (kv.includes('=') && !jar.some((x) => x.startsWith(kv.split('=')[0] + '='))) jar.push(kv);
  }
  const token = jar.find((c) => c.startsWith('_m_h5_tk='))?.split('=')[1]?.split('_')[0];
  if (!token) {
    const body = await r0.text().catch(() => '');
    log(`mtop token 引导失败: ${body.slice(0, 80)}`);
    return { ok: false, ret: 'TOKEN_BOOTSTRAP_FAILED', data: null };
  }
  // 2) 签名请求
  await netThrottle(log); // 全局节流：跨通道共用计时
  const t = String(Date.now());
  const sign = md5(`${token}&${t}&${APP_KEY}&${JSON.stringify(data)}`);
  const r = await undiciFetch(
    `https://${host}/h5/${api}/${version}/?jsv=2.7.2&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${encodeURIComponent(api)}&v=${version}&type=originaljson&dataType=json`,
    { method: 'POST', headers: { ...baseHeaders, Cookie: jar.join('; ') }, body: `data=${encodeURIComponent(JSON.stringify(data))}` }
  );
  const j = await r.json().catch(() => null);
  const ret = j?.ret?.[0] || 'EMPTY';
  if (ret.startsWith('SUCCESS')) return { ok: true, ret, data: j.data };
  log(`mtop ret: ${ret.slice(0, 90)}`);
  return { ok: false, ret, data: j?.data ?? null };
}

/** 采集用薄包装：只关心 data 载荷（ret 非成功返回 null，行为与旧版一致）。 */
export async function mtopRequest(opts) {
  const r = await mtopCall(opts);
  return r.ok ? r.data : null;
}

/** 平台 mtop 搜索通用流程：无登录态 → 引导提取；有登录态 → 签名接口 → 通用深搜解析。 */
async function mtopSearch({ platformId, cfgName, host, api, version, buildData, query, limit, log, urlFallback = (id) => id }) {
  const cookieStr = loadCookies(platformId, log);
  if (!cookieStr) {
    log(`${cfgName} 无登录态，mtop 接口需登录（到「爬虫设置 → 登录态提取」选 ${platformId} 登录后可走接口直连）；本次回退浏览器渲染`);
    return [];
  }
  if (isStopped()) throw new Error('已手动停止采集');
  const data = await mtopRequest({ host, api, version, data: buildData(query), cookieStr, log });
  if (!data) return [];
  // 通用深搜：从 mtop 响应里抽「长得像商品的对象」（结构随平台版本变化，宽松适配）
  const raw = apiProductsFromBodies([{ body: JSON.stringify(data) }]);
  if (!raw.length) {
    log('mtop 响应未解析出商品（接口结构可能变化），回退浏览器渲染');
    return [];
  }
  log(`mtop 接口解析出 ${raw.length} 个商品`);
  const mapped = mapApiProducts(raw.slice(0, limit), { name: cfgName }, platformId);
  // mtop 响应通常不带商品链接：按平台详情页规则兜底
  for (const p of mapped) {
    if (!p.url) p.url = urlFallback(p.itemId);
  }
  return mapped;
}

/** 淘宝搜索（登录态必需）：PC 搜索走 relationrecommend 推荐接口，appId=1092。 */
export async function fetchTaobaoProducts({ query, limit = 20, log = () => {} } = {}) {
  const rows = await mtopSearch({
    platformId: 'taobao',
    cfgName: '淘宝/天猫',
    host: 'h5api.m.taobao.com',
    api: 'mtop.relationrecommend.wirelessrecommend.recommend',
    version: '2.0',
    buildData: (q) => ({ appId: '1092', appPresent: '1', q, tabCode: 'ware', page: 1, sort: '0', style: 'list', fromFilter: false, searchCat: '0' }),
    query,
    limit,
    log,
    urlFallback: (id) => `https://item.taobao.com/item.htm?id=${encodeURIComponent(id)}`,
  });
  return rows;
}

/** 闲鱼搜索（登录态必需）：PC 搜索走 idlemtopsearch.pc.search。 */
export async function fetchXianyuProducts({ query, limit = 20, log = () => {} } = {}) {
  const rows = await mtopSearch({
    platformId: 'xianyu',
    cfgName: '闲鱼',
    host: 'h5api.m.goofish.com',
    api: 'mtop.taobao.idlemtopsearch.pc.search',
    version: '1.0',
    buildData: (q) => ({ keyword: q, fromFilter: '', pageNum: 1, sortType: '' }),
    query,
    limit,
    log,
    urlFallback: (id) => `https://www.goofish.com/item?id=${encodeURIComponent(id)}`,
  });
  return rows;
}
