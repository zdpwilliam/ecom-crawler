// vmall 详情页数据接口探测
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  locale: 'zh-CN',
});
const page = await ctx.newPage();
page.on('request', (r) => {
  const u = r.url();
  if (!/openapi\.vmall|hicloud/.test(u) || /csrftoken|serverTime|batchReport/.test(u)) return;
  console.log(`REQ ${r.method()} ${u.slice(0, 160)}`);
  const pd = r.postData();
  if (pd) console.log('   POST:', pd.slice(0, 300));
});
page.on('response', async (r) => {
  const u = r.url();
  if (!/openapi\.vmall/.test(u) || /csrftoken|serverTime/.test(u)) return;
  try {
    const b = await r.text();
    console.log(`RESP ${r.status()} len=${b.length}: ${b.slice(0, 220).replace(/\s+/g, ' ')}`);
  } catch {}
});
try {
  await page.goto('https://www.vmall.com/product/10086751122921.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(10000);
  const nd = await page.evaluate(() => (window.__NEXT_DATA__ ? JSON.stringify(window.__NEXT_DATA__).slice(0, 400) : 'none'));
  console.log('__NEXT_DATA__:', nd);
  console.log('final url:', page.url());
} catch (e) {
  console.log('load fail:', e.message.slice(0, 100));
}
await browser.close();
