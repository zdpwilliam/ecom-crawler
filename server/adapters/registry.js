// 平台注册表 —— 可扩展性的核心。
// 新增平台 = 在 PLATFORMS 追加一项 + 提供对应 official/scrape 适配器类。
import { BaseAdapter } from './base.js';
import { MockAdapter } from './mock.js';
import { TaobaoTopAdapter } from './official/taobao-top.js';
import { OpenCliAdapter, OPENCLI_CMDS } from './official/opencli-adapter.js';
import { GenericScrapeAdapter } from './scrape/generic.js';
import { DATA_TYPES } from '../types.js';

export const PLATFORMS = [
  { id: 'taobao',  name: '淘宝/天猫', official: TaobaoTopAdapter, scrape: GenericScrapeAdapter },
  { id: 'jd',      name: '京东',       official: null,            scrape: GenericScrapeAdapter },
  { id: 'pdd',     name: '拼多多',     official: null,            scrape: GenericScrapeAdapter },
  { id: 'amazon',  name: '亚马逊',     official: null,            scrape: GenericScrapeAdapter },
  { id: 'vip',     name: '唯品会',     official: null,            scrape: GenericScrapeAdapter },
  { id: 'xianyu',  name: '闲鱼',       official: null,            scrape: GenericScrapeAdapter },
  { id: 'dewu',    name: '得物',       official: null,            scrape: GenericScrapeAdapter },
  { id: 'suning',  name: '苏宁易购',   official: null,            scrape: GenericScrapeAdapter },
  { id: 'huawei',  name: '华为商城',   official: null,            scrape: GenericScrapeAdapter },
  // 2026-10-26 扩展：小红书/抖音/TikTok/快手（网页端均无匿名公开数据，主路线=登录态 Cookie + 浏览器渲染）
  { id: 'xiaohongshu', name: '小红书',      official: null, scrape: GenericScrapeAdapter },
  { id: 'douyin',      name: '抖音商城',    official: null, scrape: GenericScrapeAdapter },
  { id: 'tiktok',      name: 'TikTok Shop', official: null, scrape: GenericScrapeAdapter },
  { id: 'kuaishou',    name: '快手',        official: null, scrape: GenericScrapeAdapter },
];

const byId = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

export function listPlatforms() {
  return PLATFORMS.map((p) => ({
    id: p.id,
    name: p.name,
    hasOfficial: !!p.official,
    hasScrape: !!p.scrape,
  }));
}

export function getOfficialAdapter(platformId) {
  const p = byId[platformId];
  if (!p || !p.official) return null;
  return new p.official();
}

export function getScrapeAdapter(platformId) {
  const p = byId[platformId];
  if (!p || !p.scrape) return null;
  return new p.scrape({ platformId, name: p.name });
}

/**
 * 取得某平台某数据类型的「主 + 备」适配器序列：
 * 官方 API 优先 → OpenCLI 桥接（复用本机 Chrome 登录态，2026-10-27 接入）→ 爬取（受合规闸门限制）。
 */
export function resolveAdapters(platformId, dataType) {
  const p = byId[platformId];
  if (!p) throw new Error(`未知平台: ${platformId}`);
  if (dataType === DATA_TYPES.CHAT) throw new Error('聊天功能已移除');
  const seq = [];
  if (p.official) seq.push({ strategy: 'official', factory: () => new p.official() });
  if (OPENCLI_CMDS[platformId]) seq.push({ strategy: 'opencli', factory: () => new OpenCliAdapter({ platformId, name: p.name }) });
  if (p.scrape) seq.push({ strategy: 'scrape', factory: () => new p.scrape({ platformId, name: p.name }) });
  return seq;
}

export { MockAdapter, BaseAdapter };
