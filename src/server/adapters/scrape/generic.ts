// 真实可跑的通用爬取适配器（v3）
// 引擎：Playwright(默认, 支持代理池轮换/UA/视口) → 原生 fetch(服务器渲染页, 支持代理) → 本地 fixture(离线验证)
// 网络防护：UA 轮换 + 请求间随机延迟 + 失败指数退避重试 + 代理池自动轮换 + Cookie 注入
// 业务：列表页商品抽取 → 详情页评论 + 公开问答(问大家/聊天记录) 一并采回
// 解析策略：浏览器内通用启发式 → CSS 类选择器 → JSON-LD → --verify 校准诊断
import { BaseAdapter } from '../base.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_TYPES } from '../../types.ts';
import { SCRAPE_CONFIG, demo, pickUA, randomDelayMs, sleep, NETWORK, netThrottle } from './config.ts';
import { fetchErrText } from '../../proxy-pool.ts';
import { randomFingerprint, fingerprintEnabled } from '../../fingerprint.ts';
import { acquireSession, reportSessionOk, markBadSession, classifyBan, applyBanToSession } from '../../session-pool.ts';
import { impersonatedFetch } from '../../http-client.ts';
import { fingerprintInitScript } from '../../fp-inject.ts';
import { runLog } from '../../runlog.ts';
import { isStopped } from '../../stop-flag.ts';
import { apiProductsFromBodies, mapApiProducts, spuSkuFromBodies } from './api-parse.ts';
import { recordSnapshot, locateBySnapshot, updateSnapshot } from './adaptive.ts';
// HTTP 请求统一走 http-client.ts（impit TLS 伪装 + undici 兜底），此处不再直接引 undici
import { DATA_DIR } from '../../paths.ts';



// ---------- 轻量 HTML 解析（无第三方依赖） ----------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
function decode(s) {
  return String(s).replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] || m);
}
function stripTags(s) {
  return decode(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractBlocks(html, openRe) {
  const blocks = [];
  let i = 0;
  while (i < html.length) {
    const slice = html.slice(i);
    const m = openRe.exec(slice);
    if (!m) break;
    const start = i + m.index;
    const gt = html.indexOf('>', start);
    if (gt === -1) break;
    let depth = 1;
    let j = gt + 1;
    while (j < html.length && depth > 0) {
      if (html.startsWith('</', j)) {
        depth--;
        j = html.indexOf('>', j) + 1;
      } else if (html[j] === '<' && html[j + 1] !== '/') {
        const ngt = html.indexOf('>', j);
        if (ngt === -1) break;
        const tag = html.slice(j, ngt);
        if (!tag.endsWith('/>')) depth++;
        j = ngt + 1;
      } else {
        j++;
      }
    }
    blocks.push(html.slice(gt + 1, j));
    i = j;
    if (i === start) i++;
    openRe.lastIndex = 0;
  }
  return blocks;
}

function pickField(block, field) {
  if (!field) return '';
  if (field.attr) {
    const re = new RegExp(`<${field.tag}[^>]*\\b${field.attr}=["']([^"']*)["']`, 'i');
    const m = block.match(re);
    return m ? decode(m[1]) : '';
  }
  const re = new RegExp(
    `<${field.tag}[^>]*class=["'][^"']*${field.cls}[^"']*["'][^>]*>([\\s\\S]*?)</${field.tag}>`,
    'i'
  );
  const m = block.match(re);
  return m ? stripTags(m[1]) : '';
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const data = JSON.parse(m[1].trim());
      const nodes = Array.isArray(data) ? data : data['@graph'] || [data];
      for (const n of nodes) {
        if (n && (n['@type'] === 'Product' || n['@type'] === 'Review' || n['@type'] === 'AggregateRating')) {
          out.push(n);
        }
      }
    } catch {
      /* 忽略坏 JSON */
    }
  }
  return out;
}

// ---------- 详情页扩展信息（纯 HTML 路径）：JSON-LD Product → meta/og 正则解析 ----------
// 浏览器路径（collectDetail 内 page.evaluate）是本逻辑的超集：多出 DOM 图片集/规格参数表/描述兜底。
// fixture 离线验证与纯 SSR 站点走本函数。
function extractDetailInfoFromHtml(html) {
  const out = { description: '', images: [], props: null };
  const abs = (u) => {
    if (!u || typeof u !== 'string') return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^\/\//.test(u)) return 'https:' + u;
    return '';
  };
  try {
    for (const n of extractJsonLd(html)) {
      if (!out.description && typeof n.description === 'string' && n.description.length > 20) {
        out.description = decode(n.description.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 4000);
      }
      const im = Array.isArray(n.image) ? n.image : n.image ? [n.image] : [];
      for (const x of im) {
        const u = abs(typeof x === 'string' ? x : x && x.url);
        if (u && !out.images.includes(u)) out.images.push(u);
      }
      const ap = Array.isArray(n.additionalProperty) ? n.additionalProperty : [];
      if (ap.length && !out.props) {
        const props = {};
        for (const a of ap) if (a && a.name && a.value != null) props[String(a.name).slice(0, 40)] = String(a.value).slice(0, 120);
        if (Object.keys(props).length >= 3) out.props = props;
      }
    }
  } catch {
    /* JSON-LD 解析失败走 meta 兜底 */
  }
  if (!out.description) {
    const m =
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']{20,3000})["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{20,3000})["']/i);
    if (m) out.description = decode(m[1]).replace(/\s+/g, ' ').trim().slice(0, 4000);
  }
  if (!out.images.length) {
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
    const u = abs(m && m[1]);
    if (u) out.images.push(u);
  }
  return out;
}

function parseProductsJsonLd(ld, cfg) {
  return ld.map((n, i) => {
    const offers = Array.isArray(n.offers) ? n.offers[0] : n.offers;
    const price = offers ? parseFloat(String(offers.price).replace(/[^\d.]/g, '')) || 0 : 0;
    const brand = typeof n.brand === 'string' ? n.brand : n.brand?.name || '';
    return {
      id: `scrape-${cfg.name}-ld-${i}`,
      platform: cfg.name,
      itemId: String(n.sku || n.gtin13 || n.mpn || i),
      shopName: brand,
      title: n.name || '',
      price,
      currency: offers?.priceCurrency || 'CNY',
      category: (n.category || '').toString(),
      brand,
      sales: 0,
      stock: Number(offers?.availability?.includes('InStock') ? 1 : 0),
      url: n.url || '',
      images: Array.isArray(n.image) ? n.image : n.image ? [n.image] : [],
      specs: {},
      collectedAt: new Date().toISOString(),
    };
  });
}

