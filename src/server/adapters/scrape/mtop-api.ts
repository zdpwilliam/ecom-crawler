// 淘宝/闲鱼共享 mtop h5 签名通道。
// 签名机制：mtop 要求 _m_h5_tk token（匿名可引导获取）+ sign = md5(token&t&appKey&data)。
// 实测：匿名引导 token 成功、签名验证通过；但搜索接口要求登录态
// （淘宝匿名 ret=request is forbidden，闲鱼匿名触发 SM 滑块 RGV587）。
// 因此：data/cookies/<平台>.json 有登录态时走接口直连；无登录态返回空数组回退浏览器渲染路径。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { mapApiProducts, apiProductsFromBodies } from './api-parse.ts';
import { isStopped } from '../../stop-flag.ts';
import { netThrottle } from './config.ts';
import { COOKIES_DIR } from '../../paths.ts';
import { acquireSession, classifyBan } from '../../session-pool.ts';
import { impersonatedFetch } from '../../http-client.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const APP_KEY = '12574478';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function loadCookies(platformId, log) {
  const file = path.join(COOKIES_DIR, `${platformId}.json`);
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
 * mtop h5 请求（token 引导 + md5 签名）——完整版：返回 {ok, ret, data, ban?}，
 * 供采集（只关心 data）与登录态检测（需要区分 FAIL_SYS_SESSION_EXPIRED 等错误码）共用。
 * 网络层：impit TLS 伪装（JA3 对齐真 Chrome），降级 undici；代理/UA 来自会话池粘性绑定。
 */
