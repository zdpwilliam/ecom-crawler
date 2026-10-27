// 唯品会商品搜索「直连接口」通道：不依赖浏览器渲染，直接调 mapi-pc 的 rank + list/v2 接口。
// 背景：搜索页前端行为不稳定（经常只出模板壳不触发商品 XHR），而接口本身带登录态就能访问，
// 返回结构化字段（品牌/价格/市场价/折扣/销量），远比 DOM 启发式完整。
// 流程：rank(拿 pid 列表) → list/v2(scene=search, productIds=...) → 解析映射。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as undiciFetch } from 'undici';
import { socksDispatcher } from 'fetch-socks';
import { pickProxy, getProxyDispatcher } from '../../proxy-pool.ts';
import { apiProductsFromBodies, mapApiProducts } from './api-parse.ts';
import { isStopped } from '../../stop-flag.ts';
import { netThrottle } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.resolve(__dirname, '..', '..', '..', 'data', 'cookies');

// 唯品会 PC 前端固定公共 api_key（页面 JS 内置，非私密凭证）
const API_KEY = '70f71280d5d547b2a7bb370a529aeea1';
const RANK_URL = 'https://mapi-pc.vip.com/vips-mobile/rest/shopping/pc/search/product/rank';
const LIST_URL = 'https://mapi-pc.vip.com/vips-mobile/rest/shopping/pc/product/module/list/v2';
const DETAIL_URL = 'https://mapi-pc.vip.com/vips-mobile/rest/shopping/pc/detail/main/v6';