function parseProducts(html, cfg) {
  const blocks = extractBlocks(html, cfg.product.cardOpen);
  const fromSelector = blocks
    .map((b, i) => {
      const title = pickField(b, cfg.product.fields.title);
      if (!title) return null;
      const priceRaw = pickField(b, cfg.product.fields.price);
      const price = parseFloat(priceRaw.replace(/[^\d.]/g, '')) || 0;
      const shop = pickField(b, cfg.product.fields.shop);
      const url = pickField(b, cfg.product.fields.url);
      // urlAccept 护栏：url 不是商品详情页的丢弃（防止导航/筛选/广告链接混进商品表）
      if (cfg.product.urlAccept && !cfg.product.urlAccept.test(url)) return null;
      // itemIdPattern 平台专有提取优先（如苏宁 product/<shopCode>/<partNum>.html 必须取末段，防店铺码误当商品号），
      // 未配置时退回「首个 6+ 位数字」
      const itemId =
        (cfg.product.itemIdPattern ? (url.match(cfg.product.itemIdPattern) || [])[1] : '') ||
        (url.match(/(\d{6,})/) || [])[1] ||
        `item_${i}`;
      return {
        id: `scrape-${cfg.name}-${itemId}-${i}`,
        platform: cfg.name,
        itemId,
        shopName: shop,
        title,
        price,
        currency: 'CNY',
        category: '',
        brand: '',
        sales: 0,
        stock: 0,
        url,
        images: [],
        specs: {},
        collectedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
  if (fromSelector.length) {
    // 成功采集：记录结构快照（P1-5 自适应解析——站点改版后可按快照重定位）
    recordSnapshot(cfg.name, 'product', html, cfg.product.cardOpen);
    return fromSelector;
  }
  const ld = extractJsonLd(html).filter((n) => n['@type'] === 'Product');
  if (ld.length) return parseProductsJsonLd(ld, cfg);
  // 自适应重定位（P1-5）：配置选择器与 JSON-LD 都失配 → 按快照相似度找新卡片结构。
  // noProductHint 平台（得物等已知无可用网页商城）跳过——这类站点页面上的重复容器
  // 是轮播/推荐位而非商品卡，重定位只会产出垃圾数据（round38 实测教训）。
  if (!cfg.noProductHint) {
    const relocated = adaptiveParseProducts(html, cfg);
    if (relocated.length) return relocated;
  }
  return parseProductsJsonLd(ld, cfg);
}

/** 自适应重定位解析（P1-5）：宽松字段抽取（标题=块内最长文本，链接走 urlAccept 护栏）。 */
function adaptiveParseProducts(html, cfg) {
  const located = locateBySnapshot(cfg.name, 'product', html);
  if (!located) return [];
  runLog(
    `⚠ 自适应重定位生效：配置选择器失配，按结构快照定位到 <${located.tag} class="${located.cls.slice(0, 40)}"> ` +
      `× ${located.blocks.length} 块（结构相似度得分 ${located.similarity.toFixed(2)}）——请校对解析结果并更新 SCRAPE_CONFIG`
  );
  const out = [];
  for (const [i, b] of located.blocks.entries()) {
    // 宽松抽取：标题=块内最长可见文本；价格=首个价格样式数字；链接=第一个商品护栏内的 <a href>
    const texts = stripTags(b).split(' ').filter((w) => w.length > 4);
    const title = texts.sort((a, b2) => b2.length - a.length)[0] || '';
    // 内容护栏：标题长得像 JSON/代码 = 这是数据块不是商品卡（得物误定位教训），整簇作废
    if (!title || /^[{[<]/.test(title) || /function|=>|dataManager/.test(title)) return [];
    if (!title) continue;
    const hrefs = [...b.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)].map((mm) => decode(mm[1]));
    const url = cfg.product.urlAccept ? hrefs.find((u) => cfg.product.urlAccept.test(u)) || '' : hrefs[0] || '';
    if (!url) continue;
    const priceM = b.match(/[¥￥]\s*([\d,]+(?:\.\d+)?)|([\d,]{2,}(?:\.\d+)?)\s*元/);
    const price = priceM ? parseFloat((priceM[1] || priceM[2]).replace(/,/g, '')) || 0 : 0;
    const itemId =
      (cfg.product.itemIdPattern ? (url.match(cfg.product.itemIdPattern) || [])[1] : '') ||
      (url.match(/(\d{6,})/) || [])[1] ||
      `item_${i}`;
    out.push({
      id: `scrape-${cfg.name}-adp-${itemId}-${i}`,
      platform: cfg.name,
      itemId,
      shopName: '',
      title,
      price,
      currency: 'CNY',
      category: '',
      brand: '',
      sales: 0,
      stock: 0,
      url,
      images: [],
      specs: {},
      collectedAt: new Date().toISOString(),
      adaptive: true,
    });
  }
  if (out.length) updateSnapshot(cfg.name, 'product', located.tag, located.cls);
  return out;
}

function parseReviews(html, cfg) {
  const blocks = extractBlocks(html, cfg.review.cardOpen);
  const fromSelector = blocks
    .map((b, i) => {
      const content = pickField(b, cfg.review.fields.content);
      if (!content) return null;
      const ratingRaw = pickField(b, cfg.review.fields.rating);
      const rating = parseInt(ratingRaw.replace(/[^\d]/g, ''), 10) || 5;
      const author = pickField(b, cfg.review.fields.author) || `用户${i}`;
      return {
        id: `scrape-${cfg.name}-r-${i}`,
        platform: cfg.name,
        itemId: '',
        productTitle: '',
        rating: Math.min(5, Math.max(1, rating)),
        content,
        authorMasked: author.slice(0, 1) + '***',
        tags: rating >= 4 ? ['好评'] : [],
        createdAt: new Date().toISOString(),
        collectedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
  if (fromSelector.length) return fromSelector;
  const ld = extractJsonLd(html).filter((n) => n['@type'] === 'Review');
  return ld.map((n, i) => ({
    id: `scrape-${cfg.name}-rld-${i}`,
    platform: cfg.name,
    itemId: '',
    productTitle: n.itemReviewed?.name || '',
    rating: Math.min(5, Math.max(1, Number(n.reviewRating?.ratingValue) || 5)),
    content: n.reviewBody || '',
    authorMasked: (n.author?.name || `用户${i}`).slice(0, 1) + '***',
    tags: (n.reviewRating?.ratingValue || 5) >= 4 ? ['好评'] : [],
    createdAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  }));
}

function parseQa(html, cfg) {
  const key = cfg.qa ? 'qa' : null;
  if (!key) return [];
  const blocks = extractBlocks(html, cfg.qa.cardOpen);
  return blocks
    .map((b, i) => {
      const q = pickField(b, cfg.qa.fields.q);
      if (!q) return null;
      const a = pickField(b, cfg.qa.fields.a);
      const asker = pickField(b, cfg.qa.fields.asker) || `用户${i}`;
      return {
        id: `scrape-${cfg.name}-q-${i}`,
        platform: cfg.name,
        itemId: '',
        productTitle: '',
        question: q,
        answer: a,
        askerMasked: asker.slice(0, 1) + '***',
        answerMasked: '',
        createdAt: new Date().toISOString(),
        collectedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}

// ---------- 网络引擎（代理池轮换 + UA 轮换 + 延迟 + 重试 + Cookie） ----------

let _pw = undefined;
async function getPlaywright() {
  if (_pw !== undefined) return _pw;
  try {
    _pw = await import('playwright');
  } catch {
    _pw = null;
  }
  return _pw;
}

// Patchright（P1-4 可选升级）：Playwright 的反检测补丁版，API 完全兼容、零改动替换。
// 已安装即优先使用（去掉 Runtime.enable CDP 调用与 HeadlessChrome UA 痕迹）；未安装回退官方 Playwright。
let _patchright: any | undefined = undefined;
async function getPatchright() {
  if (_patchright !== undefined) return _patchright;
  try {
    _patchright = await import('patchright');
    runLog('渲染引擎：Patchright（反检测补丁版 Playwright）');
  } catch {
    _patchright = null;
  }
  return _patchright;
}

// dispatcher 统一由 proxy-pool.getProxyDispatcher 提供（http→ProxyAgent，socks4/5→fetch-socks）

// Cookie 解析：优先环境变量 CRAWL_COOKIES，其次自动读取 data/cookies/<platformId>.json
function parseCookies(raw, host) {
  if (!raw) return [];
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    arr = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const idx = pair.indexOf('=');
        return { name: pair.slice(0, idx), value: pair.slice(idx + 1) };
      });
  }
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || host,
    path: c.path || '/',
    ...(c.expires ? { expires: c.expires } : {}),
  }));
}

function resolveCookies(platformId) {
  if (process.env.CRAWL_COOKIES) return parseCookies(process.env.CRAWL_COOKIES, '');
  if (platformId) {
    const p = path.resolve(DATA_DIR, 'cookies', `${platformId}.json`);
    if (fs.existsSync(p)) {
      try {
        const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`[crawler] 自动载入登录态 Cookie：${p}（${arr.length} 条）`);
        return arr;
      } catch (e) {
        console.warn(`[crawler] 读取 ${p} 失败：`, e.message);
      }
    }
  }
  return [];
}

// 在浏览器内用通用启发式抽取商品：扫描「商品图 + 链接 + 价格」三要素。
function inBrowserExtract(page) {
  return page.evaluate(() => {
    const priceRe = /[¥￥$€£₩]\s?\d[\d,]*\.?\d*/;
    const res = [];
    const seen = new Set();
    const imgs = [...document.querySelectorAll('img')];
    for (const img of imgs) {
      const w = img.naturalWidth || img.width || 0;
      if (w && w < 16) continue;
      const src =
        img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazyload-src') || '';
      if (!src || src.startsWith('data:')) continue;
      let box = img.closest('article, li, section, [class*="product" i], [class*="item" i], [class*="card" i], [class*="goods" i]');
      if (!box) {
        box = img;
        for (let i = 0; i < 4 && box; i++) box = box.parentElement;
      }
      if (!box) continue;
      const anchor = img.closest('a[href]');
      const link = anchor ? anchor.href : '';
      if (!link || link.length < 12) continue;
      // 只保留同站链接：第三方域名（广告/联盟跳转）和首页链接都不是商品详情页。
      // 注意按「注册域」比较：category.vip.com 与 detail.vip.com 是兄弟子域，必须算同站。
      try {
        const u = new URL(link);
        if (!/^(https?:)$/.test(u.protocol)) continue;
        const reg = (h) => h.split('.').slice(-2).join('.');
        if (reg(u.hostname) !== reg(location.hostname)) continue;
        if (u.pathname.length < 2 || u.pathname === '/') continue;
        // 跳过指向当前页面自身的链接（换查询参数的回链，如品牌墙 brand_sn、筛选参数）——不是商品详情
        if (u.hostname === location.hostname && u.pathname === location.pathname) continue;
      } catch {
        continue;
      }
      const titleLink = [...box.querySelectorAll('a[href]')].find((a) => (a.innerText || '').trim().length > 3) || anchor;
      let title = (titleLink && titleLink.innerText ? titleLink.innerText : '').trim();
      if (!title || title.length < 3) title = (img.alt || '').trim();
      if (!title || title.length < 3) continue;
      const txt = (box.innerText || '').replace(/\s+/g, ' ').trim();
      let pm = txt.match(priceRe);
      if (!pm) {
        const priceEl = box.querySelector('[class*="price" i], [class*="J_price" i], [class*="promo" i]');
        if (priceEl) pm = (priceEl.innerText || priceEl.textContent || '').match(priceRe);
      }
      const key = (link.split('?')[0] || '') + '|' + title.slice(0, 24);
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ title: title.slice(0, 140), priceRaw: pm ? pm[0] : '', url: link, image: src });
    }
    return res.slice(0, 300);
  });
}

// 浏览器内启发式抽取评论（详情页）：扫「含 rating/评论 类名的块」取评分 + 正文
function inBrowserExtractReviews(page) {
  return page.evaluate(() => {
    const res = [];
    const seen = new Set();
    const boxes = [...document.querySelectorAll('[class*="review" i], [class*="comment" i], [class*="rate" i]')].filter(
      (el) => (el.innerText || '').trim().length > 4
    );
    for (const box of boxes) {
      const txt = (box.innerText || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(/(?:(\d(?:\.\d)?)\s*星)|(?:评分\s*(\d))/);
      const rating = m ? Math.min(5, Math.max(1, Math.round(parseFloat(m[1] || m[2])))) : 5;
      const key = txt.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ rating, content: txt.slice(0, 400) });
      if (res.length >= 100) break;
    }
    return res;
  });
}

