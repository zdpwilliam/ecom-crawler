// 平台适配器基类。
// 子类按需实现 collectProduct / collectReviews / collectQa。
// 所有采集动作必须先过 guard()（限流 + 爬取安全开关）。
import { waitForRateLimit, requireScraping } from '../compliance.ts';
import type { Product, Review, QaItem } from '../types.ts';

/** 适配器元信息（注册表传入）。 */
export interface AdapterMeta {
  id: string;
  name: string;
  strategy: string;
  supported?: string[];
  rpm?: number;
}

/** 采集调用可选参数。 */
export interface CollectOpts {
  limit?: number;
  log?: (m?: string) => void;
  [k: string]: unknown;
}

export class BaseAdapter {
  id: string;
  name: string;
  strategy: string;
  supported: string[];
  rpm: number;

  constructor(meta: AdapterMeta) {
    this.id = meta.id;
    this.name = meta.name;
    this.strategy = meta.strategy;
    this.supported = meta.supported || [];
    this.rpm = meta.rpm || 20;
  }

  /** 安全闸门：限流 + 爬取开关检查。 */
  async guard(): Promise<void> {
    await waitForRateLimit(this.id, this.rpm);
    if (this.strategy === 'scrape') requireScraping();
  }

  async collectProduct(_query: string, _opts: CollectOpts = {}): Promise<any> {
    throw new Error(`${this.name} 未实现 collectProduct`);
  }

  async collectReviews(_itemId: string, _opts: CollectOpts = {}): Promise<any> {
    throw new Error(`${this.name} 未实现 collectReviews`);
  }

  async collectQa(_itemId: string, _opts: CollectOpts = {}): Promise<any> {
    throw new Error(`${this.name} 未实现 collectQa`);
  }
}
