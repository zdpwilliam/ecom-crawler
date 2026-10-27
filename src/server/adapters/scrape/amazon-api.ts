// 亚马逊直连通道：搜索页 SSR HTML 解析 + 详情页 twister 数据提 SPU/SKU + 评论列表页提取。
// 亚马逊搜索/详情页均为服务端渲染（1.4MB+ 完整 HTML，无验证码时字段齐全），
// 无需浏览器渲染；亚马逊是海外站，请求必须走代理（VPN）。
// 实测（2026-10-27）：无 Cookie 的裸请求被亚马逊激进重置（ECONNRESET/机器人页），
// 带 data/cookies/amazon.json 登录 Cookie（含 session-id）后成功率显著提高。
import fs from 'node:fs';
import path from 'node:path';
import { pickProxy } from '../../proxy-pool.ts';
import { impersonatedFetch } from '../../http-client.ts';
import { mapApiProducts } from './api-parse.ts';
import { isStopped } from '../../stop-flag.ts';
import { netThrottle } from './config.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SEARCH_URL = 'https://www.amazon.com/s?k=';

// 登录 Cookie 头（缓存 5 分钟：文件只在用户重新提取登录态时变更）
let _cookieCache: { at: number; header: string } | null = null;
function amazonCookieHeader(): string {
  if (_cookieCache && Date.now() - _cookieCache.at < 5 * 60_000) return _cookieCache.header;
  let header = '';
  try {
    const fp = path.join(process.cwd(), 'data', 'cookies', 'amazon.json');
    if (fs.existsSync(fp)) {
      const arr = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (Array.isArray(arr)) header = arr.map((c) => `${c.name}=${c.value}`).join('; ');
    }
  } catch {
    /* 读取失败按无 Cookie 处理 */
  }
  _cookieCache = { at: Date.now(), header };
  return header;
}