// 浏览器内启发式抽取公开问答（问大家 / 买家问答）
function inBrowserExtractQa(page) {
  return page.evaluate(() => {
    const res = [];
    const seen = new Set();
    const containers = [...document.querySelectorAll('[class*="qa" i], [class*="ask" i], [class*="question" i], [class*="answer" i]')].filter(
      (el) => (el.innerText || '').trim().length > 4
    );
    for (const box of containers) {
      const txts = [...box.querySelectorAll('div,p,li,span')]
        .map((e) => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((t) => t.length > 2);
      const q = txts[0] || (box.innerText || '').replace(/\s+/g, ' ').trim();
      const a = txts[1] || '';
      if (!q) continue;
      const key = q.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      res.push({ question: q.slice(0, 200), answer: a.slice(0, 300) });
      if (res.length >= 100) break;
    }
    return res;
  });
}

// 浏览器内启发式抽取 SKU 规格组（详情页）：扫「sku/尺码/颜色/规格」类容器，
// 取每个容器的选项文本（一组 = 一个维度，如「尺码：S/M/L」）。接口结构化数据优先，此为兜底。
// 误命中过滤：排除运费/收藏/购物车等服务操作区；选项须为短文本标签（规格值一般 ≤12 字）。
function inBrowserExtractSku(page) {
  return page.evaluate(() => {
    const NOISE = /购物车|收藏|立即购买|开通|分期|运费|活动|优惠|售后|服务|评价|关注|客服|分享|领券|价格组成|降价|收起|更多/;
    const res = [];
    const seen = new Set();
    const boxes = [
      ...document.querySelectorAll(
        '[class*="sku" i], [class*="size" i], [class*="color" i], [class*="spec" i], [class*="dimension" i], [class*="sale-prop" i], [class*="property" i]'
      ),
    ].filter((el) => {
      const n = el.querySelectorAll('a,button,li,span,div').length;
      // 选项数量合理（2~80）且文本量不大：过滤掉把整页当容器的误命中
      return n >= 2 && n <= 80 && (el.innerText || '').trim().length < 500;
    });
    for (const box of boxes) {
      // 只取最内层：父容器也带 sku 类名会造成整组重复
      if (box.parentElement && /sku|size|color|spec|dimension|prop|property/i.test(box.parentElement.className || '')) continue;
      const opts = [...box.querySelectorAll('a,button,li,span,div')]
        .map((e) => (e.innerText || '').trim())
        .filter((t) => t && t.length <= 12 && !NOISE.test(t));
      const uniq = [...new Set(opts)];
      if (uniq.length < 2) continue;
      const key = uniq.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      const cls = String(box.className || '');
      const label = (box.querySelector('[class*="title" i], [class*="label" i], [class*="name" i]')?.innerText || '').trim().slice(0, 20);
      const name = /color|colour|颜/i.test(cls) ? '颜色' : /size|尺码/i.test(cls) ? '尺码' : label || '规格';
      // 规格组名带操作词的直接丢弃（服务区伪装成规格区）
      if (NOISE.test(name)) continue;
      res.push({ name, options: uniq.slice(0, 40) });
    }
    return res.slice(0, 6);
  });
}

function normalizeProducts(raw, cfg) {
  return raw
    .map((r, i) => {
      const price = parseFloat(String(r.priceRaw || '').replace(/[^\d.]/g, '')) || 0;
      const url = r.url || '';
      const itemId = (url.match(/(\d{6,})/) || [])[1] || `item_${i}`;
      return {
        id: `scrape-${cfg.name}-${itemId}-${i}`,
        platform: cfg.name,
        itemId,
        shopName: r.shop || '',
        title: r.title || '',
        price,
        currency: 'CNY',
        category: '',
        brand: '',
        sales: 0,
        stock: 0,
        url,
        images: r.image ? [r.image] : [],
        specs: {},
        collectedAt: new Date().toISOString(),
      };
    })
    .filter((p) => p.title && (p.url || p.price));
}

function normalizeReviews(raw, cfg, itemId = '', productTitle = '') {
  return raw.map((r, i) => ({
    id: `scrape-${cfg.name}-r-${i}-${Date.now()}`,
    platform: cfg.name,
    itemId,
    productTitle,
    rating: Math.min(5, Math.max(1, Number(r.rating) || 5)),
    content: r.content || '',
    authorMasked: `用***${i}`,
    tags: Number(r.rating) >= 4 ? ['好评'] : [],
    createdAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  }));
}

function normalizeQa(raw, cfg, itemId = '', productTitle = '') {
  return raw.map((r, i) => ({
    id: `scrape-${cfg.name}-q-${i}-${Date.now()}`,
    platform: cfg.name,
    itemId,
    productTitle,
    question: r.question || '',
    answer: r.answer || '',
    askerMasked: `用***${i}`,
    answerMasked: '',
    createdAt: new Date().toISOString(),
    collectedAt: new Date().toISOString(),
  }));
}

// 根据商品链接/ itemId 解析详情页 URL（补全协议相对路径、或用平台 detailUrl 构造）
function resolveDetailUrl(cfg, product) {
  let url = product.url || '';
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:\/\//.test(url)) {
    if (cfg.detailUrl) url = cfg.detailUrl(product.itemId);
    else return null;
  }
  if (!/^https?:\/\//.test(url)) return null;
  return url;
}

// 根据指纹生成额外的请求头（伪造出口 IP + 语言 + Client Hints），增加请求间的差异度。
// Client Hints 只在档案带 brand（Chromium 系）时附带，与 UA 严格同源——
// Safari/Firefox 档案带 sec-ch-ua 反而会被一致性校验识别。
function extraHeaders(profile) {
  const h = {};
  if (profile.acceptLanguage) h['Accept-Language'] = profile.acceptLanguage;
  if (profile.ip) {
    h['X-Forwarded-For'] = profile.ip;
    h['X-Real-IP'] = profile.ip;
  }
  if (profile.secChUa) {
    h['sec-ch-ua'] = profile.secChUa;
    h['sec-ch-ua-mobile'] = profile.mobile ? '?1' : '?0';
    // UA 里 Chrome/Edge 的平台段决定 sec-ch-ua-platform 取值
    const ua = profile.userAgent || '';
    h['sec-ch-ua-platform'] =
      /Macintosh/.test(ua) ? '"macOS"' :
      /Android|armv8/.test(ua) ? '"Android"' :
      /X11; Linux/.test(ua) ? '"Linux"' : '"Windows"';
  }
  return h;
}

// 加载页面：本地 fixture → Playwright(代理池轮换 + 随机指纹) → 原生 fetch(代理轮换 + 随机指纹)
// 全局节流统一走 config.js 的 netThrottle（跨模块单例）：直连接口与浏览器请求共用一个计时，
// 保证「直连失败回退浏览器」这类跨通道切换也隔一个随机档位。

// 按平台解析请求档案：会话池粘性绑定（Cookie+代理+指纹三元一体，同一平台整个运行期同一会话）。
// mobileOnly 平台（得物/闲鱼等 App 为主站点）强制使用移动端设备档案，
// 不受全局「端型范围」设置影响——这类站点对桌面画像直接弹下载墙/拦截。
// 指纹随机化关闭或移动子池为空时原样返回（降级为普通档案）。
export function resolveProfile(platformId) {
  const profile = acquireSession(platformId, true);
  const cfg = SCRAPE_CONFIG[platformId];
  if (cfg?.mobileOnly && fingerprintEnabled() && !profile.mobile) {
    // randomFingerprint('mobile') 返回请求档案口径的字段（userAgent/acceptLanguage/viewport…），
    // 不能直接 Object.assign 池条目（字段名是 ua/langs，会漏换 UA——曾因此 desktop UA 顶着 mobile:true 出网）
    const f = randomFingerprint('mobile');
    // 保留本次运行已分配的代理与会话信息，仅替换设备画像（三元绑定中代理+会话不变）
    Object.assign(profile, f, { proxy: profile.proxy, sid: profile.sid });
  }
  return profile;
}

async function load(source, platformId): Promise<any> {
  if (source && fs.existsSync(source)) {
    runLog(`使用本地 fixture：${path.basename(source)}`);
    return { html: fs.readFileSync(source, 'utf8'), page: null, browser: null };
  }
  await netThrottle(runLog);
  const pw = NETWORK.usePlaywright ? await getPlaywright() : null;
  let lastErr;
  if (pw) {
    for (let attempt = 1; attempt <= NETWORK.retries; attempt++) {
      if (isStopped()) throw new Error('已手动停止采集');
      const profile = resolveProfile(platformId);
      // UA 展示前 5 个词（到设备型号级）：截 2 个词时 Android UA 只剩 "Mozilla/5.0 (Linux;"，日志无法区分端型
      const shortUA = (profile.userAgent || '').split(' ').slice(0, 5).join(' ');
      runLog(
        `请求[${profile.sid ? `会话#${profile.sid}` : '临时指纹'}] ` +
          `引擎=浏览器 代理=${profile.proxy || '直连'} UA=${shortUA}（第${attempt}/${NETWORK.retries}次）`
      );
      try {
        const r = await loadPlaywright(source, platformId, profile);
        reportSessionOk(profile.sid);
        runLog(`页面加载成功：${shortUrl(source)}（${(r.html.length / 1024).toFixed(0)}KB）`);
        return r;
      } catch (e) {
        markBadSession(profile.sid, 'transient');
        lastErr = e;
        runLog(`浏览器加载失败：${e.message} → 换指纹重试`);
        const gap = randomDelayMs();
        runLog(`重试等待 ${(gap / 1000).toFixed(1)}s（按设置的请求间隔档位）`);
        await sleep(gap);
      }
    }
  }
  // fetch 兜底（浏览器 TLS 伪装 + 会话池轮换；HTTP 封禁语义化分类）
  if (pw) runLog('浏览器引擎不可用/连续失败，切换到 fetch 直取模式');
  for (let attempt = 1; attempt <= NETWORK.retries; attempt++) {
    if (isStopped()) throw new Error('已手动停止采集');
    const profile = resolveProfile(platformId);
    runLog(`请求[${profile.sid ? `会话#${profile.sid}` : '临时指纹'}] 引擎=fetch 代理=${profile.proxy || '直连'}（第${attempt}/${NETWORK.retries}次）`);
    try {
      const r = await loadFetch(source, profile);
      reportSessionOk(profile.sid);
      runLog(`页面加载成功：${shortUrl(source)}（${(r.html.length / 1024).toFixed(0)}KB）`);
      return r;
    } catch (e) {
      lastErr = e;
      // 封禁语义化：按分类处置会话（ip-banned/session-expired → retire 整包丢弃；challenge → 提示浏览器降级）
      const ban = e.ban;
      if (ban) {
        applyBanToSession(profile.sid, ban.kind);
        runLog(`fetch 封禁语义判定[${ban.kind}]：${ban.hint}`);
        if (ban.kind === 'challenge') runLog('处置=降级浏览器渲染通道（fetch 对 JS 挑战无解）');
      } else {
        markBadSession(profile.sid, 'transient');
      }
      runLog(`fetch 加载失败：${e.message} → 换指纹重试`);
      const gap = randomDelayMs();
      runLog(`重试等待 ${(gap / 1000).toFixed(1)}s（按设置的请求间隔档位）`);
      await sleep(gap);
    }
  }
  throw new Error(`抓取失败(${NETWORK.retries}次): ${lastErr?.message}`);
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + (x.pathname.length > 24 ? x.pathname.slice(0, 24) + '…' : x.pathname);
  } catch {
    return String(u).slice(0, 40);
  }
}

async function loadPlaywright(source, platformId, profile) {
  const browser = await pw_launch();
  const url = new URL(source);
  const ctx = await browser.newContext({
    userAgent: profile.userAgent || pickUA(),
    viewport: { width: profile.viewport[0], height: profile.viewport[1] },
    locale: profile.locale || 'zh-CN',
    proxy: profile.proxy ? { server: profile.proxy } : undefined,
    // 移动端画像：移动 UA 必须配 isMobile+hasTouch（否则 WAF 校验 UA ↔ 设备能力一致性即露馅；
    // 得物/闲鱼等 App 系站点靠它识别「伪移动」流量）。桌面档案两值为 false，行为不变。
    isMobile: !!profile.mobile,
    hasTouch: !!profile.mobile,
  });
  // Cookie 注入：登录态（data/cookies/<平台>.json）优先，叠加本次档案的随机 Cookie
  const cookies = [
    ...(profile.cookies || []),
    ...resolveCookies(platformId),
  ];
  if (cookies.length) {
    // Playwright 要求每条 Cookie 带 domain+path（或 url），随机档案 Cookie 只有 name/value，统一补齐
    await ctx.addCookies(cookies.map((c) => ({ ...c, domain: c.domain || url.hostname, path: c.path || '/' })));
    console.log(`[crawler] 已注入 ${cookies.length} 条 Cookie（随机档案 + 登录态）`);
  }
  const page = await ctx.newPage();
  // 监听风控信号：唯品会 TFS 无登录态时商品接口返回 {"msg":"Forbidden by TFS","code":11000}
  let tfsBlocked = false;
  const apiBodies = []; // 捕获平台数据接口响应（如唯品会 rank 接口），供结构化解析拿全字段
  // 各平台数据接口 host 白名单：命中即捕获响应体（apiProductsFromBodies/spuSkuFromBodies 深搜解析）
  // 2026-10-26 扩展：小红书（edith/mall）、抖音（ec.snssdk/jinritemai）、TikTok（tiktokshops/oec）、快手（graphql/rest）
  const API_HOST_RE = /mapi-pc\.vip\.com|mapi\.vip\.com|api\.m\.jd\.com|\.3\.cn\/|yangkeduo\.com\/proxy\/api|openapi\.vmall\.com|edith\.xiaohongshu\.com|mall\.xiaohongshu\.com|ec\.snssdk\.com|jinritemai\.com|tiktokshops\.|oec-api\.tiktokv|kuaishou\.com\/graphql|kuaishou\.com\/rest/;
  page.on('response', async (r) => {
    try {
      if (API_HOST_RE.test(r.url())) {
        if (/search\/product|merchandise|queryPrd|wareList|search/i.test(r.url())) runLog(`平台商品接口响应：${r.status()} ${r.url().slice(0, 90)}`);
        const b = await r.text();
        if (b) {
          if (b.includes('Forbidden by TFS')) {
            tfsBlocked = true;
            runLog('检测到唯品会风控拦截（Forbidden by TFS）：商品接口拒绝无登录态请求');
          }
          if (apiBodies.length < 50) apiBodies.push({ url: r.url(), body: b.slice(0, 3_000_000) });
        }
      }
    } catch {
      /* 读取响应体失败不影响主流程 */
    }
  });
  // 渲染层指纹注入（P1-4）：navigator/WebGL/Canvas 与所选设备档案一致（同会话稳定）；
  // 含原 webdriver/plugins/chrome 反 headless 处理。临时档案（随机化关闭）保持原行为。
  const inject = fingerprintInitScript(profile);
  if (inject) await page.addInitScript(inject);
  else {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      if (!window.chrome) window.chrome = { runtime: {} };
    });
  }
  // 注意：浏览器路径不伪造 X-Forwarded-For——WAF（如唯品会）校验 XFF 与 TCP 源 IP 一致性，
  // 不符直接拒绝加载。XFF 伪造只保留在 fetch 引擎。
  await page.setExtraHTTPHeaders(profile.acceptLanguage ? { 'Accept-Language': profile.acceptLanguage } : {});
  await page.goto(source, { waitUntil: 'domcontentloaded', timeout: NETWORK.timeout });
  try {
    await page.waitForLoadState('networkidle', { timeout: Math.max(NETWORK.renderWait, 3000) });
  } catch {
    await page.waitForTimeout(NETWORK.renderWait);
  }
  try {
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const step = () => {
          window.scrollBy(0, 800);
          y += 800;
          if (y < document.body.scrollHeight && y < 6000) setTimeout(step, 120);
          else resolve();
        };
        step();
      });
    });
  } catch {
    /* 滚动失败不影响主流程 */
  }
  // 自适应渲染等待：JS 重度站点（唯品会等）商品数据靠滚动触发的 XHR 慢慢渲染，
  // 固定等待不够。轮询「正文文本长度 + 图片数」，连续 4 次(约1.2s)不再增长即认为渲染完成。
  // 最短驻留 6s：部分站点（如唯品会）商品 XHR 在加载 5-7s 后才发出，过早关页会漏。
  try {
    let last = -1;
    let stable = 0;
    const start = Date.now();
    const deadline = start + 12000;
    while (Date.now() < deadline && (Date.now() - start < 6000 || stable < 4)) {
      const cur = await page.evaluate(() => (document.body ? document.body.innerText.length : 0) * 1000 + document.images.length);
      if (cur === last) stable++;
      else stable = 0;
      last = cur;
      await page.waitForTimeout(300);
    }
  } catch {
    await page.waitForTimeout(NETWORK.renderWait);
  }
  const html = await page.content();
  // 给接口响应留一点收尾时间（渲染完成的最后时刻可能还有 XHR 落地）
  await page.waitForTimeout(400).catch(() => {});
  return { html, page, browser, tfsBlocked, apiBodies };
}

