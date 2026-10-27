// 各平台爬取配置（选择器需按目标站实际结构维护；反爬升级时同步更新）
// 说明：电商站点 HTML 结构频繁变动，以下为「起始模板」，真实抓取前请核对当前页面。
// 离线验证专用 `demo` 配置与 data/fixtures/*.html 严格对齐，保证解析内核可端到端验证。
import { fetchVipProducts, extractVipDetailSpuSku, fetchVipDetailSpuSku } from './vip-api.ts';
import { fetchAmazonProducts, fetchAmazonDetailSpuSku, parseAmazonDetailHtml, amazonReviewsPageUrl, extractAmazonReviewsDom, fetchAmazonReviews } from './amazon-api.ts';
import { fetchSuningDetailSpuSku, fetchSuningProducts } from './suning-api.ts';
import { fetchTaobaoProducts, fetchXianyuProducts } from './mtop-api.ts';
import { fetchHuaweiProducts, fetchHuaweiDetailSpuSku } from './huawei-api.ts';
import { fetchJdDetailSpuSku } from './jd-api.ts';

// ---------- 反爬 / 网络参数（集中可调） ----------

// UA 池：每次请求随机挑一个，降低被指纹识别的概率
export const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
];

// 默认网络参数；均可用环境变量覆盖（详见 README）
export const NETWORK = {
  // 限速（请求间随机停顿，毫秒）。调小=更快但更易被封。
  delayMin: Number(process.env.CRAWL_DELAY_MIN) || 800,
  delayMax: Number(process.env.CRAWL_DELAY_MAX) || 2500,
  timeout: Number(process.env.CRAWL_TIMEOUT) || 30000, // 单页超时
  retries: Number(process.env.CRAWL_RETRIES) || 3, // 失败重试次数
  renderWait: Number(process.env.CRAWL_RENDER_WAIT) || 1500, // Playwright 取 DOM 后等待异步渲染
  proxy: process.env.CRAWL_PROXY || '', // 形如 http://user:pass@host:port
  usePlaywright: process.env.CRAWL_NO_PW !== 'true', // 默认优先用 Playwright；设 CRAWL_NO_PW=true 禁用
};

export function pickUA() {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
}
/** 随机延迟毫秒数（delayMin~delayMax 档位，读运行时设置——重试间隔同样适用）。 */
export function randomDelayMs() {
  const min = Number(NETWORK.delayMin) || 800;
  const max = Math.max(min, Number(NETWORK.delayMax) || 2500);
  return min + Math.random() * (max - min);
}

