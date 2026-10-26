// 京东直连通道（详情页 SSR）。
// 详情：GET https://item.m.jd.com/product/<sku>.html —— 移动端详情页服务端渲染，
//       内嵌 window._itemOnly = ({...})（skuName/brandName/category/newColorSize SKU 变体）
//       与 window._itemInfo = ({...})（priceFloor.ext.realPriceExt.ORIGINAL.jdprice_amount 真实价格、
//       shopFloor 店铺、saleQuantityFloor 等）。两个全局都是「括号包裹的 JS 对象字面量」，
//       可能含尾逗号 → 平衡括号截取 + 去尾逗号后 JSON.parse。
// 搜索：api.m.jd.com 需要签名且 functionId 随版本变化，匿名直连不可行 —— 搜索仍走
//       浏览器渲染路径（generic.js 的响应捕获已加入 api.m.jd.com，登录态下可拿到结构化数据）。
import { fetch as undiciFetch } from 'undici';
import { isStopped } from '../../stop-flag.js';
import { netThrottle } from './config.js';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** 带 UA 直取 HTML（简单重试）。 */
async function jget(url, tries = 3, log = () => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (isStopped()) throw new Error('已手动停止采集');
      await netThrottle(log); // 全局节流：跨通道共用计时
      const res = await undiciFetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: 'https://item.m.jd.com/' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = String(e.cause?.code || e.message).slice(0, 80);
      log(`  京东请求失败(第${i}/${tries}次): ${lastErr}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw new Error(`京东请求失败: ${lastErr}`);
}

/**
 * 平衡括号提取 JS 对象字面量：从 `window.xxx = (` 后第一个 `(` 开始，
 * 字符串感知地配对到闭合 `)`，返回内部对象文本。
 */
function extractJsObj(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const open = html.indexOf('(', i);
  if (open < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = open; j < html.length; j++) {
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
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (!depth) return html.slice(open + 1, j);
    }
  }
  return null;
}

/** 去除 JS 对象字面量里的尾逗号（string-aware），随后可 JSON.parse。 */
function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      esc = false;
      out += c;
      continue;
    }
    if (c === '\\') {
      esc = true;
      out += c;
      continue;
    }
    if (c === '"') inStr = !inStr;
    if (!inStr && c === ',') {
      const nxt = s.slice(i + 1, i + 8).trimStart();
      if (nxt && (nxt[0] === '}' || nxt[0] === ']')) continue;
    }
    out += c;
  }
  return out;
}

function parseJsGlobal(html, marker) {
  const raw = extractJsObj(html, marker);
  if (!raw) return null;
  try {
    return JSON.parse(stripTrailingCommas(raw));
  } catch {
    return null;
  }
}

/**
 * 京东详情页直连：item.m.jd.com SSR 解析 SPU/SKU/价格/店铺。
 * SPU：_itemOnly.item（skuName/brandName/category）+ _itemInfo.priceFloor.ext.realPriceExt 真实价格。
 * SKU：item.newColorSize[]（skuId/color/size/imagePath）。
 * 注意：PC 端 item.jd.com 是 JS 壳（36KB 无数据），必须用移动端 item.m.jd.com。
 */
export async function fetchJdDetailSpuSku({ itemId, url, log = () => {} } = {}) {
  const sku = String(itemId || (url && url.match(/(\d{10,})\.html/)?.[1]) || '');
  if (!sku) throw new Error('京东详情缺 skuId');
  const html = await jget(`https://item.m.jd.com/product/${sku}.html`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');

  const itemOnly = parseJsGlobal(html, 'window._itemOnly');
  const itemInfo = parseJsGlobal(html, 'window._itemInfo');
  const item = itemOnly?.item;
  if (!item || !item.skuName) {
    log('京东详情未解析到 _itemOnly.item（页面结构变化或被风控），仅回退浏览器路径');
    return { spu: null, skus: [] };
  }

  // 价格：realPriceExt.ORIGINAL.jdprice_amount 是未混淆的真实值；SSR 展示价 jdPrice 带掩码（"1??9"）不可用
  let price = 0;
  const rp = itemInfo?.priceFloor?.ext?.realPriceExt;
  if (rp) {
    price = Number(rp.ORIGINAL?.jdprice_amount ?? rp.JD?.jdprice_amount ?? 0) || 0;
  }
  const category = Array.isArray(item.category) ? item.category.filter(Boolean).join('/') : String(item.category || '');

  const spu = {
    spuId: String(item.skuId || sku),
    title: String(item.skuName || ''),
    brandName: String(item.brandName || ''),
    shopName: '',
    categoryName: category,
    price,
    venderId: String(itemInfo?.ruId || item.venderID || ''),
    shopTypeDesc: String(itemInfo?.shopFloor?.shopFloorConfig?.shopTypeDesc || ''),
    image: Array.isArray(item.image) && item.image.length ? `https://img14.360buyimg.com/n1/${item.image[0]}` : '',
  };
  // 店铺名兜底：_itemInfo.shopFloor 里的 shopName/vender 字段（结构随店铺类型变化，宽松取）
  const sfText = JSON.stringify(itemInfo?.shopFloor || {});
  const shopName = sfText.match(/"(?:shopName|venderName|shopNameStr|shopNameText)"\s*:\s*"([^"]{2,40})"/)?.[1] || '';
  if (shopName) spu.shopName = shopName;

  // SKU：newColorSize（color=第一规格，size=第二规格；数值键 "1"/"2" 与 salePropSeq 序号对应）
  const seqNames = item.salePropSeq || {};
  const skus = (item.newColorSize || [])
    .filter((v) => v && (v.skuId || v.color || v.size))
    .map((v) => {
      const color = String(v.color || v['1'] || '');
      const size = String(v.size || v['2'] || '');
      const options = {};
      if (color) options['规格1'] = color;
      if (size) options['规格2'] = size;
      return {
        skuId: String(v.skuId || ''),
        spuId: spu.spuId,
        name: [color, size].filter(Boolean).join(' ') || String(v.skuId || ''),
        options,
        price,
        image: v.imagePath ? `https://img14.360buyimg.com/n1/${v.imagePath}` : '',
      };
    });
  log(`京东详情解析：SPU ✓（价格 ${price || '未取到'}），SKU ${skus.length} 个（newColorSize）`);
  return { spu, skus };
}
