// 一键测试（采集前体检）：按当前工作台配置（平台/数据类型/查询词）发真实请求，
// product 类型走「列表 → 详情 → 评价 → 问答」全链路；review/qa 只测对应单步。
// 每步返回：最终请求链接 / 运行状态说明 / 响应内容预览 / 提取后的结构化数据。
// 测试数据不落库（直接调适配器，不走 collectors 入库）。
import { getScrapeAdapter } from './adapters/registry.js';
import { SCRAPE_CONFIG } from './adapters/scrape/config.js';

const PREVIEW_MAX = 2600; // 单步返回内容预览上限（字符）

function preview(obj, take = 2) {
  let text;
  if (Array.isArray(obj)) text = JSON.stringify(obj.slice(0, take), null, 1);
  else text = JSON.stringify(obj, null, 1);
  if (text.length > PREVIEW_MAX) text = text.slice(0, PREVIEW_MAX) + `\n…（已截断）`;
  return text;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function summarizeProduct(p) {
  return {
    title: p.title, itemId: p.itemId, price: p.price, brand: p.brand,
    shopName: p.shopName, category: p.category, sales: p.sales, url: p.url,
  };
}

/** 列表页链接：优先平台配置的 searchUrl；仅当 query 不是 URL 时构造。 */
function listUrl(cfg, query) {
  if (/^https?:\/\//.test(query)) return query;
  if (cfg.searchUrl) {
    try { return cfg.searchUrl(query); } catch { return ''; }
  }
  return '';
}

/** 详情/评价/问答页链接：itemId → 平台 detailUrl 构造；完整 URL 直接用。 */
function detailPageUrl(cfg, target) {
  if (!target) return '';
  if (/^https?:\/\//.test(target)) return target;
  if (cfg.detailUrl) {
    try { return cfg.detailUrl(target); } catch { return ''; }
  }
  return '';
}

/**
 * 运行一键测试。
 * @param {{platform:string, dataType?:string, query?:string, itemId?:string}} opts
 * @returns {Promise<{platform:string, dataType:string, steps:Array, target:string}>}
 * step: { key, label, ok, ms, count, url, detail, responseText, dataText }
 */
export async function runTest({ platform, dataType = 'product', query = '手机', itemId = '' }) {
  const adapter = getScrapeAdapter(platform);
  if (!adapter) throw new Error(`未知平台：${platform}`);
  const cfg = SCRAPE_CONFIG[platform] || {};
  const steps = [];

  const step = (key, label) => {
    const s = { key, label, ok: false, ms: 0, count: 0, url: '', detail: '', responseText: '', dataText: '' };
    steps.push(s);
    return s;
  };

  // ===== review / qa：单步测试 =====
  if (dataType === 'review' || dataType === 'qa') {
    const s = step(dataType, dataType === 'review' ? '商品评价' : '问答（问大家）');
    const target = (itemId && String(itemId).trim()) || query;
    s.url = detailPageUrl(cfg, target) || String(target).slice(0, 120);
    if (!target) {
      s.detail = '跳过：未填写商品链接或 ItemId';
      return { platform, dataType, target: '', steps };
    }
    const t0 = Date.now();
    try {
      const rows = await withTimeout(
        dataType === 'review' ? adapter.collectReviews(target, {}) : adapter.collectQa(target, {}),
        120000,
        dataType === 'review' ? '评价请求' : '问答请求'
      );
      s.ok = rows.length > 0;
      s.ms = Date.now() - t0;
      s.count = rows.length;
      s.detail = rows.length ? `解析到 ${rows.length} 条${dataType === 'review' ? '评价' : '问答'}` : '页面无公开数据或选择器未命中';
      s.responseText = rows.length ? preview(rows.slice(0, 2)) : '';
      s.dataText = rows.length ? preview(rows.map((r) => (
        dataType === 'review'
          ? { rating: r.rating, content: r.content, author: r.author || r.authorMasked, itemId: r.itemId }
          : { question: r.question, answer: r.answer, asker: r.asker || r.askerMasked, itemId: r.itemId }
      )), 3) : '';
    } catch (e) {
      s.ms = Date.now() - t0;
      s.detail = String(e.message || e).slice(0, 400);
    }
    return { platform, dataType, target, steps };
  }

  // ===== product：列表 → 详情 → 评价 → 问答 =====

  // ① 商品列表（搜索页渲染 / 直连接口，取 3 条足够判断通道可用性）
  let products = [];
  const s1 = step('list', '商品列表（搜索/直连接口）');
  s1.url = listUrl(cfg, query) || String(query).slice(0, 120);
  {
    const t0 = Date.now();
    try {
      const raw = await withTimeout(adapter.collectProduct(query, { limit: 3 }), 120000, '列表请求');
      products = Array.isArray(raw) ? raw : raw.products || [];
      s1.ok = products.length > 0;
      s1.ms = Date.now() - t0;
      s1.count = products.length;
      s1.detail = products.length
        ? `解析到 ${products.length} 条商品${Array.isArray(raw) ? '' : raw.reviews?.length ? `，附带评论 ${raw.reviews.length} 条` : ''}`
        : '返回 0 条（可能需登录态或被风控）';
      s1.responseText = products.length ? preview(products.map(summarizeProduct), 3) : '';
      s1.dataText = s1.responseText;
    } catch (e) {
      s1.ms = Date.now() - t0;
      s1.detail = String(e.message || e).slice(0, 400);
    }
  }

  // 详情目标：优先手动填的 itemId，其次列表第一条
  const target = (itemId && String(itemId).trim()) || (products[0] ? products[0].itemId || products[0].url || '' : '');
  const targetUrl = products[0]?.url && /^https?:\/\//.test(products[0].url) ? products[0].url : detailPageUrl(cfg, target) || target;

  // ② 商品详情（直连详情接口 / 详情页 SSR，SPU/SKU）
  let detailData = null;
  const s2 = step('detail', '商品详情（SPU/SKU）');
  s2.url = String(targetUrl || '').slice(0, 160);
  {
    const t0 = Date.now();
    if (!targetUrl) {
      s2.detail = '跳过：无可用商品目标（列表未返回数据，也未手动填写 ItemId）';
    } else {
      try {
        const d = await withTimeout(adapter.collectDetail(targetUrl, {}), 120000, '详情请求');
        detailData = d;
        const skuCount = (d.skus || []).length;
        s2.ok = !!(d.spu || skuCount || (d.reviews || []).length || (d.qa || []).length);
        s2.ms = Date.now() - t0;
        s2.count = skuCount;
        s2.detail =
          `SPU：${d.spu ? '✓ ' + String(d.spu.title || d.spu.brandName || '').slice(0, 30) : '✗'} ｜ SKU/规格：${skuCount} 条` +
          ` ｜ 评论：${(d.reviews || []).length} 条 ｜ 问答：${(d.qa || []).length} 条`;
        s2.responseText = preview({ spu: d.spu, skus: (d.skus || []).slice(0, 5) }, 1);
        s2.dataText = d.spu || skuCount
          ? preview({ spu: d.spu, skuCount, 回填字段: { brand: d.spu?.brandName || d.spu?.brand, category: d.spu?.categoryName || d.spu?.category, price: d.spu?.price } }, 1)
          : '';
      } catch (e) {
        s2.ms = Date.now() - t0;
        s2.detail = String(e.message || e).slice(0, 400);
      }
    }
  }

  // ③ 评价
  {
    const s = step('review', '商品评价');
    s.url = String(targetUrl || '').slice(0, 160);
    const t0 = Date.now();
    if (!target) {
      s.detail = '跳过：无可用商品目标';
    } else if (detailData && (detailData.reviews || []).length) {
      s.ok = true; s.ms = Date.now() - t0; s.count = detailData.reviews.length;
      s.detail = `详情步已带出 ${s.count} 条评价（同一次页面加载，未重复请求）`;
      s.dataText = preview(detailData.reviews.map((r) => ({ rating: r.rating, content: r.content, author: r.author || r.authorMasked })), 2);
    } else {
      try {
        const rows = await withTimeout(adapter.collectReviews(target, {}), 120000, '评价请求');
        s.ok = rows.length > 0;
        s.ms = Date.now() - t0;
        s.count = rows.length;
        s.detail = rows.length ? `解析到 ${rows.length} 条评价` : '页面无公开评论或选择器未命中';
        s.responseText = rows.length ? preview(rows.slice(0, 2)) : '';
        s.dataText = rows.length ? preview(rows.map((r) => ({ rating: r.rating, content: r.content, author: r.author || r.authorMasked })), 2) : '';
      } catch (e) {
        s.ms = Date.now() - t0;
        s.detail = String(e.message || e).slice(0, 400);
      }
    }
  }

  // ④ 问答（问大家等公开问答区）
  {
    const s = step('qa', '问答（问大家）');
    s.url = String(targetUrl || '').slice(0, 160);
    const t0 = Date.now();
    if (!target) {
      s.detail = '跳过：无可用商品目标';
    } else if (!cfg.qa) {
      s.detail = '该平台暂未配置问答选择器';
    } else if (detailData && (detailData.qa || []).length) {
      s.ok = true; s.ms = Date.now() - t0; s.count = detailData.qa.length;
      s.detail = `详情步已带出 ${s.count} 条问答（同一次页面加载，未重复请求）`;
      s.dataText = preview(detailData.qa.map((r) => ({ q: r.question, a: r.answer })), 2);
    } else {
      try {
        const rows = await withTimeout(adapter.collectQa(target, {}), 120000, '问答请求');
        s.ok = rows.length > 0;
        s.ms = Date.now() - t0;
        s.count = rows.length;
        s.detail = rows.length ? `解析到 ${rows.length} 条问答` : '页面无公开问答或选择器未命中';
        s.responseText = rows.length ? preview(rows.slice(0, 2)) : '';
        s.dataText = rows.length ? preview(rows.map((r) => ({ q: r.question, a: r.answer })), 2) : '';
      } catch (e) {
        s.ms = Date.now() - t0;
        s.detail = String(e.message || e).slice(0, 400);
      }
    }
  }

  return { platform, dataType, query, target: targetUrl || target, steps };
}