async function pw_launch() {
  // 优先 Patchright（如已安装），否则官方 Playwright（--disable-blink-features=AutomationControlled 兜底）
  const pr = await getPatchright();
  if (pr) {
    return pr.chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  }
  const pw = await getPlaywright();
  return pw.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
  });
}

async function loadFetch(source, profile) {
  const headers = {
    'User-Agent': profile.userAgent || pickUA(),
    'Accept-Language': profile.acceptLanguage || 'zh-CN,zh;q=0.9',
    ...extraHeaders(profile),
  };
  // 随机档案 Cookie：模拟「不同访客」的本地痕迹
  if (profile.cookies?.length) headers['Cookie'] = profile.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  // 单次尝试：重试由 load() 的外层循环负责（换会话 + 按设置档位延迟），此处只保证全局节流
  await netThrottle(runLog);
  // TLS 伪装通道：impit 按真浏览器逐项对齐握手（JA3/HTTP2），不可用时自动降级 undici
  let res;
  try {
    res = await impersonatedFetch({ url: source, headers, proxy: profile.proxy, timeout: NETWORK.timeout });
  } catch (e) {
    throw new Error(fetchErrText(e));
  }
  if (!res.ok && res.status !== 200) {
    // 封禁语义化：把状态码+响应体分类成 session-expired / ip-banned / challenge / soft-block
    const snippet = await res.text().then((t) => t.slice(0, 1500)).catch(() => '');
    const ban = classifyBan({ status: res.status, body: snippet });
    const err: any = new Error(`HTTP ${res.status}${ban.hint ? `（${ban.hint}）` : ''}`);
    err.ban = ban;
    throw err;
  }
  return { html: await res.text(), page: null, browser: null };
}

