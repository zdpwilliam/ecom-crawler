// 平台适配器基类。
// 子类按需实现 collectProduct / collectReviews / collectQa。
// 所有采集动作必须先过 guard()（限流 + 爬取安全开关）。
import { waitForRateLimit, requireScraping, SITE_NOTES } from '../compliance.js';

export class BaseAdapter {
  /**
   * @param {{ id:string, name:string, strategy:string, supported?:string[], rpm?:number }} meta
   */
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.strategy = meta.strategy;
    this.supported = meta.supported || [];
    this.rpm = meta.rpm || 20;
  }

  /** 安全闸门：限流 + 爬取开关检查。 */
  async guard() {
    await waitForRateLimit(this.id, this.rpm);
    if (this.strategy === 'scrape') requireScraping();
  }

  async collectProduct(_query, _opts) {
    throw new Error(`${this.name} 未实现 collectProduct`);
  }
  async collectReviews(_itemId, _opts) {
    throw new Error(`${this.name} 未实现 collectReviews`);
  }
}