export function randomDelay() {
  return new Promise((r) => setTimeout(r, randomDelayMs()));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 全局网络节流（跨模块单例）：任意两次真实网络请求（直连接口 / 浏览器页面）之间
// 至少间隔一个随机档位（delayMin~delayMax）。所有请求出口统一过 netThrottle，
// 避免「直连接口的请求不更新浏览器通道的计时」导致 rank→list、直连→浏览器回退零间隔连发。
let lastNetAt = 0;
export async function netThrottle(log = (_m?: string) => {}) {
  const min = Number(NETWORK.delayMin) || 800;
  const max = Math.max(min, Number(NETWORK.delayMax) || 2500);
  const gap = min + Math.random() * (max - min);
  const wait = lastNetAt + gap - Date.now();
  if (wait > 300) {
    log(`节流等待 ${(wait / 1000).toFixed(1)}s（两次真实请求至少间隔 ${Math.round(min)}~${Math.round(max)}ms）`);
    await new Promise((r) => setTimeout(r, wait));
  }
  lastNetAt = Date.now(); // 等待结束后记时：下一个请求从本次真实请求时刻起算间隔
}

export const UA = UA_POOL[0];

// 通用兜底配置
const generic = {
  name: '通用',
  searchUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  // 详情页：传入商品链接时直接作为详情 URL；传入 itemId 时回退到搜索
  detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.google.com/search?q=${encodeURIComponent(itemIdOrUrl)}`),
  product: {
    cardOpen: /<div class="product-card"/i,
    fields: {
      title: { tag: 'h3', cls: 'title' },
      price: { tag: 'span', cls: 'price' },
      shop: { tag: 'div', cls: 'shop' },
      url: { tag: 'a', cls: 'link', attr: 'href' },
    },
  },
  review: {
    cardOpen: /<div class="review-card"/i,
    fields: {
      rating: { tag: 'span', cls: 'rating' },
      content: { tag: 'p', cls: 'content' },
      author: { tag: 'span', cls: 'author' },
    },
  },
  // 商品详情页公开问答（问大家 / 买家问答）；亦作「聊天记录」来源（公开内容）
  qa: {
    cardOpen: /<div class="qa-item"/i,
    fields: {
      q: { tag: 'div', cls: 'q' },
      a: { tag: 'div', cls: 'a' },
      asker: { tag: 'span', cls: 'asker' },
    },
  },
};

// 离线验证专用（与 data/fixtures/demo-*.html 对齐）
export const demo = {
  name: '离线验证',
  searchUrl: (q) => `https://www.demo.com/s?q=${encodeURIComponent(q)}`,
  detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://item.demo/${itemIdOrUrl}`),
  product: {
    cardOpen: /<div class="product-card"/i,
    fields: {
      title: { tag: 'h3', cls: 'title' },
      price: { tag: 'span', cls: 'price' },
      shop: { tag: 'div', cls: 'shop' },
      url: { tag: 'a', cls: 'link', attr: 'href' },
    },
  },
  review: {
    cardOpen: /<div class="review-card"/i,
    fields: {
      rating: { tag: 'span', cls: 'rating' },
      content: { tag: 'p', cls: 'content' },
      author: { tag: 'span', cls: 'author' },
    },
  },
  qa: {
    cardOpen: /<div class="qa-item"/i,
    fields: {
      q: { tag: 'div', cls: 'q' },
      a: { tag: 'div', cls: 'a' },
      asker: { tag: 'span', cls: 'asker' },
    },
  },
};

// 真实平台模板（selector 为起始值，需按实际页面校准）
export const SCRAPE_CONFIG = {
  _generic: generic,
  demo,
  jd: {
    name: '京东',
    searchUrl: (q) => `https://search.jd.com/Search?keyword=${encodeURIComponent(q)}`,
    // 详情直连：item.m.jd.com SSR 内嵌 _itemOnly/_itemInfo（SKU 变体 + 真实价格）；
    // PC 端 item.jd.com 是 JS 壳无数据。搜索接口需签名，仍走浏览器渲染（登录态下走响应捕获）。
    detailApi: fetchJdDetailSpuSku,
    // 详情页标准结构 item.jd.com/<sku>.html（10~12 位数字）；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://item.jd.com/${encodeURIComponent(itemIdOrUrl)}.html`),
    product: {
      cardOpen: /<li[^>]*class="[^"]*gl-item/i,
      fields: {
        title: { tag: 'div', cls: 'p-name' },
        price: { tag: 'strong', cls: 'J_' },
        shop: { tag: 'div', cls: 'p-shop' },
        url: { tag: 'a', cls: 'p-name', attr: 'href' },
      },
    },
    review: {
      cardOpen: /<div[^>]*class="[^"]*comment-item/i,
      fields: {
        rating: { tag: 'span', cls: 'star' },
        content: { tag: 'p', cls: 'comment-con' },
        author: { tag: 'span', cls: 'user' },
      },
    },
    // 京东「问大家」公开问答
    qa: {
      cardOpen: /<div[^>]*class="[^"]*qa-item|question-item|ask-item/i,
      fields: {
        q: { tag: 'div', cls: 'question' },
        a: { tag: 'div', cls: 'answer' },
        asker: { tag: 'span', cls: 'ask-user' },
      },
    },
  },
  taobao: {
    name: '淘宝/天猫',
    searchUrl: (q) => `https://s.taobao.com/search?q=${encodeURIComponent(q)}`,
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://item.taobao.com/item.htm?id=${encodeURIComponent(itemIdOrUrl)}`),
    // mtop 签名直连（登录态必需；无登录态返回空自动回退浏览器渲染）
    directApi: fetchTaobaoProducts,
    product: {
      cardOpen: /<div[^>]*class="[^"]*Card--[^"]*"/i,
      fields: {
        title: { tag: 'div', cls: 'title' },
        price: { tag: 'strong', cls: 'price' },
        shop: { tag: 'span', cls: 'shop' },
        url: { tag: 'a', cls: 'item', attr: 'href' },
      },
    },
    review: { cardOpen: /<div[^>]*class="[^"]*review/i, fields: { rating: { tag: 'span', cls: 'rate' }, content: { tag: 'div', cls: 'content' }, author: { tag: 'span', cls: 'user' } } },
    // 淘宝「问大家」公开问答
    qa: {
      cardOpen: /<div[^>]*class="[^"]*question|qa-item|ask-item/i,
      fields: {
        q: { tag: 'div', cls: 'question' },
        a: { tag: 'div', cls: 'answer' },
        asker: { tag: 'span', cls: 'ask-user' },
      },
    },
  },
  pdd: {
    name: '拼多多',
    searchUrl: (q) => `https://mobile.yangkeduo.com/search_result.html?search_key=${encodeURIComponent(q)}`,
    // 搜索/详情接口均要求 anti-content 反爬签名（匿名 403 error_code=40003），无匿名直连可行；
    // 浏览器+登录态路径的响应捕获已加入 proxy/api（generic.js），登录后可拿结构化商品数据。
    // 详情页标准结构 goods.html?goods_id=<id>（未登录会跳登录页，需登录态）
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://mobile.yangkeduo.com/goods.html?goods_id=${encodeURIComponent(itemIdOrUrl)}`),
    product: { cardOpen: /<div[^>]*class="[^"]*goods-item/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'mall' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'text' }, author: { tag: 'span', cls: 'name' } } },
  },
  huawei: {
    name: '华为商城',
    searchUrl: (q) => `https://www.vmall.com/search?keyword=${encodeURIComponent(q)}`,
    // 搜索直连：openapi.vmall.com/mcp/v1/search/queryPrd（csrfToken 头 + 会话 Cookie，匿名可调，字段最全）
    directApi: fetchHuaweiProducts,
    // 详情直连：comdetail SSR __NEXT_DATA__（base=每 SKU 名称/价格/规格/库存）
    detailApi: fetchHuaweiDetailSpuSku,
    // 详情页标准结构 www.vmall.com/product/<prdId>.html（14 位数字）；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.vmall.com/product/${encodeURIComponent(itemIdOrUrl)}.html`),
    product: { cardOpen: /<div[^>]*class="[^"]*prd-item/i, fields: { title: { tag: 'div', cls: 'name' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'score' }, content: { tag: 'p', cls: 'txt' }, author: { tag: 'span', cls: 'name' } } },
  },
  amazon: {
    name: '亚马逊',
    searchUrl: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
    // 直连通道：搜索/详情页均为服务端渲染完整 HTML，直接解析（海外站走代理，无验证码时最稳最快）
    directApi: fetchAmazonProducts,
    detailApi: fetchAmazonDetailSpuSku,
    detailSpuSku: (apiBodies) => ({ spu: null, skus: [], propGroups: [] }), // 直连已覆盖；浏览器捕获走通用深搜
    // 直连被重置/拦截时，用浏览器加载的同一份 SSR HTML 跑同一解析器（twister/价格/品牌）
    detailHtmlParse: parseAmazonDetailHtml,
    // 详情页 SSR 不渲染评论（登录后也只有 Top reviews 摘要）→ 通用流程导航到评论列表页提取
    reviewsPage: amazonReviewsPageUrl,
    extractReviewsDom: (page) => extractAmazonReviewsDom(page, 30),
    // 评论列表页直连（SSR HTML 正则解析；浏览器导航被墙时的独立路径）
    fetchReviewsDirect: fetchAmazonReviews,
    // 详情页标准结构 amazon.com/dp/<ASIN>（10 位字母数字）；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.amazon.com/dp/${encodeURIComponent(itemIdOrUrl)}`),
    currency: 'USD',
    // 浏览器兜底解析护栏：只认 /dp/<ASIN> 详情链接（搜索页推荐位/广告位同块里的
    // ISBN-10 纯数字链接曾被当成 itemId，14 条同号垃圾数据入库教训）
    product: { cardOpen: /<div[^>]*class="[^"]*s-result-item/i, urlAccept: /\/dp\/[A-Z0-9]{10}/i, itemIdPattern: /\/dp\/([A-Z0-9]{10})/i, fields: { title: { tag: 'span', cls: 'a-text-normal' }, price: { tag: 'span', cls: 'a-price' }, shop: { tag: 'span', cls: 'a-size-base' }, url: { tag: 'a', cls: 'a-link-normal', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*review/i, fields: { rating: { tag: 'span', cls: 'a-icon-alt' }, content: { tag: 'span', cls: 'review-text' }, author: { tag: 'span', cls: 'a-profile-name' } } },
  },
  vip: {
    name: '唯品会',
    // 注意：旧地址 www.vip.com/search?keyword= 已下线（直接 404），现行 PC 搜索走 category.vip.com
    searchUrl: (q) => `https://category.vip.com/suggest.php?keyword=${encodeURIComponent(q)}&count=20`,
    // 直连接口通道：搜索页前端经常不触发商品 XHR（只出模板壳），直接调 mapi-pc rank+list 接口最稳、字段最全
    directApi: fetchVipProducts,
    // 详情页 SPU/SKU 解析：直连 detail/main/v6 接口（最稳），浏览器捕获响应解析作兜底
    detailApi: fetchVipDetailSpuSku,
    detailSpuSku: extractVipDetailSpuSku,
    // 唯品会详情页标准结构 detail.vip.com/detail-<brandId>-<itemId>.html；传入完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://detail.vip.com/detail-0-${encodeURIComponent(itemIdOrUrl)}.html`),
    product: { cardOpen: /<div[^>]*class="[^"]*goods-item/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'brand' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'score' }, content: { tag: 'p', cls: 'txt' }, author: { tag: 'span', cls: 'name' } } },
    qa: {
      cardOpen: /<div[^>]*class="[^"]*(qa|ask|question|answer)/i,
      fields: {
        q: { tag: 'div', cls: 'question' },
        a: { tag: 'div', cls: 'answer' },
        asker: { tag: 'span', cls: 'ask-user' },
      },
    },
  },
  xianyu: {
    name: '闲鱼',
    searchUrl: (q) => `https://www.goofish.com/search?q=${encodeURIComponent(q)}`,
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.goofish.com/item?id=${encodeURIComponent(itemIdOrUrl)}`),
    // mtop 签名直连（登录态必需；匿名触发 SM 滑块，无登录态返回空自动回退浏览器渲染）
    directApi: fetchXianyuProducts,
    product: { cardOpen: /<div[^>]*class="[^"]*item-card/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'user' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  dewu: {
    name: '得物',
    // 2026-10 实测（tools/probe-dewu-mobile.mjs / probe-dewu-round2.mjs）：
    //  · 得物没有网页商城——PC 与 H5（m.dewu.com）全部 302 到 www.dewu.com 品牌壳页 + App 下载墙
    //  · PC 商品接口 commodity-pick-interfaces/pc/feeds/info 存在但返回 code 485「请校验验证码」，
    //    随即触发 risk-stone-captcha 滑块验证码；仅分类 mapping 等非商品接口放行
    //  · 移动端 UA/视口会被 302 回首页，比桌面画像更早进下载墙
    // → 强制移动端画像（mobileOnly）是当前唯一可尝试的网页路线，仍大概率空手而归；
    //   可行数据源=得物开放平台官方合作接口 / App 抓包（app.dewu.com 签名接口）。
    mobileOnly: true,
    searchUrl: (q) => `https://www.dewu.com/search?keyword=${encodeURIComponent(q)}`,
    // H5 详情链接会 302 到 PC 壳页 product-detail.html（仍是 App 墙，仅供诊断用）
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.dewu.com/product-detail.html?spuId=${encodeURIComponent(itemIdOrUrl)}`),
    noProductHint:
      '得物没有网页商城（2026-10 实测）：PC 与 H5 均为品牌壳页 + App 下载墙，商品接口被 risk-stone 验证码风控拦截（code 485）。' +
      '可行路线：① 得物开放平台官方合作/开放接口；② App 抓包采集 app.dewu.com 签名接口（需自备抓包环境与签名逆向，超出本系统能力）。',
    product: { cardOpen: /<div[^>]*class="[^"]*product-card/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'brand' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  suning: {
    name: '苏宁易购',
    searchUrl: (q) => `https://search.suning.com/${encodeURIComponent(q)}/`,
    // 搜索直连：SSR 商品块精准解析（浏览器 DOM 启发式会把导航/广告链接全算进去，228 条噪声不可用）
    directApi: fetchSuningProducts,
    // 详情直连：详情页 SSR 含完整商品级数据（var sn）+ clusterMap 变体映射（SSR 无价格，价格由浏览器渲染路径补）
    detailApi: fetchSuningDetailSpuSku,
    detailSpuSku: (apiBodies) => ({ spu: null, skus: [], propGroups: [] }), // 直连已覆盖；浏览器捕获走通用深搜
    // 详情页标准结构 product.suning.com/<shopCode>/<partNum>.html；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://product.suning.com/0000000000/${encodeURIComponent(itemIdOrUrl)}.html`),
    // urlAccept：url 不是商品详情页的直接丢弃（浏览器回退时防止品牌筛选标签/广告横幅被误解析成商品——
    // 历史上产生过 item_0..item_227 垃圾行）；itemIdPattern：专有提取，防止店铺码被当成商品号
    product: { cardOpen: /<div[^>]*class="[^"]*product-card/i, urlAccept: /product\.suning\.com\/\d+\/\d+\.html/, itemIdPattern: /product\.suning\.com\/\d+\/(\d+)\.html/, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'div', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*review/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  // ---------- 2026-10-26 扩展（探测脚本 tools/probe-xhs-dy-tt-ks.mjs / probe-xhs-dy-round2.mjs） ----------
  // 四平台网页端均无「匿名可渲染商品数据」的公开入口，主路线 = 登录态 Cookie + 浏览器渲染 +
  // 响应捕获（generic.js API_HOST_RE 已收录各平台数据接口 host，登录后接口响应可深搜解析）。
  xiaohongshu: {
    name: '小红书',
    // 2026-10 实测：
    //  · 网页搜索页未登录 = 登录墙（小红书/微信扫码 + 手机号验证码），无匿名渲染
    //  · 商品详情 www.xiaohongshu.com/goods/<spuId> 桌面端被 302 到 App 扫码安全验证页；
    //    移动端画像落到 pages.xiaohongshu.com 壳页 + App 下载墙，详情接口
    //    mall.xiaohongshu.com/api/store/jpd/edith/detail/h5/toc 匿名返回 error_code 602
    // → 匿名无可行路线；登录态下搜索/详情接口由页面自身签名（x-s 等），走浏览器渲染 + 响应捕获
    searchUrl: (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_explore_feed`,
    // 详情页标准结构 www.xiaohongshu.com/goods/<spuId>；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.xiaohongshu.com/goods/${encodeURIComponent(itemIdOrUrl)}`),
    noProductHint:
      '小红书网页端必须登录态（2026-10 实测：未登录搜索页为登录墙，详情页被强制 App 扫码安全验证，详情接口匿名返回 error_code 602）。' +
      '请先在系统设置页提取/保存小红书 Cookie 后再采集；登录后接口响应会被捕获并自动解析。',
    product: { cardOpen: /<div[^>]*class="[^"]*(goods|product|note-item)/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  douyin: {
    name: '抖音商城',
    // 2026-10 实测：
    //  · 主站搜索 www.douyin.com/search 未登录 = 验证码中间页（8KB 壳，无数据接口）
    //  · 精选联盟 buyin.jinritemai.com 302 到电商官网 douyinec.com（商家/达人工作台需登录）
    //  · 抖店商品页 haohuo.jinritemai.com/views/product/item2?id=<goodsId> 未登录弹
    //    「页面已下线」React 离线弹窗，点击「继续访问」本应到基础展示页，headless 下不可靠
    // → 登录态（主站 Cookie）浏览器渲染 + 响应捕获（ec.snssdk.com / jinritemai.com 接口）为主路线
    searchUrl: (q) => `https://www.douyin.com/search/${encodeURIComponent(q)}?type=video`,
    // 抖店商品页标准结构 haohuo.jinritemai.com/views/product/item2?id=<goodsId>；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://haohuo.jinritemai.com/views/product/item2?id=${encodeURIComponent(itemIdOrUrl)}`),
    noProductHint:
      '抖音网页端必须登录态（2026-10 实测：主站搜索未登录为验证码中间页，抖店商品页未登录弹「页面已下线」离线弹窗）。' +
      '请先在系统设置页提取/保存抖音 Cookie（主站 douyin.com 登录）后再采集；登录后 ec.snssdk.com 等接口响应会被捕获并自动解析。',
    product: { cardOpen: /<div[^>]*class="[^"]*(goods|product)-?(item|card)/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  tiktok: {
    name: 'TikTok Shop',
    // 2026-10 实测：
    //  · shop.tiktok.com 所有入口（商城首页 / 商品页）均被 Security Check 滑块拦截
    //    （api-verification.tiktokshops.us 拖动拼图验证），数据中心 IP 直连无一放行
    // → 可行前提 = 海外住宅代理（CRAWL_PROXY）+ 登录态 Cookie，两者缺一基本空手而归；
    //   TikTok Shop 开放 API（partner.tiktokshop.com）是官方合规路线
    searchUrl: (q) => `https://shop.tiktok.com/search?q=${encodeURIComponent(q)}`,
    // 商品页标准结构 shop.tiktok.com/view/product/<productId>；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://shop.tiktok.com/view/product/${encodeURIComponent(itemIdOrUrl)}`),
    currency: 'USD',
    noProductHint:
      'TikTok Shop 网页端被 Security Check 滑块拦截（2026-10 实测：商城与商品页全部要求人机验证）。' +
      '可行路线：① 配置海外住宅代理（CRAWL_PROXY 环境变量或代理池）+ 登录态 Cookie；② TikTok Shop 官方开放 API（partner.tiktokshop.com）。',
    product: { cardOpen: /<div[^>]*class="[^"]*(product|goods|item)-?(card|item)/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*review/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
  kuaishou: {
    name: '快手',
    // 2026-10 实测：
    //  · 网页端无商城入口：kuaishou.com/shop 直接 404（跳全站 404 页）
    //  · 短视频页未登录 = 「登录查看更多作品」墙，商品卡/评论均需登录态
    //  · 页面数据走 www.kuaishou.com/graphql 接口（登录态下由页面自身请求）
    // → 登录态浏览器渲染 + graphql 响应捕获为主路线；App 抓包（gifshow 签名接口）超出本系统能力
    searchUrl: (q) => `https://www.kuaishou.com/search/video?searchKey=${encodeURIComponent(q)}`,
    // 快手无独立网页商品详情页（商品在短视频/直播间组件内）；itemId 兜底用短视频链接；传完整 URL 时直接用
    detailUrl: (itemIdOrUrl) => (/^https?:\/\//.test(itemIdOrUrl) ? itemIdOrUrl : `https://www.kuaishou.com/short-video/${encodeURIComponent(itemIdOrUrl)}`),
    noProductHint:
      '快手网页端无商城入口（2026-10 实测：kuaishou.com/shop 为 404，短视频页商品卡需登录态）。' +
      '请先在系统设置页提取/保存快手 Cookie，再通过短视频/直播页采集商品卡数据；graphql 接口响应会被捕获并自动解析。',
    product: { cardOpen: /<div[^>]*class="[^"]*(goods|item)-?(card|item)/i, fields: { title: { tag: 'div', cls: 'title' }, price: { tag: 'span', cls: 'price' }, shop: { tag: 'span', cls: 'shop' }, url: { tag: 'a', cls: 'link', attr: 'href' } } },
    review: { cardOpen: /<div[^>]*class="[^"]*comment/i, fields: { rating: { tag: 'span', cls: 'rating' }, content: { tag: 'p', cls: 'content' }, author: { tag: 'span', cls: 'author' } } },
  },
};
