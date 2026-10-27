// 共享类型定义与常量
// 纯数据契约，前后端/适配器共用，不依赖任何运行时库。

export const DATA_TYPES = Object.freeze({
  PRODUCT: 'product',
  REVIEW: 'review',
  QA: 'qa', // 商品详情页公开问答（问大家 / 买家问答），属公开信息
} as const);

// 数据采集策略。优先级：official > scrape > mock。
export const STRATEGIES = Object.freeze({
  OFFICIAL: 'official', // 官方开放平台 API（合规优先）
  SCRAPE: 'scrape',     // 直接爬取回退（受合规闸门约束）
  MOCK: 'mock',         // 模拟数据（无凭证验证流程用）
} as const);

export type DataType = 'product' | 'review' | 'qa';

/** 商品记录（采集与入库的标准形状；各平台适配器负责归一化到此处）。 */
export interface Product {
  id: string;
  platform: string;
  shopId?: string;
  shopName?: string;
  itemId: string;
  title: string;
  price: number;
  currency: string;
  category?: string;
  brand?: string;
  sales?: number;
  stock?: number;
  url?: string;
  images?: string[];
  specs?: Record<string, unknown>;
  collectedAt: string;
}

/** 商品评价记录。 */
export interface Review {
  id: string;
  platform: string;
  itemId: string;
  productTitle?: string;
  rating: number;
  content: string;
  images?: string[];
  authorMasked?: string;
  tags?: string[];
  createdAt?: string;
  collectedAt: string;
}

/** 商品详情页公开问答（问大家 / 买家问答）。 */
export interface QaItem {
  id: string;
  platform: string;
  platformName?: string;
  itemId: string;
  productTitle?: string;
  question: string;
  answer: string;
  askerMasked?: string;
  answerMasked?: string;
  createdAt?: string;
  collectedAt: string;
}

/** 一次采集动作的结果汇总。 */
export interface CollectResult {
  platform: string;
  dataType: DataType | string;
  strategy: string;
  count: number;
  status: string;
  message?: string;
}

/** 采集调用参数（工作台 / 定时任务 / 一键测试共用）。 */
export interface CollectParams {
  query?: string;
  itemId?: string;
  limit?: number;
  withDetails?: boolean;
  [k: string]: unknown;
}

/** 规格参数（SPU/SKU 详情扩展）。 */
export interface SpecTable {
  spu?: Record<string, unknown> | null;
  skus?: Array<Record<string, unknown>>;
  props?: Array<{ name: string; value: string }>;
  description?: string;
  images?: string[];
}
