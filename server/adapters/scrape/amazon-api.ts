// 亚马逊直连通道：搜索页 SSR HTML 解析 + 详情页 twister 数据提 SPU/SKU。
// 亚马逊搜索/详情页均为服务端渲染（1.4MB+ 完整 HTML，无验证码时字段齐全），
// 无需浏览器渲染；亚马逊是海外站，请求必须走代理（VPN）。
import { fetch as undiciFetch } from 'undici';
import { pickProxy, getProxyDispatcher } from '../../proxy-pool.ts';
import { mapApiProducts } from './api-parse.ts';
import { isStopped } from '../../stop-flag.ts';
import { netThrottle } from './config.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://www.amazon.com/s?k=';

async function aget(url, tries = 3, log = (_m?: string) => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (isStopped()) throw new Error('已手动停止采集');
      await netThrottle(log); // 全局节流：跨通道共用计时
      const proxy = pickProxy();
      const dispatcher = proxy ? await getProxyDispatcher(proxy) : undefined;
      log(`亚马逊请求（第${i}/${tries}次）代理=${proxy || '直连'}`);
      const res = await undiciFetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.timeout(45000),
        dispatcher,
      });
      const html = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (/captcha|api-services-support@amazon/i.test(html.slice(0, 4000))) throw new Error('亚马逊验证码拦截（换代理/降频重试）');
      return html;
    } catch (e) {
      lastErr = String(e.cause?.code || e.message).slice(0, 90);
      log(`  请求失败: ${lastErr}`);
      // 重试间隔由下一次循环开头的 netThrottle 按设置档位保证
    }
  }
  throw new Error(`亚马逊请求失败: ${lastErr}`);
}

/** 从 HTML 中按 key 提取平衡花括号的 JS 对象字面量并 JSON.parse（处理字符串内的引号转义）。 */
function extractJsObj(html, key) {
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
      if (!depth) {
        try {
          return JSON.parse(html.slice(s, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 亚马逊搜索页直连：SSR HTML 里每个商品是 div[data-asin] 块，
 * 含 h2 标题 / a-offscreen 价格 / a-icon-alt 评分 / s-image 图片。
 */
export async function fetchAmazonProducts(opts: { query?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { query, limit = 20, log = (_m?: string) => {} } = opts;
  const html = await aget(`${SEARCH_URL}${encodeURIComponent(query)}`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');
  const chunks = html.split(/<div data-asin="/).slice(1);
  // 同一 asin 可能出现多层 div（外层壳 + 内层内容）：标题解析成功者优先
  const byAsin = new Map();
  for (const chunk of chunks) {
    const asin = (chunk.match(/^([A-Z0-9]{10})/) || [])[1];
    if (!asin) continue;
    // 标题三级兜底：h2 aria-label → h2>span → s-image alt（图片 alt 即商品标题）
    const title =
      (chunk.match(/<h2 aria-label="([^"]{5,300})"/) || [])[1] ||
      (chunk.match(/<h2[^>]*>\s*<span[^>]*>([^<]{5,300})</) || [])[1] ||
      (chunk.match(/class="s-image"[^>]*alt="([^"]{5,300})"/) || chunk.match(/alt="([^"]{5,300})"[^>]*class="s-image"/) || [])[1] ||
      '';
    if (!title) continue;
    if (byAsin.has(asin) && byAsin.get(asin).title) continue;
    const priceStr = (chunk.match(/<span class="a-offscreen">([^<]+)</) || [])[1] || '';
    const price = parseFloat(String(priceStr).replace(/[^0-9.]/g, '')) || 0;
    const rating = (chunk.match(/<span class="a-icon-alt">([\d.]+) out of 5/) || [])[1] || '';
    const ratingCount = (chunk.match(/([\d,]+)\s*ratings/) || [])[1] || '';
    const image = (chunk.match(/class="s-image"[^>]*src="([^"]+)"/) || [])[1] || '';
    byAsin.set(asin, {
      itemId: asin,
      title: String(title).trim(),
      brand: '',
      shop: '',
      category: '',
      price,
      marketPrice: 0,
      discount: '',
      sales: 0,
      url: `https://www.amazon.com/dp/${asin}`,
      image: image.replace(/\._[^.]+_\./, '.'), // 去掉缩略图后缀，取原图
      extra: {
        ...(rating ? { rating } : {}),
        ...(ratingCount ? { ratingCount: Number(ratingCount.replace(/,/g, '')) } : {}),
      },
    });
    if (byAsin.size >= Math.min(limit, 48)) break;
  }
  const raw = [...byAsin.values()].slice(0, limit);
  log(`搜索页解析出 ${raw.length} 个商品（SSR 直取，无需浏览器）`);
  const cfg = { name: '亚马逊', currency: 'USD' };
  return mapApiProducts(raw, cfg, 'amazon');
}

/**
 * 亚马逊详情页直连：SPU（标题/品牌/价格/图）+ twister 变体数据。
 * dimensionValuesDisplayData: { ASIN: [规格值...] }；variationDisplayLabels: { 维度key: 显示名 }
 */
export async function fetchAmazonDetailSpuSku(opts: { itemId?: string; log?: (m?: string) => void } = {}) {
  const { itemId, log = (_m?: string) => {} } = opts;
  const html = await aget(`https://www.amazon.com/dp/${encodeURIComponent(itemId)}`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');
  const title = (html.match(/<span id="productTitle"[^>]*>\s*([^<]{5,300}?)\s*</) || [])[1] || '';
  const brandRaw = (html.match(/<a[^>]*id="bylineInfo"[^>]*>([^<]{1,80})</) || [])[1] || '';
  const brand = brandRaw.replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '').trim();
  const price = parseFloat((html.match(/"priceAmount":([\d.]+)/) || html.match(/<span class="a-offscreen">([^<]+)</) || [])[1]?.replace(/[^0-9.]/g, '') || '0') || 0;
  const image = (html.match(/<meta property="og:image" content="([^"]+)"/) || html.match(/id="landingImage"[^>]*src="([^"]+)"/) || [])[1] || '';

  const spu = {
    spuId: String(itemId),
    title: String(title),
    brand,
    category: '',
    price,
    image: String(image),
  };

  // twister 变体：dimensionValuesDisplayData { ASIN: [值...] }
  const disp = extractJsObj(html, 'dimensionValuesDisplayData');
  const labels = extractJsObj(html, 'variationDisplayLabels');
  const skus = [];
  if (disp && typeof disp === 'object') {
    const dimNames: string[] = labels && typeof labels === 'object' ? (Object.values(labels) as string[]) : [];
    for (const [asin, values] of Object.entries(disp)) {
      if (!Array.isArray(values) || !values.length) continue;
      const opts: Record<string, string> = {};
      values.forEach((v, i) => {
        opts[dimNames[i] || `维度${i + 1}`] = String(v);
      });
      skus.push({
        skuId: String(asin),
        name: values.join(' / '),
        options: opts,
        price: String(asin) === String(itemId) ? price : 0, // twister 只带当前 SKU 的价格
      });
      if (skus.length >= 60) break;
    }
    log(`twister 变体解析：${skus.length} 个 SKU（维度：${dimNames.join('/') || '未知'}）`);
  } else {
    log('详情页无 twister 变体数据（单规格商品）');
  }
  return { spu: title ? spu : null, skus };
}