function loadLoginCookies() {
  const p = path.join(COOKIES_DIR, 'vip.json');
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

const unwrapJsonp = (t) => JSON.parse(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')));

async function jget(url, headers, dispatcher, tries = 3, log = (_m?: string) => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    // 全局节流：与浏览器通道/其它直连请求共用计时，保证任意两次真实请求至少隔一个档位
    await netThrottle(log);
    // 最后一次尝试绕过代理直连（唯品会国内站，代理挂了仍可采）
    const d = dispatcher && i === tries ? undefined : dispatcher;
    try {
      const res = await undiciFetch(url, { headers, dispatcher: d });
      return await res.text();
    } catch (e) {
      lastErr = String(e.cause?.code || e.cause?.message || e.message).slice(0, 80);
      log(`  接口尝试${i}失败: ${lastErr}${d === undefined && dispatcher ? '（已绕过代理直连）' : ''}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw new Error(`接口请求失败: ${lastErr}`);
}

/**
 * 直连获取唯品会搜索商品（结构化全字段）。
 * @returns {Promise<Array>} 标准商品记录数组
 */
export async function fetchVipProducts({ query, limit = 30, log = (_m?: string) => {} }) {
  const cookies = loadLoginCookies();
  if (!cookies.length) {
    throw new Error('唯品会直连接口需要登录态 Cookie（data/cookies/vip.json 不存在）');
  }
  const val = (n) => (cookies.find((c) => c.name === n) || {}).value || '';
  const userId = val('VipRUID') || val('user_id');
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const headers = {
    Cookie: cookieHeader,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://category.vip.com/',
    Accept: '*/*',
  };
  const proxy = pickProxy();
  const dispatcher = proxy ? await getProxyDispatcher(proxy) : undefined;
  log(`直连接口通道：${proxy ? '代理 ' + proxy : '直连'}（登录态 ${cookies.length} 条）`);

  const common = {
    callback: 'cb',
    app_name: 'shop_pc',
    app_version: '4.0',
    warehouse: val('vip_wh') || 'VIP_NH',
    fdc_area_id: val('pc_fdc_area_id') || '104104101',
    client: 'pc',
    mobile_platform: '1',
    province_id: val('vip_province') || '104104',
    api_key: API_KEY,
    mars_cid: val('mars_cid'),
    wap_consumer: 'b',
    __useMapi: '1',
  };
  if (userId) (common as any).user_id = userId;

  // 1) rank：拿商品 pid 列表
  const q1 = new URLSearchParams({ ...common, keyword: query, page_offset: '0', sort: '0', pageCount: String(Math.max(limit, 20)) });
  const t1 = await jget(`${RANK_URL}?${q1}`, headers, dispatcher, 3, log);
  const r1 = unwrapJsonp(t1);
  if (r1.code !== 1 || !Array.isArray(r1.data?.products) || !r1.data.products.length) {
    throw new Error(`rank 接口无数据：code=${r1.code} msg=${r1.msg || ''}`);
  }
  const total = r1.data.total || r1.data.products.length;
  const pids = r1.data.products.slice(0, Math.min(limit, 60)).map((p) => p.pid).filter(Boolean);
  log(`rank 接口成功：命中 ${total} 个商品，取前 ${pids.length} 个`);

  // 2) list/v2：批量拿完整字段（scene=search）。
  //    该接口单次最多接受 50 个 productIds（超出直接 code=10001 整批拒绝），按 50 分批请求。
  const chunks = [];
  for (let i = 0; i < pids.length; i += 50) chunks.push(pids.slice(i, i + 50));
  const bodies = [];
  for (const [ci, chunk] of chunks.entries()) {
    if (isStopped()) throw new Error('已手动停止采集');
    if (chunks.length > 1) log(`list 接口第 ${ci + 1}/${chunks.length} 批（${chunk.length} 个 pid，接口单批上限 50）`);
    const q2 = new URLSearchParams({ ...common, productIds: chunk.join(','), scene: 'search', priceShowType: '1' });
    const t2 = await jget(`${LIST_URL}?${q2}`, headers, dispatcher, 3, log);
    const r2 = unwrapJsonp(t2);
    if (r2.code !== 1) {
      throw new Error(`list 接口拒绝：code=${r2.code} msg=${r2.msg || ''}`);
    }
    bodies.push({ body: t2 });
  }
  const raw = apiProductsFromBodies(bodies);
  if (!raw.length) {
    // 字段映射未命中：给出样例便于校准
    const sample = JSON.stringify(unwrapJsonp(bodies[0].body).data || {}).slice(0, 300);
    throw new Error(`list 接口返回但字段映射未命中，样例：${sample}`);
  }
  log(`list 接口成功：解析出 ${raw.length} 个结构化商品（含品牌/价格）`);
  const cfg = { name: '唯品会' };
  let mapped = mapApiProducts(raw.slice(0, limit), cfg, 'vip');

  // 3) 字段补全：list/v2 搜索场景不返回类目/店铺名（brandStoreSn 只是 ID），
  //    逐个调详情接口补 category / shopName（顺带验证品牌），最多补 10 个控制耗时。
  const needEnrich = mapped.filter((p) => !p.category || !p.shopName).slice(0, 10);
  if (needEnrich.length) {
    log(`字段补全：${needEnrich.length} 个商品缺类目/店铺，调详情接口补全…`);
    let ok = 0;
    for (const p of needEnrich) {
      if (isStopped()) throw new Error('已手动停止采集');
      try {
        const d = await fetchVipDetailSpuSku({ itemId: p.itemId, log: () => {} });
        const s: any = d.spu || {};
        if (!p.category && s.categoryName) p.category = s.categoryName;
        if (!p.shopName && (s.vendorName || s.brandName)) p.shopName = s.vendorName || s.brandName;
        if (!p.brand && s.brandName) p.brand = s.brandName;
        ok++;
      } catch (e) {
        log(`  补全失败 itemId=${p.itemId}：${String(e.message).slice(0, 60)}`);
      }
      // 补全请求的间隔由 fetchVipDetailSpuSku 内部的 netThrottle 统一保证
    }
    log(`字段补全完成：${ok}/${needEnrich.length} 个商品已补类目/店铺`);
  }
  return mapped;
}

/**
 * 从详情页捕获的接口响应中解析唯品会 SPU（商品级）与 SKU（规格组合）。
 * 数据源：详情页 XHR `mapi-pc.vip.com/.../shopping/pc/detail/main/v6`（纯 JSON）：
 *   data.base       → SPU（spuId / prodSpuId / 标题 / 品牌 / 类目）
 *   data.saleProps  → 规格维度（type: size/color，values 每档含 vid，color 档带 productId）
 *   data.products   → productId → 单 SKU 信息（priceView 价格 / smallImage / merchandiseSn）
 * @param {Array<{url:string, body:string}>} apiBodies 浏览器捕获的接口响应
 * @returns {{ spu: object|null, skus: Array, propGroups: Array }}
 */
export function extractVipDetailSpuSku(apiBodies) {
  for (const { body } of apiBodies || []) {
    let text = String(body).trim();
    // 兼容 JSONP：callback( {...} ) → 取括号内 JSON（前缀必须是合法标识符，避免误切字符串里的括号）
    const s = text.indexOf('(');
    const e = text.lastIndexOf(')');
    if (s > 0 && e > s && /^[a-zA-Z_$][\w$]*$/.test(text.slice(0, s))) text = text.slice(s + 1, e);
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      continue;
    }
    const d = j && j.data;
    if (!d || !d.base || !d.products) continue;

    const b = d.base;
    const spu = {
      spuId: String(b.spuId || ''),
      prodSpuId: String(b.prodSpuId || ''),
      productId: String(b.productId || d.productId || ''),
      title: String(b.title || ''),
      brandId: String(b.brandId || ''),
      brandName: String(b.brandShowName || ''),
      brandStoreSn: String(b.brandStoreSn || ''),
      categoryId: String(b.categoryId || ''),
      categoryName: String(b.categoryName || ''),
      vendorName: String(b.vendorName || ''),
      vendorCode: String(b.vendorCode || ''),
    };

    // 规格维度：size/color 每档的名称与 vid；color 档的 value 带 productId（可用于对应 SKU）
    const propGroups = (Array.isArray(d.saleProps) ? d.saleProps : []).map((p) => ({
      name: String(p.name || ''),
      type: String(p.type || ''),
      values: (Array.isArray(p.values) ? p.values : []).map((v) => ({
        name: String(v.name || ''),
        vid: String(v.vid ?? ''),
        ...(v.productId ? { productId: String(v.productId) } : {}),
      })),
    }));

    // SKU：data.products 里每个 productId 一个 SKU；规格从 saleProps 按 productId 反查
    const skus = [];
    for (const [pid, p] of Object.entries(d.products || {})) {
      if (!p || typeof p !== 'object') continue;
      const pv: any = (p as any).priceView || {};
      const dims: any = {};
      for (const g of propGroups) {
        const hit = g.values.find((v) => v.productId === String(pid));
        if (hit) dims[g.type || g.name] = hit.name;
      }
      skus.push({
        skuId: String(pid),
        spuId: spu.spuId,
        size: dims.size || '',
        color: dims.color || '',
        price: parseFloat(String(pv.finalPrice?.price ?? pv.salePrice?.salePrice ?? '').replace(/[^\d.]/g, '')) || 0,
        marketPrice: parseFloat(String(pv.salePrice?.saleMarketPrice ?? pv.comparePrice?.price ?? '').replace(/[^\d.]/g, '')) || 0,
        discount: String(pv.salePrice?.saleDiscount || ''),
        merchandiseSn: String((p as any).merchandiseSn || ''),
        stock: 0, // 库存在 stock.vip.com 接口，此响应不含
        image: String((p as any).smallImage || ''),
        longTitle: String((p as any).longTitle || ''),
      });
      if (skus.length >= 60) break;
    }
    if (spu.spuId || skus.length) return { spu, skus, propGroups };
  }
  return { spu: null, skus: [], propGroups: [] };
}

/**
 * 直连获取唯品会详情页 SPU/SKU（POST detail/main/v6，登录态 Cookie 必需）。
 * 详情页前端行为不稳（经常不触发主接口 XHR），直连该接口是 SPU/SKU 最稳来源。
 * @param {{ itemId: string, log?: Function }} p
 * @returns {Promise<{ spu: object|null, skus: Array, propGroups: Array }>}
 */
export async function fetchVipDetailSpuSku({ itemId, log = (_m?: string) => {} }) {
  const cookies = loadLoginCookies();
  if (!cookies.length) {
    throw new Error('唯品会详情接口需要登录态 Cookie（data/cookies/vip.json 不存在）');
  }
  const val = (n) => (cookies.find((c) => c.name === n) || {}).value || '';
  const userId = val('VipRUID') || val('user_id');
  const headers = {
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Referer: 'https://detail.vip.com/',
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: '*/*',
  };
  const proxy = pickProxy();
  const dispatcher = proxy ? await getProxyDispatcher(proxy) : undefined;
  log(`详情直连接口通道：${proxy ? '代理 ' + proxy : '直连'}（登录态 ${cookies.length} 条）`);
  const form = new URLSearchParams({
    app_name: 'shop_pc',
    app_version: '4.0',
    warehouse: val('vip_wh') || 'VIP_NH',
    fdc_area_id: val('pc_fdc_area_id') || '104104101',
    client: 'pc',
    mobile_platform: '1',
    province_id: val('vip_province') || '104104',
    api_key: API_KEY,
    mars_cid: val('mars_cid'),
    wap_consumer: 'b',
    is_default_area: '1',
    scene: 'detail',
    productId: String(itemId),
  });
  if (userId) form.set('user_id', userId);
  // 从详情 URL 提取 productId：detail-<brandId>-<productId>.html
  let lastErr;
  for (let i = 1; i <= 3; i++) {
    await netThrottle(log); // 全局节流：跨通道共用计时
    try {
      // 最后一次尝试绕过代理直连（唯品会国内站，代理挂了仍可采）
      const d = dispatcher && i === 3 ? undefined : dispatcher;
      const res = await undiciFetch(DETAIL_URL, { method: 'POST', headers, body: String(form), dispatcher: d });
      const text = await res.text();
      const j = JSON.parse(text);
      if (j.code !== 1) throw new Error(`detail 接口拒绝：code=${j.code} msg=${j.msg || ''}`);
      const r = extractVipDetailSpuSku([{ url: DETAIL_URL, body: text }]);
      if (!r.spu && !r.skus.length) throw new Error('detail 接口返回但未解析到 SPU/SKU');
      log(`详情接口成功：SPU ${r.spu ? '✓' : '✗'}，SKU ${r.skus.length} 个，规格维度 ${(r.propGroups || []).length} 组`);
      return r;
    } catch (e) {
      lastErr = e;
      log(`  详情接口尝试${i}失败: ${String(e.message).slice(0, 80)}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw lastErr;
}
