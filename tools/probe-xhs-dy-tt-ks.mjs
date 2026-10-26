// 小红书 / 抖音 / TikTok / 快手 四平台网页端可达性探测（2026-10-26）
// 目标：判断各平台网页端是否有「公开可渲染商品数据」的入口（搜索页/商品详情页），
//       输出 HTTP 状态、落地 URL、标题、正文信号、登录墙/验证码信号、JSON 接口捕获。
// 逐 URL 探测，互不影响；结果用于决定 SCRAPE_CONFIG 的接入姿势与 noProductHint 文案。
import { chromium } from 'playwright';

const Q = '跑步鞋';

const TARGETS = [
  // 小红书：网页搜索需登录；商品详情页历史上有公开渲染（xhslink 短链需解跳）
  { label: '小红书·搜索', url: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(Q)}&source=web_explore_feed` },
  { label: '小红书·商品详情(示例spu)', url: 'https://www.xiaohongshu.com/goods/6646d49a000000001f00d3a4' },
  // 抖音：主站搜索/商城需登录；抖店商品页（haohuo）历史上公开
  { label: '抖音·主站搜索', url: `https://www.douyin.com/search/${encodeURIComponent(Q)}?type=video` },
  { label: '抖音·抖店商品页', url: 'https://haohuo.jinritemai.com/views/product/item2?id=3637607198078282941' },
  { label: '抖音·精选联盟', url: `https://buyin.jinritemai.com/dashboard/traffic/material/search?q=${encodeURIComponent(Q)}` },
  // TikTok Shop：海外站，直连大概率不可达/跳转
  { label: 'TikTok·商城', url: 'https://shop.tiktok.com/' },
  { label: 'TikTok·商品页', url: 'https://shop.tiktok.com/view/product/1729500000000000000' },
  // 快手：网页端商城需登录；短视频页带商品卡
  { label: '快手·商城', url: 'https://www.kuaishou.com/shop' },
  { label: '快手·短视频(商品卡)', url: 'https://www.kuaishou.com/short-video/3x8m7qzrhzk9p6c' },
];

const HOST_RE = /xiaohongshu|xhslink|douyin|jinritemai|byteoversea|tiktok|kuaishou|gifshow|ecom|shop/i;

async function probe(t) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
  const ctx = await browser.newContext({
    locale: 'zh-CN',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
    if (!window.chrome) window.chrome = { runtime: {} };
  });
  const page = await ctx.newPage();
  const apis = [];
  page.on('response', (r) => {
    try {
      if (HOST_RE.test(r.url()) && /json/i.test(r.headers()['content-type'] || '')) {
        apis.push({ s: r.status(), u: r.url().slice(0, 120) });
      }
    } catch {}
  });
  let status = 0, finalUrl = '';
  const t0 = Date.now();
  try {
    const resp = await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    status = resp ? resp.status() : 0;
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(5000);
    try { await page.evaluate(async () => { let y = 0; const s = () => { window.scrollBy(0, 700); y += 700; if (y < 4000) setTimeout(s, 150); }; s(); }); } catch {}
    await page.waitForTimeout(3000);
    finalUrl = page.url();
  } catch (e) {
    console.log(`\n===== [${t.label}] =====`);
    console.log(`goto 失败(${((Date.now() - t0) / 1000).toFixed(1)}s): ${e.message.slice(0, 150)}`);
    console.log(`JSON 接口捕获 ${apis.length} 条`);
    for (const a of apis.slice(0, 5)) console.log(`  ${a.s} ${a.u}`);
    await browser.close();
    return;
  }
  const info = await page.evaluate(() => {
    const txt = document.body ? document.body.innerText : '';
    return {
      title: document.title.slice(0, 60),
      bodyLen: txt.length,
      priceSignals: (txt.match(/[¥￥$]\s?\d[\d,.]*/g) || []).length,
      loginWall: /扫码登录|二维码登录|登录后查看|请登录|下载.{0,6}(App|应用)|打开.{0,4}(App|抖音|快手|小红书)/i.test(txt),
      captcha: /验证码|滑块|安全验证|verify/i.test(txt),
      goodsLinks: [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => /\/(goods|product|item|merchandise)/i.test(h)).length,
      bodyHead: txt.replace(/\s+/g, ' ').slice(0, 160),
    };
  }).catch((e) => ({ evalErr: e.message.slice(0, 80) }));
  const htmlLen = (await page.content().catch(() => '')).length;
  console.log(`\n===== [${t.label}] =====`);
  console.log(`HTTP ${status} → ${finalUrl.slice(0, 100)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  console.log(`标题: ${info.title || '-'} ｜ 正文 ${info.bodyLen} 字 ｜ HTML ${(htmlLen / 1024).toFixed(0)}KB ｜ 价格信号 ${info.priceSignals} ｜ 商品链接 ${info.goodsLinks}`);
  console.log(`登录墙: ${info.loginWall ? '是' : '否'} ｜ 验证码: ${info.captcha ? '是' : '否'}`);
  console.log(`正文开头: ${info.bodyHead || info.evalErr || '-'}`);
  console.log(`JSON 接口捕获 ${apis.length} 条（前 6）:`);
  for (const a of apis.slice(0, 6)) console.log(`  ${a.s} ${a.u}`);
  await browser.close();
}

for (const t of TARGETS) {
  await probe(t);
}
console.log('\n探测完毕');