export async function mtopCall(opts: { host: string; api: string; version: string; data: any; cookieStr?: string; log?: (m?: string) => void; proxy?: string; userAgent?: string }) {
  const { host, api, version, data, cookieStr = '', proxy, log = (_m?: string) => {} } = opts;
  const userAgent = opts.userAgent || UA;
  const referer = `https://${host.replace('h5api.', '')}`;
  const baseHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
    Referer: referer,
    Origin: new URL(referer).origin,
  };
  // 1) token 引导：无 token 请求返回 FAIL_SYS_TOKEN_EMPTY 并 set-cookie _m_h5_tk
  let jar = [];
  if (cookieStr) jar = cookieStr.split('; ').filter(Boolean);
  await netThrottle(log); // 全局节流：token 引导也是真实请求
  const t0 = String(Date.now());
  const r0 = await impersonatedFetch({
    url: `https://${host}/h5/${api}/${version}/?jsv=2.7.2&appKey=${APP_KEY}&t=${t0}`,
    method: 'POST',
    headers: { ...baseHeaders, ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
    body: `data=${encodeURIComponent(JSON.stringify(data))}`,
    proxy,
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
  const r = await impersonatedFetch({
    url: `https://${host}/h5/${api}/${version}/?jsv=2.7.2&appKey=${APP_KEY}&t=${t}&sign=${sign}&api=${encodeURIComponent(api)}&v=${version}&type=originaljson&dataType=json`,
    method: 'POST',
    headers: { ...baseHeaders, Cookie: jar.join('; ') },
    body: `data=${encodeURIComponent(JSON.stringify(data))}`,
    proxy,
  });
  const j: any = await r.json().catch(() => null);
  const ret = j?.ret?.[0] || 'EMPTY';
  if (ret.startsWith('SUCCESS')) return { ok: true, ret, data: j.data };
  log(`mtop ret: ${ret.slice(0, 90)}`);
  // 封禁语义化：区分 会话失效（重登）/ 风控挑战（浏览器降级）/ IP 封禁（换会话）
  const ban = classifyBan({ ret });
  if (ban.hint) log(`mtop 封禁语义判定[${ban.kind}]：${ban.hint}`);
  return { ok: false, ret, data: j?.data ?? null, ban };
}

/** 采集用薄包装：只关心 data 载荷（ret 非成功返回 null，行为与旧版一致）。 */
export async function mtopRequest(opts) {
  const r = await mtopCall(opts);
  return r.ok ? r.data : null;
}

/** 平台 mtop 搜索通用流程：无登录态 → 引导提取；有登录态 → 签名接口 → 通用深搜解析。
 *  会话三元绑定：登录态通道强制粘性——同一平台整个运行期固定同一会话（Cookie+代理+指纹不变）。 */
async function mtopSearch({ platformId, cfgName, host, api, version, buildData, query, limit, log, urlFallback = (id) => id }) {
  const cookieStr = loadCookies(platformId, log);
  if (!cookieStr) {
    log(`${cfgName} 无登录态，mtop 接口需登录（到「爬虫设置 → 登录态提取」选 ${platformId} 登录后可走接口直连）；本次回退浏览器渲染`);
    return [];
  }
  if (isStopped()) throw new Error('已手动停止采集');
  // 粘性会话：代理与 UA 来自绑定的虚拟用户，与登录态 Cookie 构成稳定三元组
  const sess = acquireSession(platformId, true);
  if (sess.proxy) log(`mtop 直连通道：粘性会话#${sess.sid} 代理=${sess.proxy}（UA=${(sess.userAgent || UA).slice(0, 40)}…）`);
  const data = await mtopRequest({ host, api, version, data: buildData(query), cookieStr, log, proxy: sess.proxy, userAgent: sess.userAgent || UA });
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
export async function fetchTaobaoProducts(opts: { query?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { query, limit = 20, log = (_m?: string) => {} } = opts;
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

/** 淘宝详情（登录态必需）：h5 详情接口 mtop.taobao.detail.getdetail 6.0。
 *  返回 data：item（标题/图片）、skuBase（规格维度+SKU 列表）、skuCore（SKU 价格）、
 *  props（参数表）、descInfo（详情描述 HTML，懒加载内容的接口侧来源）。
 *  注意：description/images 直接由 collectDetail 通过 directSku 透传（浏览器登录墙时唯一数据源）。 */
export async function fetchTaobaoDetailSpuSku(opts: { itemId?: string; url?: string; log?: (m?: string) => void } = {}) {
  const { itemId, log = (_m?: string) => {} } = opts;
  const cookieStr = loadCookies('taobao', log);
  if (!cookieStr) {
    log('淘宝详情接口需登录态（无 Cookie），跳过直连');
    return { spu: null, skus: [], description: '', images: [] };
  }
  if (isStopped()) throw new Error('已手动停止采集');
  const sess = acquireSession('taobao', true);
  const data = await mtopRequest({
    host: 'h5api.m.taobao.com',
    api: 'mtop.taobao.detail.getdetail',
    version: '6.0',
    data: { itemNumId: String(itemId) },
    cookieStr,
    log,
    proxy: sess.proxy,
    userAgent: sess.userAgent || UA,
  });
  if (!data) return { spu: null, skus: [], description: '', images: [] };

  const item = data.item || {};
  // 价格多源：item.price > priceInfo > skuCore 当前 SKU
  let price = 0;
  const priceText =
    String(item?.price || '') ||
    String(data?.price?.price?.priceText || '') ||
    String(data?.skuCore?.sku2info?.[String(itemId)]?.price?.priceText || '');
  const pm = priceText.match(/([\d.]+)/);
  if (pm) price = parseFloat(pm[1]) || 0;

  const spu = item.title
    ? {
        spuId: String(itemId),
        title: String(item.title).replace(/<[^>]*>/g, ''),
        brand: String(data?.brand?.name || item?.brand || ''),
        category: String(data?.category?.name || data?.item?.categoryName || ''),
        price,
        image: String((item.images || [])[0] || ''),
      }
    : null;

  // SKU：skuBase.skus（propPath=pid;vid;...）× skuBase.props（维度名/值）+ skuCore 价格
  const skus = [];
  const skuBase = data.skuBase || {};
  const propIndex = {};
  for (const p of skuBase.props || []) {
    for (const v of p.values || []) propIndex[`${p.pid}:${v.vid}`] = `${p.name || p.pid}:${v.name || v.vid}`;
  }
  const sku2info = data.skuCore?.sku2info || {};
  for (const s of skuBase.skus || []) {
    const opts2 = String(s.propPath || '')
      .split(';')
      .filter(Boolean)
      .map((kv) => propIndex[kv] || kv);
    const info = sku2info[String(s.skuId)] || {};
    skus.push({
      skuId: String(s.skuId || ''),
      name: opts2.join(' / '),
      options: Object.fromEntries(opts2.map((o) => o.split(':').map((x) => x.trim()))),
      price: parseFloat(String(info?.price?.priceText || '').replace(/[^\d.]/g, '')) || 0,
    });
    if (skus.length >= 60) break;
  }
  if (skus.length) log(`淘宝详情接口：SPU ✓，SKU ${skus.length} 条（skuBase）`);
  else log('淘宝详情接口：无 SKU 明细（单规格或接口未返回 skuBase）');

  // 描述（懒加载内容的接口侧来源）与图片集
  const description = String(data.descInfo?.showDesc || data.item?.descShort || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000);
  const images = (item.images || []).map((u) => (/^https?:/.test(u) ? u : 'https:' + u)).slice(0, 30);
  return { spu, skus, description, images };
}

/** 淘宝评论（登录态必需）：h5 评价接口 mtop.taobao.rate.detaillist.get。
 *  响应结构随版本变化：宽松深搜「带 content+date 的对象数组」作为评论列表。 */
export async function fetchTaobaoReviews(opts: { itemId?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { itemId, limit = 20, log = (_m?: string) => {} } = opts;
  const cookieStr = loadCookies('taobao', log);
  if (!cookieStr) {
    log('淘宝评论接口需登录态（评价数据游客不可见），跳过直连');
    return [];
  }
  if (isStopped()) throw new Error('已手动停止采集');
  const sess = acquireSession('taobao', true);
  const data = await mtopRequest({
    host: 'h5api.m.taobao.com',
    api: 'mtop.taobao.rate.detaillist.get',
    version: '6.0',
    data: { auctionNumId: String(itemId), currentPage: 1, pageSize: limit, rateType: '', orderType: 'feedbackdate', folded: '0' },
    cookieStr,
    log,
    proxy: sess.proxy,
    userAgent: sess.userAgent || UA,
  });
  if (!data) return [];
  // 宽松深搜：找含 content 且带时间/星级字段的对象数组（rateDetail.rateList 或同级变体）
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object' || found.length >= limit) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    if (typeof node.content === 'string' && node.content.length > 2 && (node.date || node.feedbackDate || node.rateDate)) {
      found.push(node);
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(data);
  if (!found.length) {
    log('淘宝评论接口未解析到评论（可能该商品无评价，或接口结构变化）');
    return [];
  }
  log(`淘宝评论接口解析出 ${found.length} 条评论`);
  return found.slice(0, limit).map((r) => {
    const star = parseFloat(String(r.rateStar || r.star || ''));
    return {
      rating: isNaN(star) ? 5 : Math.min(5, Math.max(1, Math.round(star / 20 || star))),
      content: String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, 800),
      author: String(r.user?.nick || r.displayUserNick || r.userNick || ''),
      date: String(r.date || r.feedbackDate || r.rateDate || ''),
    };
  });
}

/** 闲鱼搜索（登录态必需）：PC 搜索走 idlemtopsearch.pc.search。 */
export async function fetchXianyuProducts(opts: { query?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { query, limit = 20, log = (_m?: string) => {} } = opts;
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