async function aget(url, tries = 3, log = (_m?: string) => {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      if (isStopped()) throw new Error('已手动停止采集');
      await netThrottle(log); // 全局节流：跨通道共用计时
      const proxy = pickProxy();
      const cookie = amazonCookieHeader();
      log(`亚马逊请求（第${i}/${tries}次）代理=${proxy || '直连'}（TLS 伪装${cookie ? ' + 登录Cookie' : ''}）`);
      const res = await impersonatedFetch({
        url,
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9',
          Accept: 'text/html,application/xhtml+xml',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: 45000,
        proxy,
      });
      const html = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      // 机器人页/验证码页同样是 200 但只有几 KB：按内容特征识别后走重试
      if (/captcha|api-services-support@amazon|automated access|Enter the characters you see|sorry, we just need to make sure/i.test(html.slice(0, 6000)) || (html.length < 20_000 && /<title[^>]*>\s*Amazon\.com\s*<\/title>/i.test(html))) {
        throw new Error('亚马逊验证码/机器人页拦截（换代理/降频重试）');
      }
      return html;
    } catch (e) {
      lastErr = String(e.cause?.code || e.message).slice(0, 90);
      log(`  请求失败: ${lastErr}`);
      // 退避后再试：连续立刻重试会被同一批连接路径继续重置
      if (i < tries) await new Promise((r) => setTimeout(r, 1000 * i));
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
 * 亚马逊详情页 SSR HTML 解析（纯函数，供直连与浏览器通道共用）：
 * SPU（标题/品牌/价格/图）+ twister 变体数据。
 * dimensionValuesDisplayData: { ASIN: [规格值...] }；variationDisplayLabels: { 维度key: 显示名 }
 */
export function parseAmazonDetailHtml(html: string, itemId: string, log = (_m?: string) => {}) {
  const title = (html.match(/<span id="productTitle"[^>]*>\s*([^<]{5,300}?)\s*</) || [])[1] || '';
  const brandRaw = (html.match(/<a[^>]*id="bylineInfo"[^>]*>([^<]{1,80})</) || [])[1] || (html.match(/"brand"\s*:\s*"([^"]{1,60})"/) || [])[1] || '';
  const brand = brandRaw.replace(/^(Visit the|Brand:)\s*/i, '').replace(/\s*Store$/i, '').trim();
  const price =
    parseFloat((html.match(/"priceAmount":([\d.]+)/) || html.match(/"price"\s*:\s*"?([\d.]+)"?/) || html.match(/<span class="a-offscreen">([^<]+)</) || [])[1]?.replace(/[^0-9.]/g, '') || '0') || 0;
  const image = (html.match(/<meta property="og:image" content="([^"]+)"/) || html.match(/id="landingImage"[^>]*src="([^"]+)"/) || html.match(/"hiRes":"([^"]+)"/) || [])[1] || '';

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

/**
 * 亚马逊详情页直连：SSR HTML 跑 parseAmazonDetailHtml。
 */
export async function fetchAmazonDetailSpuSku(opts: { itemId?: string; log?: (m?: string) => void } = {}) {
  const { itemId, log = (_m?: string) => {} } = opts;
  const html = await aget(`https://www.amazon.com/dp/${encodeURIComponent(itemId)}`, 3, log);
  if (isStopped()) throw new Error('已手动停止采集');
  return parseAmazonDetailHtml(html, itemId, log);
}

/**
 * 亚马逊评论列表页直连 + DOM 提取器（两段式）：
 * 详情页 SSR 不渲染评论（登录后也只有 Top reviews 摘要甚至为空），评论必须走
 * /product-reviews/<ASIN> 列表页。两段式是为了配合通用 collectDetail：
 * reviewsPage 构造 URL（浏览器导航），extractReviewsDom 在已导航的页面里提取。
 */
export function amazonReviewsPageUrl(itemId: string) {
  return `https://www.amazon.com/product-reviews/${encodeURIComponent(itemId)}?pageNumber=1`;
}

export async function extractAmazonReviewsDom(page: any, limit = 30) {
  return page.evaluate((max: number) => {
    const out: any[] = [];
    for (const card of document.querySelectorAll('[data-hook="review"]')) {
      const q = (sel: string) => (card.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
      const bodyEl = card.querySelector('[data-hook="review-body"]');
      const content = ((bodyEl as HTMLElement)?.innerText || bodyEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!content || content.length < 4) continue;
      const rm = q('.a-icon-alt').match(/([\d.]+) out of 5/);
      out.push({
        rating: rm ? Math.min(5, Math.max(1, Math.round(parseFloat(rm[1])))) : 5,
        content: content.slice(0, 800),
        author: q('.a-profile-name') || '',
        date: q('[data-hook="review-date"]').slice(0, 60),
      });
      if (out.length >= max) break;
    }
    return out;
  }, limit);
}

/** 评论列表页直连（SSR）：与浏览器导航二选一的直连形态。 */
export async function fetchAmazonReviews(opts: { itemId?: string; limit?: number; log?: (m?: string) => void } = {}) {
  const { itemId, limit = 30, log = (_m?: string) => {} } = opts;
  const html = await aget(amazonReviewsPageUrl(String(itemId)), 2, log);
  if (isStopped()) throw new Error('已手动停止采集');
  // 复用轻量块解析：data-hook="review" 卡片内抽 rating/body/author/date
  const out: any[] = [];
  for (const chunk of html.split(/<div[^>]+data-hook="review"/).slice(1)) {
    const rm = (chunk.match(/class="a-icon-alt">([\d.]+) out of 5/) || [])[1] || '';
    const bodyM = chunk.match(/data-hook="review-body"[\s\S]{0,200}?>([\s\S]*?)<\/div>/);
    const content = bodyM ? bodyM[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    if (!content || content.length < 4) continue;
    const author = (chunk.match(/class="a-profile-name">([^<]{1,60})</) || [])[1] || '';
    const date = (chunk.match(/data-hook="review-date">([^<]{1,60})</) || [])[1] || '';
    out.push({ rating: rm ? Math.min(5, Math.max(1, Math.round(parseFloat(rm)))) : 5, content: content.slice(0, 800), author, date });
    if (out.length >= limit) break;
  }
  log(`评论列表页解析：${out.length} 条评论`);
  return out;
}
