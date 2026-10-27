// 苏宁易购直连通道：详情页 SSR 内嵌数据（var sn = {...}）提 SPU/SKU。
// 苏宁详情页是服务端渲染（208KB，含标题/类目/店铺/clusterMap 变体映射/规格表），
// 无需浏览器；搜索页 SSR 无价格（价格由前端另行填充），搜索仍走浏览器渲染路径。
import { pickProxy } from '../../proxy-pool.ts';
import { impersonatedFetch } from '../../http-client.ts';
import { mapApiProducts } from './api-parse.ts';
import { isStopped } from '../../stop-flag.ts';
import { netThrottle } from './config.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function sget(url, tries = 3, log = (_m?: string) => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (isStopped()) throw new Error('已手动停止采集');
      await netThrottle(log); // 全局节流：跨通道共用计时
      // 苏宁是国内站：最后一次尝试绕过代理直连（VPN 断连时仍可采，代理不可达不再空耗重试）
      const proxy = i === tries ? undefined : pickProxy();
      log(`苏宁请求（第${i}/${tries}次）代理=${proxy ? 'VPN' : '直连'}${proxy && i === tries ? '（代理异常，改直连）' : ''}（TLS 伪装）`);
      const res = await impersonatedFetch({
        url,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
        timeout: 30000,
        proxy,
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = String(e.cause?.code || e.message).slice(0, 80);
      log(`  请求失败: ${lastErr}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw new Error(`苏宁请求失败: ${lastErr}`);
}

/** 平衡花括号提取：从 html 中 key 首次出现后的第一个 { 开始，配对到闭合 }。 */
function extractBalanced(html, key) {
  const i = html.indexOf(key);
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  if (s < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = s; j < html.length; j++) {
    const c = html[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (!depth) return html.slice(s, j + 1);
    }
  }
  return null;
}

/**
 * 苏宁价格/店铺批量接口（ds.suning.com，**匿名可调**）：
 *   https://ds.suning.com/ds/generalForTile/<段1>,<段2>-025-2-0000000000-1--cb.jsonp?callback=cb
 *   段格式：0000000<partNumber>_____<mdmGroupId>_<brandId>__
 *   实测：mdmGroupId/brandId 填占位值（全 0）也返回正确价格——商品号（7 个 0 前缀 + partNumber）
 *   是唯一必要信息。搜索 SSR 与详情 SSR 都不含价格（前端用本接口填充）。
 * 返回：Map(partNumber → { price, vendorName })，vendorName 可当店铺名（自营为「苏宁自营」）。
 */
export async function fetchSuningDsPrices(partNumbers, log = (_m?: string) => {}) {
  const out = new Map();
  const list = [...new Set((partNumbers || []).filter(Boolean).map(String))];
  for (let i = 0; i < list.length; i += 20) {
    const chunk = list.slice(i, i + 20);
    const segs = chunk.map((id) => `0000000${id}_____R1901001_000000000__`).join(',');
    const url = `https://ds.suning.com/ds/generalForTile/${segs}-025-2-0000000000-1--cb.jsonp?callback=cb`;
    try {
      const t = await sget(url, 2, log);
      const j = JSON.parse(t.slice(t.indexOf('(') + 1, t.lastIndexOf(')')));
      let hit = 0;
      for (const it of j?.rs || []) {
        const id = String(it.cmmdtyCode || '').replace(/^0{7}/, '');
        if (!id) continue;
        out.set(id, { price: Number(it.price) || 0, vendorName: String(it.vendorName || '') });
        hit++;
      }
      log(`价格接口第 ${Math.floor(i / 20) + 1} 批：命中 ${hit}/${chunk.length} 个`);
    } catch (e) {
      log(`价格接口第 ${Math.floor(i / 20) + 1} 批失败：${String(e.message).slice(0, 70)}`);
    }
  }
  return out;
}

/**
 * 苏宁搜索页直连：SSR 含全部商品块（res-img：sellPoint 链接 + img alt 标题 + def-price datasku）。
 * SSR 不含价格与真实店铺码（站点自己都渲染 0000000000 占位，前端调 ds.suning.com 二次填充），
 * 因此解析后批量调价格接口补 price/店铺名。
 */
export async function fetchSuningProducts(opts: { query?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { query, limit = 20, log = (_m?: string) => {} } = opts;
  const html = await sget(`https://search.suning.com/${encodeURIComponent(query)}/`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');
  const raw = [];
  const seen = new Set();
  // 商品块以 res-img 划界：块内 sellPoint 链接 + img alt + def-price
  for (const chunk of html.split(/<div[^>]*class="res-img"/).slice(1)) {
    const partNum = (chunk.match(/href="\/\/product\.suning\.com\/\d+\/(\d+)\.html"/) || [])[1] || '';
    if (!partNum || seen.has(partNum)) continue;
    const title = (chunk.match(/<img[^>]*alt="([^"]{5,200})"/) || [])[1] || '';
    if (!title) continue;
    seen.add(partNum);
    const image = (chunk.match(/<img[^>]*src="(\/\/imgservice[^"]+)"/) || [])[1] || '';
    const brandId = (chunk.match(/brand_id="(\d+)"/) || [])[1] || '';
    // SSR 里店铺码本身就是 0000000000 占位（站点前端后续填充），URL 保留原样即可正常跳转
    const link = (chunk.match(/href="(\/\/product\.suning\.com\/\d+\/\d+\.html)"/) || [])[1] || '';
    raw.push({
      itemId: partNum,
      title: String(title).trim(),
      brand: '',
      shop: '',
      category: '',
      price: 0,
      marketPrice: 0,
      discount: '',
      sales: 0,
      url: `https:${link || `//product.suning.com/0000000000/${partNum}.html`}`,
      image: image ? `https:${image}` : '',
      ...(brandId ? { extra: { brandId } } : {}),
    });
    if (raw.length >= Math.min(limit, 48)) break;
  }
  // 价格/店铺补全：批量调 ds.suning.com（SSR 无价格，¥0 占位必须在此修正）
  if (raw.length) {
    const priceMap = await fetchSuningDsPrices(raw.map((r) => r.itemId), log);
    let filled = 0;
    for (const r of raw) {
      const d = priceMap.get(String(r.itemId));
      if (d && d.price > 0) {
        r.price = d.price;
        if (d.vendorName) r.shop = d.vendorName;
        filled++;
      }
    }
    log(`价格/店铺补全：${filled}/${raw.length} 个商品已补真实价格`);
  }
  log(`搜索页解析出 ${raw.length} 个商品（价格/店铺来自 ds 接口）`);
  const mapped = mapApiProducts(raw.slice(0, limit), { name: '苏宁易购' }, 'suning');
  return mapped;
}

/**
 * 苏宁详情页直连：解析 var sn = {...}（商品级数据 + clusterMap 变体映射）。
 * SKU 结构：clusterMap[].color（颜色ID）× itemCuPartNumber[].versionId（版本ID）→ partNumber；
 * 颜色/版本显示名在规格选择区 <li versionid="..." title="显示名">。
 * 注意：苏宁 SSR 不含价格（前端另行填充），SPU.price 恒为 0。
 */
export async function fetchSuningDetailSpuSku(opts: { itemId?: string; url?: string; log?: (m?: string) => void } = {}) {
  const { itemId, url, log = (_m?: string) => {} } = opts;
  // URL 形态 product.suning.com/<shopCode>/<partNum>.html；无 URL 时用默认店铺码（实测可正常跳转）
  const pageUrl = url && /^https?:\/\//.test(url) ? url : `https://product.suning.com/0000000000/${encodeURIComponent(itemId)}.html`;
  const html = await sget(pageUrl, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');

  // 1) var sn = sn || {...}
  let sn = null;
  const snRaw = extractBalanced(html, 'var sn = sn || ');
  if (snRaw) {
    try {
      sn = JSON.parse(snRaw);
    } catch {
      sn = null;
    }
  }
  if (!sn) {
    // 宽松兜底：逐字段正则提取
    sn = {
      itemDisplayName: (html.match(/"itemDisplayName":"([^"]{5,200})"/) || [])[1] || '',
      partNumber: (html.match(/"partNumber":"(\d+)"/) || [])[1] || String(itemId),
      categoryName3: (html.match(/"categoryName3":"([^"]{1,30})"/) || [])[1] || '',
      categoryName2: (html.match(/"categoryName2":"([^"]{1,30})"/) || [])[1] || '',
      categoryName1: (html.match(/"categoryName1":"([^"]{1,30})"/) || [])[1] || '',
      vendorCode: (html.match(/"vendorCode":"(\d+)"/) || [])[1] || '',
    };
  }

  // 2) 店铺名（var product = { shopName:"..." } 块）
  const shopName = (html.match(/shopName:"([^"]{2,60})"/) || [])[1] || '';

  // 3) 品牌名：规格参数表「品牌」行的值；兜底从标题【品牌(...)...】段提取
  let brand = '';
  const brandRow = html.match(/<span>\s*品牌[^<]*<\/span>\s*<\/div>\s*<\/td>\s*<td class="val">([^<]{1,40})<\/td>/);
  if (brandRow) brand = brandRow[1].trim();
  if (!brand) {
    const t = (html.match(/<title>([^<]{4,120})<\/title>/) || [])[1] || '';
    const m = t.match(/【([^【】]{2,40}?)(?:\(|（)/);
    if (m) brand = m[1];
  }

  // 4) 规格显示名（苏宁 dl 命名反直觉，需锚定 dl id）：
  //    #versionItemList（dt=颜色）：li versionid="20004" title="晶格绿" → 颜色名映射
  //    #colorItemList（dt=版本）：  li colorid="10009"  title="12GB+512GB" → 版本名映射
  const colorNameMap = {};
  const versionNameMap = {};
  const dlSeg = (id) => {
    const i = html.indexOf(`id="${id}"`);
    if (i < 0) return '';
    const end = html.indexOf('</dl>', i);
    return end > i ? html.slice(i, end) : html.slice(i, i + 6000);
  };
  for (const m of dlSeg('versionItemList').matchAll(/<li[^>]*versionid="(\d+)"[^>]*title="([^"]{1,30})"/g)) {
    colorNameMap[m[1]] = m[2];
  }
  for (const m of dlSeg('colorItemList').matchAll(/<li[^>]*colorid="(\d+)"[^>]*title="([^"]{1,30})"/g)) {
    versionNameMap[m[1]] = m[2];
  }

  // 价格：详情 SSR 同样不含价格，用 ds 批量接口补（单商品一次调用）
  const pn = String(sn.partNumber || itemId);
  const ds = (await fetchSuningDsPrices([pn], log)).get(pn);

  const spu = {
    spuId: String(sn.partNumber || itemId),
    prodSpuId: String(sn.ninePartNumber || ''),
    title: String(sn.itemDisplayName || ''),
    brandName: brand,
    shopName: shopName || ds?.vendorName || '',
    categoryName: String(sn.categoryName3 || ''),
    categoryName1: String(sn.categoryName1 || ''),
    categoryName2: String(sn.categoryName2 || ''),
    categoryCode: String(sn.categoryId || ''),
    vendorCode: String(sn.vendorCode || ''),
    price: ds?.price || 0,
    image: (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || '',
  };

  // 5) SKU：clusterMap 展开（颜色 × 版本 → partNumber）。clusterMap 是数组，取 [ 配平
  const skus = [];
  const cmStart = html.indexOf('"clusterMap"');
  if (cmStart >= 0) {
    const aIdx = html.indexOf('[', cmStart);
    const oIdx = html.indexOf('{', cmStart);
    let cmText = null;
    if (aIdx >= 0 && (oIdx < 0 || aIdx < oIdx)) cmText = extractBalancedBracket(html, '[', aIdx);
    if (cmText) {
      try {
        const arr = JSON.parse(cmText);
        for (const entry of arr || []) {
          // 字段名交叉错乱（苏宁原始数据如此）：entry.color 是「版本」ID（#colorItemList 值域），
          // itemCuPartNumber[].versionId 才是「颜色」ID（#versionItemList 值域）
          const versionName = versionNameMap[String(entry.color)] || `版本${entry.color}`;
          for (const v of entry.itemCuPartNumber || []) {
            const colorName = colorNameMap[String(v.versionId)] || `颜色${v.versionId}`;
            skus.push({
              skuId: String(v.partNumber || ''),
              name: `${colorName} ${versionName}`.trim(),
              options: { 颜色: colorName, 版本: versionName },
              itemType: String(v.itemType || ''),
            });
          }
        }
        log(`clusterMap 变体解析：${skus.length} 个 SKU（颜色/版本组合）`);
      } catch {
        log('clusterMap 解析失败，仅输出 SPU');
      }
    }
  }
  return { spu: spu.title ? spu : null, skus };
}

/** 平衡方括号提取（数组场景）。 */
function extractBalancedBracket(html, openCh, startIdx) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = startIdx; j < html.length; j++) {
    const c = html[j];
    if (esc) {
      esc = false;
      continue;
    }
    if (c === '\\') {
      esc = true;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (inStr) continue;
    if (c === openCh) depth++;
    else if (c === (openCh === '[' ? ']' : '}')) {
      depth--;
      if (!depth) return html.slice(startIdx, j + 1);
    }
  }
  return null;
}
