// 第二轮探测：小红书商品详情（移动端画像 + toc 接口响应体）+ 抖音「继续访问」基础展示页
import { chromium } from 'playwright';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function dump(label, { status, finalUrl, info, apis, bodyHeads }) {
  console.log(`\n===== [${label}] =====`);
  console.log(`HTTP ${status} → ${finalUrl.slice(0, 100)}`);
  console.log(`标题: ${info.title || '-'} ｜ 正文 ${info.bodyLen} 字 ｜ 价格信号 ${info.priceSignals} ｜ 登录墙 ${info.loginWall ? '是' : '否'} ｜ 验证码 ${info.captcha ? '是' : '否'}`);
  console.log(`正文开头: ${info.bodyHead || '-'}`);
  console.log(`JSON 接口捕获 ${apis.length} 条:`);
  for (const a of apis.slice(0, 10)) console.log(`  ${a.s} ${a.u}`);
  for (const [u, h] of bodyHeads) console.log(`  ↳ 响应体[${u.slice(0, 80)}]: ${h}`);
}

// ---------- 小红书详情 ----------
{
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  for (const mode of ['mobile', 'desktop']) {
    const ctx = await browser.newContext(mode === 'mobile'
      ? { locale: 'zh-CN', userAgent: MOBILE_UA, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
      : { locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      if (!window.chrome) window.chrome = { runtime: {} };
    });
    const page = await ctx.newPage();
    const apis = []; const bodyHeads = [];
    page.on('response', (r) => {
      try {
        const u = r.url();
        if (/xiaohongshu/i.test(u) && /json/i.test(r.headers()['content-type'] || '')) {
          apis.push({ s: r.status(), u: u.slice(0, 120) });
          if (/edith\/detail|mall|goods|jpd/i.test(u)) {
            r.text().then((t) => bodyHeads.push([u, t.slice(0, 500)])).catch(() => {});
          }
        }
      } catch {}
    });
    let status = 0, finalUrl = '';
    try {
      const resp = await page.goto('https://www.xiaohongshu.com/goods/6646d49a000000001f00d3a4', { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = resp ? resp.status() : 0;
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(6000);
      finalUrl = page.url();
    } catch (e) { console.log(`[${mode}] goto 失败: ${e.message.slice(0, 120)}`); }
    const info = await page.evaluate(() => {
      const txt = document.body ? document.body.innerText : '';
      return { title: document.title.slice(0, 60), bodyLen: txt.length, priceSignals: (txt.match(/[¥￥]\s?\d[\d,.]*/g) || []).length, loginWall: /扫码登录|登录后查看|请登录/i.test(txt), captcha: /验证码|滑块|安全验证/i.test(txt), bodyHead: txt.replace(/\s+/g, ' ').slice(0, 200) };
    }).catch((e) => ({ evalErr: e.message.slice(0, 80) }));
    await new Promise((r) => setTimeout(r, 1500));
    dump(`小红书·详情·${mode}`, { status, finalUrl, info, apis, bodyHeads });
    await ctx.close();
  }
  await browser.close();
}

// ---------- 抖音 haohuo「继续访问」 ----------
{
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  const apis = [];
  page.on('response', (r) => {
    try {
      if (/jinritemai|douyin/i.test(r.url()) && /json/i.test(r.headers()['content-type'] || '')) {
        apis.push({ s: r.status(), u: r.url().slice(0, 130) });
      }
    } catch {}
  });
  let status = 0, finalUrl = '';
  try {
    const resp = await page.goto('https://haohuo.jinritemai.com/views/product/item2?id=3637607198078282941', { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp ? resp.status() : 0;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(3000);
    // 找「继续访问」按钮并点击
    const btn = page.locator('a:has-text("继续访问"), button:has-text("继续访问"), div:has-text("继续访问")').first();
    const clicked = await btn.click({ timeout: 5000 }).then(() => true).catch(() => false);
    console.log(`\n===== [抖音·继续访问] ===== 点击: ${clicked}`);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(6000);
    finalUrl = page.url();
  } catch (e) { console.log(`[抖音] goto 失败: ${e.message.slice(0, 120)}`); }
  const info = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    return { title: document.title.slice(0, 60), bodyLen: txt.length, priceSignals: (txt.match(/[¥￥]\s?\d[\d,.]*/g) || []).length, bodyHead: txt.replace(/\s+/g, ' ').slice(0, 300) };
  }).catch((e) => ({ evalErr: e.message.slice(0, 80) }));
  dump('抖音·haohuo·点击继续访问后', { status, finalUrl, info, apis, bodyHeads: [] });
  // 顺带把最终页的关键 DOM 结构打出来（标题/价格节点类名，供解析器用）
  const dom = await page.evaluate(() => [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && /[¥￥]/.test(el.textContent || '')).slice(0, 8).map((el) => `${el.tagName}.${(el.className || '').toString().slice(0, 50)} => ${el.textContent.trim().slice(0, 30)}`)).catch(() => []);
  console.log(`价格节点: ${dom.length ? dom.join(' | ') : '(无)'}`);
  await browser.close();
}
console.log('\n第二轮探测完毕');
