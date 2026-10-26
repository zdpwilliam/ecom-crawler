// 华为商城（vmall）直连通道。
// 搜索：POST https://openapi.vmall.com/mcp/v1/search/queryPrd —— 需要会话 Cookie（CSRF-TOKEN/euid）
//       + 同值 `csrfToken` 请求头 + 任意 32hex tid（从 csrftoken.js 响应引导，匿名可用）。
// 详情：GET https://www.vmall.com/product/<prdId>.html → 302 → item.vmall.com/comdetail（Next.js SSR），
//       __NEXT_DATA__ 里含 mainData.current.base（每个 SKU 的名称/价格/品牌/规格）与
//       productOptions.gbomAttrMappings（规格维度 → 各 SKU 的选项映射）。
//       跳转链每跳都会 set-cookie（HWWAFSESID 等），必须带 Cookie 罐逐跳跟随。
import crypto from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { mapApiProducts } from './api-parse.js';
import { isStopped } from '../../stop-flag.js';
import { netThrottle } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://www.vmall.com/',
  Origin: 'https://www.vmall.com',
};

/** 会话引导：GET csrftoken.js 收 set-cookie（CSRF-TOKEN / euid / HWWAFSESID）。 */
async function huaweiSession(log) {
  await netThrottle(log); // 全局节流：跨通道共用计时
  const res = await undiciFetch('https://openapi.vmall.com/csrftoken.js', {
    headers: BASE_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  const jar = setCookies.map((c) => c.split(';')[0]).filter(Boolean);
  const csrf = jar.find((c) => c.startsWith('CSRF-TOKEN='))?.split('=')[1] || '';
  if (!csrf) log('华为会话引导未拿到 CSRF-TOKEN（响应可能异常），继续尝试');
  return { jar, csrf };
}

/** 带 Cookie 罐的手动跟随跳转（vmall 302 链每跳 set-cookie，自动跟随会丢）。 */
async function fetchWithRedirects(url, tries = 3, log = () => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (isStopped()) throw new Error('已手动停止采集');
      await netThrottle(log); // 全局节流：跨通道共用计时
      let jar = [];
      let cur = url;
      for (let hop = 0; hop < 6; hop++) {
        const res = await undiciFetch(cur, {
          headers: { ...BASE_HEADERS, ...(jar.length ? { Cookie: jar.join('; ') } : {}) },
          redirect: 'manual',
          signal: AbortSignal.timeout(30000),
        });
        const sc = res.headers.getSetCookie?.() || [];
        for (const c of sc) {
          const kv = c.split(';')[0];
          if (kv.includes('=') && !jar.some((x) => x.startsWith(kv.split('=')[0] + '='))) jar.push(kv);
        }
        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const loc = res.headers.get('location') || '';
          if (!loc) throw new Error(`跳转无 Location（HTTP ${res.status}）`);
          cur = new URL(loc, cur).href;
          continue;
        }
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      }
      throw new Error('跳转次数超限');
    } catch (e) {
      lastErr = String(e.cause?.code || e.message).slice(0, 80);
      log(`  华为请求失败(第${i}/${tries}次): ${lastErr}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw new Error(`华为商城请求失败: ${lastErr}`);
}

/** 华为商城搜索：queryPrd 接口直连（匿名可调，含价格/促销/评论数/库存）。 */
export async function fetchHuaweiProducts({ query, limit = 20, log = () => {} } = {}) {
  if (isStopped()) throw new Error('已手动停止采集');
  const { jar, csrf } = await huaweiSession(log);
  if (!csrf) return [];
  const body = {
    tid: crypto.randomBytes(16).toString('hex'),
    sid: '',
    keyword: query,
    pageNum: 1,
    pageSize: Math.min(limit, 48),
    searchSortField: 0,
    searchSortType: 'desc',
    screenParams: '{}',
    personalizeSearch: '2',
    portal: '1',
    lang: 'zh-CN',
    country: 'CN',
    searchFlag: '0',
    brandType: 0,
  };
  const res = await undiciFetch('https://openapi.vmall.com/mcp/v1/search/queryPrd', {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json;charset=UTF-8', Cookie: jar.join('; '), csrfToken: csrf },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200) {
    log(`华为搜索接口 HTTP ${res.status}（可能风控），回退浏览器渲染`);
    return [];
  }
  const j = await res.json().catch(() => null);
  if (!j || j.resultCode === '200917' || !Array.isArray(j.resultList)) {
    log(`华为搜索接口异常：${JSON.stringify(j).slice(0, 80)}`);
    return [];
  }
  const raw = j.resultList.map((it) => ({
    itemId: String(it.productId),
    title: String(it.name || it.skuName || it.briefName || '').trim(),
    brand: '华为',
    shop: String(it.shopName || '华为商城自营'),
    category: '',
    price: Number(it.promoPrice || it.price || 0) || 0,
    marketPrice: Number(it.price || 0) || 0,
    discount: Array.isArray(it.activityPromInfoList)
      ? it.activityPromInfoList.map((p) => p.promotionWords || p.promotionTag).filter(Boolean).join(' | ')
      : '',
    sales: Number(it.rateCount || 0) || 0, // 评价数（唯一公开的销量代理指标）
    url: `https://www.vmall.com/product/${it.productId}.html`,
    image: it.photoName ? `https://res.vmallres.com${it.photoPath || ''}${it.photoName}` : '',
    extra: {
      ...(it.skuCode ? { skuCode: it.skuCode } : {}),
      ...(it.skuCount ? { skuCount: it.skuCount } : {}),
      ...(it.displayTags ? { tags: it.displayTags } : {}),
      ...(it.isInv != null ? { inStock: it.isInv === 1 } : {}),
      ...(it.goodRate ? { goodRate: it.goodRate } : {}),
    },
  }));
  log(`华为搜索接口解析出 ${raw.length} 个商品（共 ${j.totalCount ?? '?'} 个）`);
  const mapped = mapApiProducts(raw.slice(0, limit), { name: '华为商城' }, 'huawei');
  return mapped;
}

