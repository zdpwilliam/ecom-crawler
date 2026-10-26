// Mock 适配层：无 API 凭证时即可端到端跑通整个采集→清洗→展示流程。
// 真实部署时由 official / scrape 适配器替换，或作为 fallback 的 fallback。
import { BaseAdapter } from './base.js';
import { DATA_TYPES } from '../types.js';

const BRANDS = ['Aurora', 'NorthWind', '云栖', '青柠', '匠造', 'Lumio', '禾本科', 'Kairo'];
const CATEGORIES = ['手机数码', '家用电器', '服饰鞋包', '美妆个护', '食品生鲜', '运动户外', '家居日用', '图书文娱'];
const ADJ = ['轻奢', '极简', '经典', '便携', '大容量', '高弹', '无线', '智能', '复古', '基础'];
const NOUN = ['双肩包', '保温杯', '蓝牙耳机', '运动鞋', '面霜', '枕芯', '马克杯', '机械键盘', '行李箱', 'T恤'];
const REVIEW_TEXTS = [
  '东西不错，物流很快，包装严实。',
  '用了几天，手感很好，推荐购买。',
  '和描述一致，性价比高。',
  '一般般，没有想象中好。',
  '客服态度好，退换方便。',
];

// 字符串种子伪随机（同输入可复现，便于调试）
function rng(seed) {
  let s = 0;
  for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

export class MockAdapter extends BaseAdapter {
  constructor(meta = {}) {
    super({
      id: meta.id || 'mock',
      name: meta.name || '模拟数据',
      strategy: 'mock',
      supported: [DATA_TYPES.PRODUCT, DATA_TYPES.REVIEW, DATA_TYPES.QA],
      rpm: 200,
    });
  }

  async collectProduct(query = '手机', opts = {}) {
    await this.guard();
    const n = opts.limit || 12;
    const r = rng(this.id + query);
    const out = [];
    for (let i = 0; i < n; i++) {
      const brand = pick(r, BRANDS);
      out.push({
        id: `${this.id}-p-${Date.now()}-${i}`,
        platform: this.id,
        itemId: `item_${Math.floor(r() * 1e9)}`,
        shopName: `${brand}官方旗舰店`,
        title: `${brand} ${pick(r, ADJ)}${pick(r, NOUN)} ${2024 + (i % 3)}`,
        price: Math.round((r() * 900 + 10) * 100) / 100,
        currency: 'CNY',
        category: pick(r, CATEGORIES),
        brand,
        sales: Math.floor(r() * 50000),
        stock: Math.floor(r() * 1000),
        url: `https://example.com/${this.id}/item/${i}`,
        images: [],
        specs: { 颜色: pick(r, ['黑', '白', '蓝', '绿']), 规格: pick(r, ['标准', 'Pro', 'Max']) },
        collectedAt: new Date().toISOString(),
      });
    }
    return out;
  }

  async collectReviews(itemId, opts = {}) {
    await this.guard();
    const n = opts.limit || 8;
    const r = rng(this.id + itemId + 'rev');
    const out = [];
    for (let i = 0; i < n; i++) {
      const rating = 1 + Math.floor(r() * 5);
      out.push({
        id: `${this.id}-r-${Date.now()}-${i}`,
        platform: this.id,
        itemId,
        productTitle: `商品 ${itemId}`,
        rating,
        content: pick(r, REVIEW_TEXTS),
        authorMasked: `买***${Math.floor(r() * 99)}`,
        tags: rating >= 4 ? ['好评', '推荐'] : ['一般'],
        createdAt: new Date(Date.now() - Math.floor(r() * 30) * 86400000).toISOString(),
        collectedAt: new Date().toISOString(),
      });
    }
    return out;
  }
}
