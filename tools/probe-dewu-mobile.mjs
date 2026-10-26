// 得物「Playwright + 移动端 UA/视口」路线探测实验
// 对照组：桌面档案（当前默认路径）vs 移动端档案（iPhone UA + 390×844 + isMobile/hasTouch）
// 输出：页面标题/大小/商品信号/接口捕获，判断移动端画像是否能渲染出商品列表
import { chromium } from 'playwright';

const SEARCH = 'https://www.dewu.com/search?keyword=' + encodeURIComponent('跑步鞋');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const API_HOST_RE = /dewu\.com|duhui\.com|api/i;

async function probe(label, ctxOpts) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ locale: 'zh-CN', ...ctxOpts });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  const apis = [];
  page.on('response', (r) => {
    try {
      if (API_HOST_RE.test(r.url()) && /json/i.test(r.headers()['content-type'] || '')) {
        apis.push({ s: r.status(), u: r.url().slice(0, 110) });
      }
    } catch {}
  });
  let finalUrl = '', status = 0;
  try {
    const resp = await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp ? resp.status() : 0;
  } catch (e) {
    console.log(`[${label}] goto 失败: ${e.message.slice(0, 120)}`);
  }
  // 等待渲染 + 滚动触发懒加载
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}); } catch {}
  await page.waitForTimeout(5000);
  try {
    await page.evaluate(async () => {
      let y = 0;
      const step = () => { window.scrollBy(0, 700); y += 700; if (y < 5000) setTimeout(step, 150); };
      step();
    });
  } catch {}
  await page.waitForTimeout(4000);
  try { finalUrl = page.url(); } catch {}
  const info = await page.evaluate(() => ({
    title: document.title.slice(0, 60),
    bodyLen: document.body ? document.body.innerText.length : 0,
    imgs: document.images.length,
    priceSignals: (document.body.innerText.match(/[¥￥]\s?\d[\d,.]*/g) || []).length,
    links: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /\/(product|detail|goods)/i.test(h)).length,
    bodyHead: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 180) : '',
  })).catch((e) => ({ evalErr: e.message.slice(0, 80) }));
  const htmlLen = (await page.content().catch(() => '')).length;
  console.log(`\n===== [${label}] =====`);
  console.log(`HTTP ${status} → ${finalUrl.slice(0, 90)}`);
  console.log(`标题: ${info.title || '-'} ｜ 正文 ${info.bodyLen} 字 ｜ HTML ${(htmlLen / 1024).toFixed(0)}KB ｜ 图片 ${info.imgs}`);
  console.log(`价格信号: ${info.priceSignals} ｜ 商品链接: ${info.links}`);
  console.log(`正文开头: ${info.bodyHead || info.evalErr || '-'}`);
  console.log(`JSON 接口捕获 ${apis.length} 条（前 6）:`);
  for (const a of apis.slice(0, 6)) console.log(`  ${a.s} ${a.u}`);
  await browser.close();
  return { label, info, apis, status };
}

const desktop = await probe('桌面档案', {
  userAgent: DESKTOP_UA,
  viewport: { width: 1440, height: 900 },
});
const mobile = await probe('移动端档案', {
  userAgent: MOBILE_UA,
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

console.log('\n===== 结论对照 =====');
for (const r of [desktop, mobile]) {
  console.log(`${r.label}: HTTP ${r.status} ｜ 价格信号 ${r.info.priceSignals} ｜ 商品链接 ${r.info.links} ｜ 接口 ${r.apis.length}`);
}