async function closePage(browser) {
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}

// 诊断专用：加载任意 URL 或本地 fixture 的 HTML（走完整引擎：代理池 + 随机指纹 + 浏览器渲染 + 懒加载滚动），用完即关。
export async function loadHtml(source, platformId) {
  const { html, browser } = await load(source, platformId);
  await closePage(browser);
  return html;
}

// ---------- 适配器 ----------

export class GenericScrapeAdapter extends BaseAdapter {
  constructor(meta: { platformId: string; name?: string } = { platformId: "" }) {
    super({
      id: meta.platformId,
      name: `${meta.name || '平台'}（爬取）`,
      strategy: 'scrape',
      supported: [DATA_TYPES.PRODUCT, DATA_TYPES.REVIEW, DATA_TYPES.QA],
      rpm: 20,
    });
  }

  _cfg(opts: Record<string, any> = {}) {
    return opts && opts.fixture ? demo : SCRAPE_CONFIG[this.id] || SCRAPE_CONFIG._generic;
  }

  // 详情页采集（评论 + 问答 + SPU/SKU）：直连接口路径与浏览器路径共用。
  // SPU/SKU 合入商品记录的 specs（入库后「商品详情」JSON 视图可见）。
  async _collectDetails(cfg: any, products: any[], opts: Record<string, any> = {}) {
    let reviews = [];
    let qa = [];
    if (!opts.withDetails || !products.length) return { reviews, qa };
    const detailLimit = opts.detailLimit || 3;
    for (const [di, p] of products.slice(0, detailLimit).entries()) {
      if (isStopped()) {
        runLog('已手动停止：跳出详情页采集');
        break;
      }
      const url = resolveDetailUrl(cfg, p);
      if (!url) {
        runLog(`详情页 ${di + 1}/${detailLimit} 跳过：商品「${p.title.slice(0, 20)}」无可用详情链接（itemId=${p.itemId}）`);
        continue;
      }
      runLog(`详情页 ${di + 1}/${detailLimit}：${shortUrl(url)}`);
      try {
        const d = await this.collectDetail(url, { fixture: opts.detailFixture });
        for (const r of d.reviews) {
          r.itemId = r.itemId || p.itemId;
          r.productTitle = r.productTitle || p.title;
        }
        for (const q of d.qa) {
          q.itemId = q.itemId || p.itemId;
          q.productTitle = q.productTitle || p.title;
        }
        reviews = reviews.concat(d.reviews);
        qa = qa.concat(d.qa);
        runLog(`详情页完成：评论 ${d.reviews.length} 条、问答 ${d.qa.length} 条`);
        if (d.spu || (d.skus && d.skus.length)) {
          p.specs = { ...(p.specs || {}) };
          if (d.spu) p.specs.spu = { spuId: p.itemId, title: p.title, brand: p.brand, category: p.category, ...d.spu };
          if (d.skus && d.skus.length) p.specs.skus = d.skus;
          runLog(`详情页提取 SPU/SKU：SPU ${d.spu ? '✓' : '✗'}，SKU/规格组 ${d.skus.length} 条`);
          // SPU 带回来的权威字段回填商品行（list 接口常缺类目/店铺，详情接口的 base 最全）
          const s = d.spu || {};
          if (!p.brand && (s.brandName || s.brand)) p.brand = s.brandName || s.brand;
          if (!p.category && (s.categoryName || s.category)) p.category = s.categoryName || s.category;
          if (!p.shopName && (s.vendorName || s.shopName)) p.shopName = s.vendorName || s.shopName;
          // 价格也是 SPU 权威字段：搜索页常无价格（苏宁 SSR ¥0 占位），详情直连拿到的真实价格回填
          if ((!p.price || Number(p.price) === 0) && Number(s.price) > 0) p.price = Number(s.price);
        } else {
          runLog('详情页未提取到 SPU/SKU（页面未暴露规格数据，可能需要登录态或接口未返回）');
        }
        // ---- 商品详细描述 / 图片集 / 规格参数表：合入商品行（描述入库 description 列，图片并去重，参数进 specs.props） ----
        if (d.description) {
          p.description = d.description;
          runLog(`详情页提取商品描述：${d.description.length} 字`);
        }
        if (d.images && d.images.length) {
          const merged = [...(p.images || [])];
          for (const im of d.images) if (!merged.includes(im)) merged.push(im);
          p.images = merged.slice(0, 30);
          runLog(`详情页提取商品图片：${d.images.length} 张（合并去重后 ${p.images.length} 张）`);
        }
        if (d.props && Object.keys(d.props).length) {
          p.specs = { ...(p.specs || {}) };
          p.specs.props = d.props;
          runLog(`详情页提取规格参数：${Object.keys(d.props).length} 项`);
        }
      } catch (e) {
        if (isStopped()) {
          runLog('已手动停止：跳出详情页采集');
          break;
        }
        runLog(`详情页采集失败 ${shortUrl(url)}：${e.message}`);
        console.warn(`[crawler] 详情页采集失败 ${url}: ${e.message}`);
      }
    }
    return { reviews, qa };
  }

