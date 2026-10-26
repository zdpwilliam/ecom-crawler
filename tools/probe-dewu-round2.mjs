// 得物探测第二轮：① 抓 feeds/info 400 的请求参数 ② 看 category-pick/mapping 内容
// ③ 试 m.dewu.com H5 路线 ④ 试带 sign 头直接调 h5 商品接口
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  viewport: { width: 1440, height: 900 },
  locale: 'zh-CN',
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) window.chrome = { runtime: {} };
});
const page = await ctx.newPage();
const caps = [];
page.on('response', async (r) => {
  try {
    if (/app\.dewu\.com\/api/.test(r.url())) {
      const req = r.request();
      let reqBody = null;
      try { reqBody = req.postData(); } catch {}
      let respBody = '';
      try { respBody = (await r.text()).slice(0, 1500); } catch {}
      caps.push({ s: r.status(), u: r.url(), method: req.method(), reqBody: reqBody ? reqBody.slice(0, 600) : null, respBody });
    }
  } catch {}
});

await page.goto('https://www.dewu.com/search?keyword=' + encodeURIComponent('跑步鞋'), { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
await page.waitForTimeout(9000);

console.log('===== app.dewu.com 接口捕获 =====');
for (const c of caps) {
  console.log(`\n[${c.s}] ${c.method} ${c.u}`);
  if (c.reqBody) console.log('  请求体:', c.reqBody.slice(0, 400));
  if (c.respBody) console.log('  响应体:', c.respBody.slice(0, 500).replace(/\s+/g, ' '));
}

// 检查页面里有没有搜索框（PC 壳可能只是没渲染结果，但搜索交互存在）
const ui = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('input')].map((i) => i.placeholder || i.name).filter(Boolean);
  return { inputs, hasSearch: inputs.length > 0 };
}).catch(() => ({}));
console.log('\n输入框:', JSON.stringify(ui));

// m.dewu.com 探测
console.log('\n===== m.dewu.com H5 探测 =====');
for (const u of ['https://m.dewu.com/', 'https://m.dewu.com/router/product/ProductDetail?spuId=123456']) {
  try {
    const p2 = await ctx.newPage();
    const resp = await p2.goto(u, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p2.waitForTimeout(3000);
    const t = await p2.evaluate(() => ({ title: document.title.slice(0, 50), len: document.body.innerText.length, head: document.body.innerText.replace(/\s+/g, ' ').slice(0, 120) }));
    console.log(`[${resp.status()}] ${u} → ${p2.url().slice(0, 80)} ｜ ${t.title} ｜ 正文 ${t.len} ｜ ${t.head}`);
    await p2.close();
  } catch (e) {
    console.log(`${u} 失败: ${e.message.slice(0, 100)}`);
  }
}
await browser.close();
