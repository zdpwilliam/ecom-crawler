// 安全护栏：限流（保护你的 IP 不被平台秒封）+ 隐私脱敏（仅用于你自有/已授权数据）
// 说明：爬取默认开启，无需任何环境变量。ALLOW_SCRAPING 仅作「显式关闭」口子。
//       限流是为了让你爬得更久不被封，不是合规审查。

const DEFAULT_RPM = 20; // 每平台每分钟默认请求上限（可用 CRAWL_RPM 调高）
const limiters = new Map(); // platform -> { tokens, last }

/**
 * 令牌桶限流。返回 true 表示本次放行。
 * @param {string} platform
 * @param {number} [rpm]
 */
export function rateLimit(platform, rpm = DEFAULT_RPM) {
  const eff = Number(process.env.CRAWL_RPM) || rpm; // 可用 CRAWL_RPM 全局覆盖
  const now = Date.now();
  let lim = limiters.get(platform);
  if (!lim) {
    lim = { tokens: eff, last: now };
    limiters.set(platform, lim);
  }
  const dt = (now - lim.last) / 60000;
  lim.tokens = Math.min(eff, lim.tokens + dt * eff);
  lim.last = now;
  if (lim.tokens >= 1) {
    lim.tokens -= 1;
    return true;
  }
  return false;
}

/** 自旋等待直到拿到令牌（低频 CLI/服务端够用）。 */
export function waitForRateLimit(platform, rpm = DEFAULT_RPM) {
  return new Promise((resolve) => {
    const tryOnce = () => {
      if (rateLimit(platform, rpm)) return resolve(true);
      setTimeout(tryOnce, 1000);
    };
    tryOnce();
  });
}

// 爬取开关：默认开启（无需任何环境变量即可爬）。仅当显式 ALLOW_SCRAPING=false 时才关闭。
// 这不是合规审查，只是给不想爬的人一个关闭口子。
export function scrapingAllowed() {
  return process.env.ALLOW_SCRAPING !== 'false';
}
export function requireScraping() {
  if (!scrapingAllowed()) {
    throw new Error('爬取已通过 ALLOW_SCRAPING=false 显式关闭。');
  }
}

// 命中即脱敏的敏感信息模式（最小化，仅用于你自有/已授权数据）
const PII_PATTERNS = [
  { type: 'phone', re: /(?:\+?86)?1[3-9]\d{9}/g },
  { type: 'email', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { type: 'idcard', re: /\b\d{17}[\dXx]\b/g },
  { type: 'bankcard', re: /\b\d{16,19}\b/g },
  { type: 'address', re: /[省市区县][^，。\s]{2,20}(?:路|街|号|栋|单元|室)/g },
];

/**
 * 对文本做最小化 PII 脱敏。
 * @param {string} text
 * @returns {{ redacted: string, findings: string[] }}
 */
export function redactPii(text) {
  if (!text) return { redacted: text || '', findings: [] };
  let out = text;
  const findings = [];
  for (const { type, re } of PII_PATTERNS) {
    const matches = out.match(re);
    if (matches && matches.length) {
      findings.push(`${type}×${matches.length}`);
      out = out.replace(re, (m) => '█'.repeat(Math.min(m.length, 6)));
    }
  }
  return { redacted: out, findings };
}

// 各平台站点备注（仅作信息提示，不影响功能）
export const SITE_NOTES = {
  taobao: '淘宝/天猫：官方数据接口为淘宝开放平台(TOP)。',
  jd: '京东：官方数据接口为京东宙斯开放平台。',
  pdd: '拼多多：官方数据接口为拼多多开放平台。',
  amazon: '亚马逊：官方数据接口为 SP-API / PA-API。',
  vip: '唯品会：官方数据接口为唯品会开放平台。',
  xianyu: '闲鱼：个人闲置交易，无开放 API。',
  dewu: '得物：以官方合作/开放接口优先。',
  suning: '苏宁易购：官方数据接口为苏宁开放平台。',
};