  async collectProduct(query: string, opts: Record<string, any> = {}) {
    await this.guard();
    if (isStopped()) throw new Error('已手动停止采集');
    const cfg = this._cfg(opts);
    // 直连接口通道（如唯品会 mapi）：跳过浏览器渲染，结构化字段最全、最稳定。
    // 失败或为空自动回退浏览器渲染路径。
    if (cfg.directApi && !opts.fixture) {
      try {
        if (isStopped()) throw new Error('已手动停止采集');
        await netThrottle(runLog);
        const direct = await cfg.directApi({ query, limit: opts.limit || 20, log: runLog });
        if (direct.length) {
          // 直连拿到商品后同样执行详情页流程（评论/问答/SPU/SKU）
          const d = await this._collectDetails(cfg, direct, opts);
          return { products: direct, reviews: d.reviews, qa: d.qa };
        }
        runLog('直连接口返回 0 条，回退浏览器渲染路径');
      } catch (e) {
        runLog(`直连接口失败（${String(e.message).slice(0, 90)}），回退浏览器渲染路径`);
      }
    }
    const source = opts.fixture || (cfg.searchUrl ? cfg.searchUrl(query) : query);
    const { html, page, browser, tfsBlocked, apiBodies } = await load(source, this.id);
    try {
      let products = [];
      if (page) {
        const raw = await inBrowserExtract(page);
        products = normalizeProducts(raw, cfg);
        if (products.length < 3) {
          const ld = extractJsonLd(html).filter((n) => n['@type'] === 'Product');
          if (ld.length) products = products.concat(parseProductsJsonLd(ld, cfg));
        }
      }
      if (!products.length) products = parseProducts(html, cfg);
      if (!products.length) {
        if (tfsBlocked) {
          throw new Error(
            `唯品会风控拦截（Forbidden by TFS）：商品搜索接口拒绝无登录态请求。\n` +
              `解决：到面板「爬虫设置 → 登录态提取」选 ${this.id} 点「提取登录态」，弹出浏览器登录后自动保存，再重新采集。\n` +
              `（命令行等价：node tools/cookie-tool.ts extract --platform ${this.id}）`
          );
        }
        // 平台专属说明优先（如得物：无网页商城 + 验证码风控，登录态也解决不了），不受页面大小阈值影响
        if (cfg.noProductHint) throw new Error(`页面已渲染（${(html.length / 1024).toFixed(0)}KB）但其中没有商品数据。${cfg.noProductHint}`);
        if (html.length > 60 * 1024) {
          // 页面渲染了但没商品：多半是站点要求登录态/设备指纹，商品接口根本没被调用。
          throw new Error(
            `页面已渲染（${(html.length / 1024).toFixed(0)}KB）但其中没有商品数据——` +
              `该站点的商品接口需要登录态（浏览器未登录时前端不会发起商品请求，或被风控拒绝）。\n` +
              `解决：到面板「爬虫设置 → 登录态提取」选 ${this.id} 点「提取登录态」，登录成功后自动保存，再重新采集。`
          );
        }
        throw new Error(
          `未从页面解析到商品（页面 ${(html.length / 1024).toFixed(0)}KB）。诊断建议：\n` +
            `  ① 页面很小(<30KB) → 站点强反爬/需登录 → 到「爬虫设置 → 登录态提取」选 ${this.id} 弹浏览器登录后重试；\n` +
            `  ② 页面较大但无商品 → 商品接口需登录态或被风控（同上提取 Cookie）；\n` +
            `  ③ 需要精确字段时，到 config.js 校准 ${this.id} 的选择器或用「字段提取诊断」检查页面结构。`
        );
      }
      // 接口结构化商品优先：字段比 DOM 启发式全（品牌/类目/销量/店铺/精确价格/市场价）
      const apiRaw = apiProductsFromBodies(apiBodies || []);
      if (apiRaw.length && apiRaw.length >= products.length) {
        products = mapApiProducts(apiRaw, cfg, this.id);
        runLog(`已采用商品接口结构化数据：${products.length} 条（含品牌/价格/销量/店铺）`);
      }
      products = products.map((p) => ({ ...p, platform: this.id, platformName: cfg.name }));
      runLog(`解析到商品 ${products.length} 条（平台=${cfg.name}）`);

      // 详情页评论 + 公开问答（问大家 / 聊天记录）+ SPU/SKU 规格信息
      const d = await this._collectDetails(cfg, products, opts);
      return { products, reviews: d.reviews, qa: d.qa };
    } finally {
      await closePage(browser);
    }
  }

