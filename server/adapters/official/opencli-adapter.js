// OpenCLI 桥接适配器：复用用户本机 Chrome 的真实登录态采集电商数据。
// 原理：opencli CLI（@jackwener/opencli）+ Chrome 扩展（Browser Bridge）+ 本机 daemon(19825)，
//       命令在用户真实浏览器里执行，天然携带登录态与人机指纹，适配反爬最强的一批平台。
// 依赖：npm i -g @jackwener/opencli + Chrome 装扩展（opencli doctor 验证）。
// 位置：策略链 official → opencli → scrape。扩展未连接/未登录时命令快速失败，自动落到 scrape。
// 说明：opencli 输出 JSON 结构随版本演进，字段映射走「别名 + 深度找数组」的防御式归一化。
import { execFile } from 'node:child_process';
import { BaseAdapter } from '../base.js';

// 本系统平台 id → opencli 适配器命令（read 类）
export const OPENCLI_CMDS = {
  taobao: { search: ['taobao', 'search'], detail: ['taobao', 'detail'], reviews: ['taobao', 'reviews'] },
  jd: { search: ['jd', 'search'], detail: ['jd', 'item'], reviews: ['jd', 'reviews'] },
  xianyu: { search: ['xianyu', 'search'], detail: ['xianyu', 'item'] },
  amazon: { search: ['amazon', 'search'], detail: ['amazon', 'product'] },
};

const OPENCLI_TIMEOUT = 120000;

/** 执行 opencli 命令并解析 JSON 输出。失败抛错（策略链据此回退）。 */
export function runOpencli(args, { timeout = OPENCLI_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    execFile('opencli', [...args, '-f', 'json'], { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).slice(0, 200);
        return reject(new Error(`opencli ${args.join(' ')} 失败：${msg}`));
      }
      const out = String(stdout || '').trim();
      // 输出可能带非 JSON 前后缀日志：取第一个 { 或 [ 起尝试解析
      const starts = [out.indexOf('{'), out.indexOf('[')].filter((i) => i >= 0);
      if (!starts.length) return reject(new Error(`opencli 输出非 JSON：${out.slice(0, 120)}`));
      const cut = out.slice(Math.min(...starts));
      try {
        return resolve(JSON.parse(cut));
      } catch {
        // 可能尾部有日志：逐步截短到最后一个 }/] 再试
        const lastBrace = Math.max(cut.lastIndexOf('}'), cut.lastIndexOf(']'));
        if (lastBrace > 0) {
          try {
            return resolve(JSON.parse(cut.slice(0, lastBrace + 1)));
          } catch {}
        }
        return reject(new Error(`opencli JSON 解析失败：${out.slice(0, 160)}`));
      }
    });
  });
}

// ---------- 防御式字段归一化 ----------

const num = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const TITLE_KEYS = ['title', 'name', 'productName', 'product_name', 'goodName', 'itemTitle'];
const ID_KEYS = ['itemId', 'item_id', 'id', 'skuId', 'sku_id', 'sku', 'productId', 'product_id', 'goodsId', 'nid'];
const PRICE_KEYS = ['price', 'salePrice', 'sale_price', 'curPrice', 'minPrice', 'finalPrice', 'viewPrice', 'sellPrice'];
const SHOP_KEYS = ['shopName', 'shop_name', 'shop', 'seller', 'sellerName', 'storeName', 'shopTitle'];
const URL_KEYS = ['url', 'detailUrl', 'detail_url', 'itemUrl', 'item_url', 'link', 'href'];
const BRAND_KEYS = ['brand', 'brandName', 'brand_name'];
const CATEGORY_KEYS = ['category', 'categoryName', 'category_name', 'cateName'];
const SALES_KEYS = ['sales', 'salesCount', 'sales_count', 'sellCount', 'soldCount', 'deal'];

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

/** 深度找「像商品列表」的对象数组：含 title/id/price 类字段的元素 ≥1。 */
export function findRecordArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const hit = node.some((x) => pick(x, TITLE_KEYS) || pick(x, ID_KEYS));
      if (hit) return node;
    }
    for (const x of node) {
      const r = findRecordArray(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(node)) {
    const r = findRecordArray(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/** opencli 商品行 → 本系统 product 记录。 */
export function toProduct(x, platformId) {
  const price = num(pick(x, PRICE_KEYS)) ?? (typeof x.priceInfo === 'object' ? num(x.priceInfo?.price) : null);
  const itemId = pick(x, ID_KEYS);
  const url = pick(x, URL_KEYS) || (itemId && /^https?:/.test(String(itemId)) ? String(itemId) : '');
  return {
    platform: platformId,
    itemId: itemId && !/^https?:/.test(String(itemId)) ? String(itemId) : '',
    title: String(pick(x, TITLE_KEYS) || '').slice(0, 500) || '(无标题)',
    price,
    brand: pick(x, BRAND_KEYS) || '',
    category: pick(x, CATEGORY_KEYS) || '',
    shopName: pick(x, SHOP_KEYS) || '',
    sales: num(pick(x, SALES_KEYS)) || undefined,
    url: url && /^https?:/.test(String(url)) ? String(url) : '',
    images: Array.isArray(x.images) ? x.images.filter((u) => /^https?:/.test(String(u))).slice(0, 10) : [],
    specs: {},
    collectedAt: new Date().toISOString(),
  };
}

/** opencli 评价行 → 本系统 review 记录。 */
export function toReview(x, platformId, itemId) {
  const content = pick(x, ['content', 'text', 'comment', 'body', 'review']);
  if (!content) return null;
  return {
    platform: platformId,
    itemId: String(itemId || pick(x, ID_KEYS) || ''),
    rating: num(pick(x, ['rating', 'star', 'score', 'rate'])) || undefined,
    content: String(content).slice(0, 2000),
    author: pick(x, ['author', 'user', 'userName', 'nickName', 'nickname']) || '',
    time: pick(x, ['time', 'date', 'create_time', 'createdAt']) || '',
    collectedAt: new Date().toISOString(),
  };
}

export class OpenCliAdapter extends BaseAdapter {
  constructor({ platformId, name }) {
    super({ id: platformId, name: `${name}·OpenCLI`, strategy: 'opencli' });
    if (!OPENCLI_CMDS[platformId]) throw new Error(`OpenCLI 暂未支持平台：${platformId}`);
    this.cmds = OPENCLI_CMDS[platformId];
  }

  async collectProduct(query, opts = {}) {
    const limit = Math.min(Number(opts.limit) || 10, 40);
    const raw = await runOpencli([...this.cmds.search, String(query), '--limit', String(limit)]);
    const arr = findRecordArray(raw) || [];
    const rows = arr.map((x) => toProduct(x, this.id)).filter((r) => r.title !== '(无标题)');
    opts.log?.(`OpenCLI 搜索解析到 ${rows.length} 条商品（原始 ${arr.length} 行）`);
    return rows.slice(0, limit);
  }

  async collectReviews(itemId, opts = {}) {
    if (!this.cmds.reviews) return [];
    const raw = await runOpencli([...this.cmds.reviews, String(itemId), '--limit', '20']);
    const arr = findRecordArray(raw) || [];
    const rows = arr.map((x) => toReview(x, this.id, itemId)).filter(Boolean);
    opts.log?.(`OpenCLI 评论解析到 ${rows.length} 条`);
    return rows;
  }
}
