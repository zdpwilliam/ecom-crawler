// 共享类型定义（JSDoc）与常量
// 纯数据契约，前后端/适配器共用，不依赖任何运行时库。

export const DATA_TYPES = Object.freeze({
  PRODUCT: 'product',
  REVIEW: 'review',
  QA: 'qa', // 商品详情页公开问答（问大家 / 买家问答），属公开信息
});

// 数据采集策略。优先级：official > scrape > mock。
export const STRATEGIES = Object.freeze({
  OFFICIAL: 'official', // 官方开放平台 API（合规优先）
  SCRAPE: 'scrape',     // 直接爬取回退（受合规闸门约束）
  MOCK: 'mock',         // 模拟数据（无凭证验证流程用）
});

/**
 * @typedef {Object} Product
 * @property {string} id
 * @property {string} platform
 * @property {string} [shopId]
 * @property {string} [shopName]
 * @property {string} itemId
 * @property {string} title
 * @property {number} price
 * @property {string} currency
 * @property {string} [category]
 * @property {string} [brand]
 * @property {number} [sales]
 * @property {number} [stock]
 * @property {string} [url]
 * @property {string[]} [images]
 * @property {Object} [specs]
 * @property {string} collectedAt
 */

/**
 * @typedef {Object} Review
 * @property {string} id
 * @property {string} platform
 * @property {string} itemId
 * @property {string} productTitle
 * @property {number} rating
 * @property {string} content
 * @property {string[]} [images]
 * @property {string} authorMasked
 * @property {string[]} [tags]
 * @property {string} [createdAt]
 * @property {string} collectedAt
 */

/**
 * @typedef {Object} QaItem 商品详情页公开问答（问大家 / 买家问答）
 * @property {string} id
 * @property {string} platform
 * @property {string} [platformName]
 * @property {string} itemId
 * @property {string} [productTitle]
 * @property {string} question
 * @property {string} answer
 * @property {string} [askerMasked]
 * @property {string} [answerMasked]
 * @property {string} [createdAt]
 * @property {string} collectedAt
 */

/**
 * @typedef {Object} CollectResult
 * @property {string} platform
 * @property {string} dataType
 * @property {string} strategy
 * @property {number} count
 * @property {string} status
 * @property {string} [message]
 */