  // 采集单个商品详情页：评论 + 公开问答 + SPU/SKU 规格信息
  async collectDetail(url: string, opts: Record<string, any> = {}) {
    await this.guard();
    if (isStopped()) throw new Error('已手动停止采集');
    const cfg = this._cfg(opts);
    const source = opts.fixture || url;

    // ⓪ 直连详情接口（如唯品会 detail/main/v6 POST）：SPU/SKU 最稳来源（详情页前端经常不触发主接口 XHR）。
    // 失败不回退浏览器——浏览器捕获的响应体仍会走 ①② 兜底解析。
    let directSku = null;
    if (cfg.detailApi && !opts.fixture) {
      const u = String(url);
      // 各平台详情 id 提取（顺序敏感）：
      //  vip detail-<brandId>-<itemId>.html → 亚马逊 /dp/<ASIN> → 苏宁 product.suning.com/<shopCode>/<partNum>.html
      //  → 京东 item(.m).jd.com/<sku>.html → 华为 vmall.com/product/<prdId>.html → 兜底 10+ 位数字
      const itemId =
        (u.match(/detail-\d+-(\d+)\.html/) || [])[1] ||
        (u.match(/\/dp\/([A-Z0-9]{10})/i) || [])[1] ||
        (u.match(/product\.suning\.com\/\d+\/(\d+)\.html/) || [])[1] ||
        (u.match(/item\.(?:m\.)?jd\.com\/(?:product\/)?(\d{10,})\.html/) || [])[1] ||
        (u.match(/vmall\.com\/product\/(\d{8,})\.html/) || [])[1] ||
        (u.match(/(\d{10,})/) || [])[1] ||
        '';
      if (itemId) {
        try {
          if (isStopped()) throw new Error('已手动停止采集');
          await netThrottle(runLog);
          directSku = await cfg.detailApi({ itemId, url: u, log: runLog });
        } catch (e) {
          runLog(`详情直连接口失败（${String(e.message).slice(0, 90)}），回退浏览器捕获解析`);
        }
      }
    }

    // 浏览器加载：失败时若直连已拿到 SPU/SKU，直接返回直连结果（不丢数据）
    let loaded = null;
    try {
      loaded = await load(source, this.id);
    } catch (e) {
      if (directSku && ((directSku.spu && Object.keys(directSku.spu).length) || directSku.skus.length)) {
        runLog(`详情页浏览器加载失败（${String(e.message).slice(0, 80)}），仅采用直连 SPU/SKU`);
        return {
          reviews: [],
          qa: [],
          spu: directSku.spu,
          skus: directSku.skus,
          description: '',
          images: [],
          props: null,
        };
      }
      throw e;
    }
    const { html, page, browser, apiBodies } = loaded;
    // 给浏览器响应捕获留 0.6s 收尾：详情页主接口（如唯品会 detail/main/v6）的响应体
    // 可能还在 text() 等待中，直接解析会漏掉
    if (Array.isArray(apiBodies) && apiBodies.length) {
      await new Promise((r) => setTimeout(r, 600));
      runLog(
        `详情页接口捕获：${apiBodies.length} 条` +
          (apiBodies.some((b) => /detail\/main/.test(b.url || '')) ? '（含商品主接口 detail/main）' : '')
      );
    }
    try {
      let reviews = [];
      let qa = [];
      let spu = directSku ? directSku.spu : null;
      let skus = directSku ? directSku.skus : [];
      // 详情扩展信息：商品详细描述 / 图片集 / 规格参数表
      let detailInfo = { description: '', images: [], props: null };
      if (directSku && (spu || skus.length)) runLog(`已采用详情接口结构化 SPU/SKU（SPU ${spu ? '✓' : '✗'}，SKU ${skus.length} 条）`);
      if (page) {
        const rawReviews = await inBrowserExtractReviews(page);
        if (rawReviews.length) reviews = normalizeReviews(rawReviews, cfg);
        const rawQa = await inBrowserExtractQa(page);
        if (rawQa.length) qa = normalizeQa(rawQa, cfg);
        // ---- SPU/SKU：四层策略（① 平台专属接口解析 → ② 通用接口深搜 → ③ 页面内嵌 JSON/DOM 规格区 → ④ JSON-LD offers） ----
        // ① 平台专属解析（如唯品会 detail/main/v6：data.base=SPU、saleProps=规格维度、products=SKU 价格）
        if (!spu && !skus.length && cfg.detailSpuSku) {
          try {
            const v = cfg.detailSpuSku(apiBodies || []);
            if (v.spu) spu = v.spu;
            if (v.skus && v.skus.length) skus = v.skus;
            if (v.propGroups && v.propGroups.length && !skus.length) {
              // 有规格维度但没有 SKU 明细时，至少保留维度组
              skus = v.propGroups.map((g) => ({ skuId: '', name: g.name, options: g.values.map((x) => x.name) }));
            }
          } catch {
            /* 平台解析失败走通用兜底 */
          }
        }
        // ② 通用接口深搜（字段名灵活匹配，适配任意平台的商品接口）
        if (!spu && !skus.length) {
          try {
            const apiSku = spuSkuFromBodies(apiBodies || []);
            if (apiSku.spu) spu = apiSku.spu;
            if (apiSku.skus.length) skus = apiSku.skus;
          } catch {
            /* 结构化解析失败不影响主流程 */
          }
        }
        // ③ 页面内嵌全局状态（__INITIAL_STATE__ / __NUXT__ / __NEXT_DATA__）里的规格数据
        if (!skus.length) {
          try {
            const state = await page.evaluate(() => {
              for (const k of ['__INITIAL_STATE__', '__NUXT__', '__NEXT_DATA__']) {
                if (window[k]) return window[k];
              }
              return null;
            });
            if (state) {
              const t = JSON.stringify(state);
              if (t && t.length < 8_000_000) {
                const r = spuSkuFromBodies([{ body: t }]);
                if (!spu && r.spu) spu = r.spu;
                if (r.skus.length) skus = r.skus;
              }
            }
          } catch {
            /* 内嵌状态不存在/解析失败跳过 */
          }
        }
        // ③b DOM 规格区兜底：抽「尺码/颜色/规格」选项组
        if (!skus.length) {
          try {
            const groups = await inBrowserExtractSku(page);
            skus = groups.map((g) => ({ skuId: '', name: g.name, options: g.options }));
          } catch {
            /* DOM 抽取失败跳过 */
          }
        }
        // ④ SPU 兜底：页面 meta / document.title（接口没给商品级信息时）
        if (!spu) {
          try {
            spu = await page.evaluate(() => {
              const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '';
              const t = meta('og:title') || document.title.replace(/[-_|｜].{0,12}$/, '').trim() || '';
              if (!t || t.length < 4) return null;
              return {
                spuId: '',
                title: t.slice(0, 200),
                brand: meta('og:brand') || meta('brand') || '',
                category: '',
                image: meta('og:image') || '',
              };
            });
          } catch {
            /* meta 抽取失败跳过 */
          }
        }
        // ---- 商品详细描述 / 图片集 / 规格参数表（三层：JSON-LD → meta/og → DOM 启发式） ----
        try {
          detailInfo = await page.evaluate(() => {
            const out = { description: '', images: [], props: null };
            const abs = (u) => {
              if (!u || typeof u !== 'string') return '';
              try {
                return /^https?:\/\//i.test(u) ? u : /^\/\//.test(u) ? 'https:' + u : new URL(u, location.href).href;
              } catch {
                return '';
              }
            };
            // ① JSON-LD Product：description / image / additionalProperty(规格参数)
            for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
              try {
                const data = JSON.parse(s.textContent);
                for (const n of Array.isArray(data) ? data : data && data['@graph'] ? data['@graph'] : [data]) {
                  if (!n || n['@type'] !== 'Product') continue;
                  if (!out.description && typeof n.description === 'string') {
                    out.description = n.description.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
                  }
                  const im = Array.isArray(n.image) ? n.image : n.image ? [n.image] : [];
                  for (const x of im) {
                    const u = abs(typeof x === 'string' ? x : x && x.url);
                    if (u && !out.images.includes(u)) out.images.push(u);
                  }
                  const ap = Array.isArray(n.additionalProperty) ? n.additionalProperty : [];
                  if (ap.length && !out.props) {
                    const p = {};
                    for (const a of ap) if (a && a.name && a.value != null) p[String(a.name).slice(0, 40)] = String(a.value).slice(0, 120);
                    if (Object.keys(p).length >= 3) out.props = p;
                  }
                }
              } catch {
                /* 坏 JSON 跳过 */
              }
            }
            // ② meta/og
            const meta = (n) => document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '';
            if (!out.description) out.description = (meta('og:description') || meta('description')).replace(/\s+/g, ' ').trim().slice(0, 4000);
            if (!out.images.length) {
              const u = abs(meta('og:image'));
              if (u) out.images.push(u);
            }
            // ③ DOM 图片集：大图（≥200px）、非 icon/logo/sprite、去重补协议；JSON-LD 已给图则只补到 3 张为止
            if (out.images.length < 20) {
              const seen = new Set(out.images);
              const wantMore = out.images.length < 3 ? 20 : 3;
              for (const img of document.images) {
                if (out.images.length >= Math.max(wantMore, 3)) break;
                const w = img.naturalWidth || img.width || 0;
                if (w < 200) continue;
                const src = img.currentSrc || img.src || '';
                if (!src || /^data:/.test(src)) continue;
                if (/logo|icon|sprite|avatar|badge|flag|placeholder|qrcode/i.test(src + ' ' + (img.className || ''))) continue;
                const u = abs(src);
                if (!u || seen.has(u)) continue;
                seen.add(u);
                out.images.push(u);
              }
            }
            // ④ DOM 规格参数表：详情/参数语境的 table，行内「名-值」成对抽取（≥3 对才认）
            if (!out.props) {
              const props = {};
              const cells = (tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
              for (const table of document.querySelectorAll('table')) {
                if (Object.keys(props).length >= 40) break;
                const ctx = `${table.className || ''} ${table.id || ''} ${(table.closest('[class*="detail"],[class*="param"],[class*="spec"],[class*="attr"]') || {}).className || ''}`;
                if (!/param|spec|attr|detail|prop/i.test(ctx)) continue;
                for (const tr of table.querySelectorAll('tr')) {
                  if (Object.keys(props).length >= 40) break;
                  const c = cells(tr);
                  if (c.length === 2 && c[0].length <= 30 && c[1].length <= 120) props[c[0]] = c[1];
                  else if (c.length >= 4) {
                    for (let i = 0; i + 1 < c.length; i += 2) {
                      if (c[i].length <= 30 && c[i + 1].length <= 120) props[c[i]] = c[i + 1];
                      if (Object.keys(props).length >= 40) break;
                    }
                  }
                }
                if (Object.keys(props).length >= 3) break;
              }
              if (Object.keys(props).length >= 3) out.props = props;
            }
            // ⑤ DOM 描述兜底：详情描述区最长文本块（50~8000 字）
            if (out.description.length < 50) {
              let best = '';
              for (const el of document.querySelectorAll('[class*="desc"], #detail, [class*="detail-content"], [class*="detail-desc"]')) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (t.length > best.length && t.length >= 50 && t.length <= 8000) best = t;
              }
              if (best) out.description = best.slice(0, 4000);
            }
            return out;
          });
        } catch {
          detailInfo = extractDetailInfoFromHtml(html);
        }
      }
      if (!reviews.length) reviews = parseReviews(html, cfg);
      if (!qa.length && cfg.qa) qa = parseQa(html, cfg);
      // 无浏览器路径（fetch/fixture）：HTML 正则解析（JSON-LD → meta）
      if (!page) detailInfo = extractDetailInfoFromHtml(html);
      // JSON-LD offers 多规格变体兜底（服务端渲染站点）
      if (!skus.length) {
        const ld = extractJsonLd(html).filter((n) => n['@type'] === 'Product');
        const offers = [];
        for (const n of ld) {
          const arr = Array.isArray(n.offers) ? n.offers : n.offers ? [n.offers] : [];
          for (const o of arr) {
            if (o && (o.sku || o.name)) {
              offers.push({
                skuId: String(o.sku || ''),
                size: String(o.name || ''),
                price: parseFloat(String(o.price ?? '').replace(/[^\d.]/g, '')) || 0,
              });
            }
          }
        }
        if (offers.length > 1) skus = offers.slice(0, 50);
      }
      return {
        reviews: reviews.map((r) => ({ ...r, platform: this.id, platformName: cfg.name })),
        qa: qa.map((q) => ({ ...q, platform: this.id, platformName: cfg.name })),
        spu,
        skus,
        description: detailInfo.description || '',
        images: detailInfo.images || [],
        props: detailInfo.props || null,
      };
    } finally {
      await closePage(browser);
    }
  }

  async collectReviews(itemId: string, opts: Record<string, any> = {}) {
    await this.guard();
    const cfg = this._cfg(opts);
    // 详情页即评论所在页：优先用平台 detailUrl 构造，其次直接当 URL
    const source = opts.fixture || (cfg.detailUrl ? cfg.detailUrl(itemId) : itemId);
    const { html, browser } = await load(source, this.id);
    try {
      const reviews = parseReviews(html, cfg);
      if (!reviews.length) {
        throw new Error(
          `未从页面解析到评论。运行 --verify 诊断，或到 config.js 校准 ${this.id} 的 review 选择器/fields；` +
            `也可改用 --fixture data/fixtures/demo-reviews.html 验证解析内核。`
        );
      }
      return reviews.map((r) => ({ ...r, platform: this.id, platformName: cfg.name }));
    } finally {
      await closePage(browser);
    }
  }

  // 公开问答（问大家）：复用详情页解析
  async collectQa(itemId: string, opts: Record<string, any> = {}) {
    await this.guard();
    const cfg = this._cfg(opts);
    const source = opts.fixture || (cfg.detailUrl ? cfg.detailUrl(itemId) : itemId);
    const { html, browser } = await load(source, this.id);
    try {
      const qa = cfg.qa ? parseQa(html, cfg) : [];
      if (!qa.length) {
        throw new Error(`未从页面解析到问答。可用 --detail-fixture 验证解析内核。`);
      }
      return qa.map((q) => ({ ...q, platform: this.id, platformName: cfg.name }));
    } finally {
      await closePage(browser);
    }
  }

  /** 校准诊断：返回当前选择器在 HTML 上「每个字段」的命中数与样例值（不落库）。
   *  source 可为本地文件路径；也可通过 opts.html 直接传 HTML（配合 loadHtml 的在线 URL 诊断）。 */
  diagnose(source: string, kind: string, opts: Record<string, any> = {}) {
    const cfg = this._cfg(opts);
    const html = opts.html || (source && fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : null);
    if (!html) return { ok: false, reason: 'diagnose 需要本地 fixture 文件路径，或通过 loadHtml 先取回 HTML' };
    const key = kind === 'review' ? 'review' : kind === 'qa' ? 'qa' : 'product';
    const blockCfg = cfg[key];
    const blocks = extractBlocks(html, blockCfg.cardOpen);
    const fields: Record<string, any> = (blockCfg as any).fields;

    // 每个字段独立报告：选择器写法 / 在 N 个卡片块里抽出值的数量 / 样例
    const fieldReport = Object.entries(fields).map(([name, f]) => {
      const selector = f.attr ? `<${f.tag} ${f.attr}="...">` : `<${f.tag} class~="${f.cls}">`;
      const values = blocks.map((b) => pickField(b, f)).filter((v) => v && String(v).length);
      return { field: name, selector, matched: values.length, sample: values.slice(0, 3) };
    });

    // 可用卡片块 = 至少抽出一个字段的块（与 parseXxx 的入库口径一致）
    const usable = blocks.filter((b) => Object.values(fields).some((f) => pickField(b, f)));
    const sample = usable.slice(0, 3).map((b, i) => {
      const o = { _block: i };
      for (const [k, v] of Object.entries(fields)) o[k] = pickField(b, v);
      return o;
    });

    const ldType = kind === 'review' ? 'Review' : 'Product';
    const ld = extractJsonLd(html).filter((n) => n['@type'] === ldType);

    // 交叉核对：平台选择器全空时，用「通用测试配置(demo)」再扫一遍，
    // 区分「HTML 里根本没有商品内容」与「有内容但平台选择器没对准」。
    let crossCheck;
    if (!usable.length && !ld.length && key === 'product') {
      const gBlocks = extractBlocks(html, demo.product.cardOpen);
      const gUsable = gBlocks.filter((b) => Object.values(demo.product.fields).some((f) => pickField(b, f)));
      if (gUsable.length) {
        crossCheck = `通用测试选择器在该 HTML 上命中 ${gUsable.length} 块（样例标题：${pickField(gUsable[0], demo.product.fields.title).slice(0, 30)}…）——说明页面内容可解析，只是 ${this.id} 的平台选择器没对准。`;
      }
    }

    // 建议：三层策略哪层能出数据、下一步做什么
    let strategy, advice;
    if (usable.length > 0) {
      strategy = '② CSS 类选择器';
      advice = `选择器可用：能从 ${blocks.length} 个卡片块中抽全字段的约 ${usable.length} 个。直接采集即可获得完整字段。`;
    } else if (ld.length > 0) {
      strategy = '③ JSON-LD 结构化数据';
      advice = `选择器未命中，但页面含 ${ld.length} 条 JSON-LD(${ldType})，采集会走 JSON-LD 兜底（字段较全但依赖站点标注）。`;
    } else if (crossCheck) {
      strategy = '无命中';
      advice = `${crossCheck}请打开页面用开发者工具查看商品卡片的真实 class 名，到 server/adapters/scrape/config.js 校准 ${this.id} 的 product.cardOpen 与 fields。`;
    } else if (html.length < 80 * 1024) {
      strategy = '无命中';
      advice = `选择器与 JSON-LD 均未命中，且 HTML 仅 ${(html.length / 1024).toFixed(0)}KB——页面很可能是 JS 动态渲染。请改用「在线 URL」模式（会启用浏览器渲染+懒加载滚动）重试；若仍为 0，把渲染后页面另存为 HTML 再诊断。`;
    } else {
      strategy = '无命中';
      advice = `选择器与 JSON-LD 均未命中（HTML ${(html.length / 1024).toFixed(0)}KB，非空页面）。请打开页面用开发者工具查看商品卡片的真实 class 名，到 server/adapters/scrape/config.js 校准 ${this.id} 的 ${key}.cardOpen 与 fields。`;
    }

    return {
      ok: true,
      source: opts.html ? opts.url || '(传入的 HTML)' : source,
      kind,
      htmlSize: html.length,
      strategy,
      advice,
      selectorBlocks: blocks.length,
      usableBlocks: usable.length,
      jsonLd: ld.length,
      fields: fieldReport,
      sample,
    };
  }
}