/** 从 HTML 里平衡提取 script JSON（字符串感知；__NEXT_DATA__ 是纯 JSON，直接 parse）。 */
function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * 华为详情页直连：跟随跳转链取 comdetail SSR，解析 __NEXT_DATA__ 的 SPU/SKU。
 * SKU 结构：mainData.current.base[skuCode]（名称/价格/库存/gbomAttrList 规格值）。
 */
export async function fetchHuaweiDetailSpuSku({ itemId, url, log = () => {} } = {}) {
  const prdId = String(itemId || (url && url.match(/product\/(\d{8,})\.html/)?.[1]) || '');
  if (!prdId) throw new Error('华为详情缺 prdId');
  const html = await fetchWithRedirects(`https://www.vmall.com/product/${prdId}.html`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');
  const nd = extractNextData(html);
  const cur = nd?.props?.pageProps?.mainData?.current;
  if (!cur || !cur.base || typeof cur.base !== 'object') {
    log('华为详情 __NEXT_DATA__ 无 mainData.current.base（页面可能是错误态），仅回退浏览器路径');
    return { spu: null, skus: [] };
  }
  const baseEntries = Object.entries(cur.base);
  if (!baseEntries.length) return { spu: null, skus: [] };
  const [firstCode, first] = baseEntries[0];

  const spu = {
    spuId: String(cur.displayPrdVo?.prdId || nd?.props?.pageProps?.prdId || prdId),
    title: String(first.name || ''),
    brandName: String(first.brandName || '华为'),
    shopName: '华为商城自营',
    price: Number(first.price || 0) || 0,
    image: first.photoName ? `https://res.vmallres.com${first.photoPath || ''}${first.photoName}` : '',
    sbomCodes: baseEntries.map(([code]) => code),
  };
  // 类目：navData 是页面锚点（新品/手机…），取第一个非「新品」项做近似类目
  const navCat = (cur.displayPrdVo?.pivotalAttrList || []).find((a) => a?.attrName)?.attrName || '';
  if (navCat) spu.categoryName = String(navCat);

  // SKU：base 每项 = 一个 SKU；gbomAttrList 是该 SKU 的规格值（attrName/attrValue）
  const skus = baseEntries.map(([code, b]) => {
    const options = {};
    for (const a of b.gbomAttrList || []) {
      if (a?.attrName && a?.attrValue) options[a.attrName] = String(a.attrValue);
    }
    const dims = Object.values(options).join(' ');
    return {
      skuId: String(b.sbomCode || code),
      spuId: spu.spuId,
      name: String(b.name || b.sbomAbbr || dims || code),
      options,
      price: Number(b.price || 0) || 0,
      stock: Number(b.inventory?.inventoryQty ?? 0) || 0,
      image: b.photoName ? `https://res.vmallres.com${b.photoPath || ''}${b.photoName}` : '',
    };
  });
  log(`华为详情解析：SPU ✓，SKU ${skus.length} 个（base 直取）`);
  return { spu, skus };
}
