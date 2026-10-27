// 淘宝开放平台(TOP) 官方 API 适配器
// 文档: https://open.taobao.com/doc.htm
//
// 凭证配置（三选一，页面配置优先）：
//   1. 系统设置页「淘宝开放平台（官方 API）」面板（存 data/settings.json，保存即生效）
//   2. 环境变量 TOP_APP_KEY / TOP_APP_SECRET / TOP_SESSION
//   3. 均未配置 → 采集时明确报错并自动回退到爬取策略
//
// 使用方式：采集工作台选择「淘宝/天猫」，策略 auto（默认）时官方 API 优先，
// 日志里会显示「尝试策略：official」；凭证缺失或调用失败自动回退 scrape。
//
// 权限现实（务必知晓）：TOP 的商品/评价接口均为「卖家自有数据」授权接口：
//   - taobao.item.get          查询单个商品详情（num_iid，需卖家授权 session）
//   - taobao.items.onsale.get  查询卖家在售商品列表（q 为过滤词，非全网搜索）
//   - taobao.traderates.get    查询卖家交易评价
// 全网商品搜索（搜索任意卖家的商品）需要申请专项权限，普通应用拿不到；
// 需要全网搜索时请使用爬取策略（工作台不勾官方或直接用 scrape）。
import crypto from 'node:crypto';
import { BaseAdapter } from '../base.ts';
import { DATA_TYPES } from '../../types.ts';
import { netThrottle } from '../scrape/config.ts';

const TOP_ENDPOINT = 'https://eco.taobao.com/router/rest';

const num = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const str = (v) => (v == null ? '' : String(v));

export class TaobaoTopAdapter extends BaseAdapter {
  appKey: string;
  appSecret: string;
  session: string;
  constructor() {
    super({
      id: 'taobao',
      name: '淘宝/天猫(开放平台)',
      strategy: 'official',
      supported: [DATA_TYPES.PRODUCT, DATA_TYPES.REVIEW],
      rpm: 20,
    });
    // 每次实例化都从环境变量读（settings.js applySettings 保存时同步写环境变量，即时生效）
    this.appKey = process.env.TOP_APP_KEY || '';
    this.appSecret = process.env.TOP_APP_SECRET || '';
    this.session = process.env.TOP_SESSION || '';
  }

  hasCreds() {
    return !!(this.appKey && this.appSecret);
  }

  requireCreds() {
    if (!this.hasCreds()) {
      throw new Error('淘宝官方 API 未配置凭证：请通过环境变量 TOP_APP_KEY / TOP_APP_SECRET（可选 TOP_SESSION）配置，或编辑 data/settings.json 的 topAppKey/topAppSecret/topSession 后重启服务；未配置时淘宝采集自动走爬取策略。');
    }
  }

  // TOP MD5 签名：secret + 排序后的 keyvalue + secret，再 MD5 大写
  sign(params) {
    const sorted = Object.keys(params).sort();
    let base = this.appSecret;
    for (const k of sorted) base += `${k}${params[k]}`;
    base += this.appSecret;
    return crypto.createHash('md5').update(base, 'utf8').digest('hex').toUpperCase();
  }

  // 统一调用入口：构造签名请求并真实外发（https，官方接口，无反爬对抗问题）
  async call(method, params = {}) {
    this.requireCreds();
    await this.guard();
    const req: any = {
      method,
      app_key: this.appKey,
      timestamp: new Date().toISOString().slice(0, 19).replace(/[-:]/g, ''),
      format: 'json',
      v: '2.0',
      sign_method: 'md5',
      ...params,
    };
    if (this.session) req.session = this.session;
    req.sign = this.sign(req);
    await netThrottle(() => {});
    const resp = await fetch(TOP_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(req),
      signal: AbortSignal.timeout(20000),
    });
    const j = await resp.json().catch(() => null);
    if (!j) throw new Error(`TOP 响应解析失败（HTTP ${resp.status}）`);
    // TOP 错误统一在 error_response 节点
    if (j.error_response) {
      const e = j.error_response;
      const sub = e.sub_msg ? `（${e.sub_code || ''} ${e.sub_msg}）` : '';
      throw new Error(`TOP 错误 ${e.code || ''} ${e.msg || ''}${sub}`.trim());
    }
    return j;
  }

  /**
   * 商品采集：
   *   - query 为纯数字（≥6位）→ taobao.item.get 查单个商品详情
   *   - 其他 → taobao.items.onsale.get 查卖家在售商品（q 为标题过滤词）
   */
  async collectProduct(query: string, opts: Record<string, any> = {}) {
    const limit = opts.limit || 20;
    let items = [];
    if (/^\d{6,}$/.test(String(query || '').trim())) {
      const j = await this.call('taobao.item.get', { num_iid: String(query).trim(), fields: 'num_iid,title,price,pic_url,detail_url,quantity,cid,seller_cids,brand,nick' });
      const item = j?.item_get_response?.item;
      if (!item) return [];
      items = [item];
    } else {
      const params: any = { page_no: 1, page_size: Math.min(limit, 200), fields: 'num_iid,title,price,pic_url,detail_url,quantity,cid,seller_cids,nick' };
      if (query) params.q = String(query).trim();
      const j = await this.call('taobao.items.onsale.get', params);
      items = j?.items_onsale_get_response?.items?.item || [];
      if (!Array.isArray(items)) items = [items];
    }
    const now = new Date().toISOString();
    return items.map((it) => ({
      id: `taobao-top-${it.num_iid}`,
      platform: 'taobao',
      itemId: String(it.num_iid),
      title: str(it.title),
      price: num(it.price),
      currency: 'CNY',
      brand: str(it.brand) || undefined,
      category: str(it.cid) || undefined,
      sales: 0,
      stock: num(it.quantity),
      url: str(it.detail_url) || `https://item.taobao.com/item.htm?id=${it.num_iid}`,
      images: it.pic_url ? [String(it.pic_url).replace(/^http:/, 'https:')] : [],
      shopName: str(it.nick) || undefined,
      source: 'official',
      collectedAt: now,
    }));
  }

  /** 评论采集：taobao.traderates.get（卖家交易评价，需授权 session） */
  async collectReviews(itemId: string, opts: Record<string, any> = {}) {
    const limit = opts.limit || 20;
    const j = await this.call('taobao.traderates.get', {
      num_iid: String(itemId),
      page_no: 1,
      page_size: Math.min(limit, 100),
      fields: 'tid,num_iid,content,created,nick,result,rate,item_title',
    });
    const rates = j?.traderates_get_response?.trade_rates?.trade_rate || [];
    const list = Array.isArray(rates) ? rates : [rates];
    const now = new Date().toISOString();
    // result: good/neutral/bad → 5/3/1 星
    const ratingMap = { good: 5, neutral: 3, bad: 1 };
    // 昵称打码：保留首尾字符
    const mask = (n) => {
      const s = str(n);
      if (!s) return '匿名';
      return s.length <= 2 ? s[0] + '*' : s[0] + '*'.repeat(Math.min(s.length - 2, 4)) + s.slice(-1);
    };
    return list.filter(Boolean).map((r, i) => ({
      id: `taobao-top-r-${r.tid || `${Date.now()}-${i}`}`,
      platform: 'taobao',
      itemId: String(r.num_iid || itemId),
      productTitle: str(r.item_title) || '',
      rating: ratingMap[r.result] || 0,
      content: str(r.content),
      authorMasked: mask(r.nick),
      tags: [],
      createdAt: str(r.created) || undefined,
      source: 'official',
      collectedAt: now,
    }));
  }
}
