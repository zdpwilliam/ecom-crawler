// Round 38 冒烟：得物「Playwright + 移动端 UA/视口」路线
// 覆盖：① dewu 配置（mobileOnly/noProductHint/detailUrl）② resolveProfile 强制移动画像
// ③ 其他平台不受影响 ④ Playwright 上下文 isMobile/hasTouch 传参 ⑤ 端到端 API 采集错误提示
const { chromium } = require('playwright');

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

(async () => {
  // ---------- 1. 服务端单元：配置与档案强制（离线导入模块） ----------
  const cfgMod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/server/adapters/scrape/config.ts');
  const dewu = cfgMod.SCRAPE_CONFIG.dewu;
  check('dewu 配置 mobileOnly=true', dewu && dewu.mobileOnly === true);
  check('dewu noProductHint 说明无网页商城+验证码风控', typeof dewu.noProductHint === 'string' && dewu.noProductHint.includes('没有网页商城') && dewu.noProductHint.includes('485'));
  check('dewu detailUrl 构造 H5 详情链接', /^https:\/\/www\.dewu\.com\/product-detail\.html\?spuId=\d+$/.test(dewu.detailUrl('123456')));
  check('其他平台无 mobileOnly（vip/suning/taobao）', !cfgMod.SCRAPE_CONFIG.vip?.mobileOnly && !cfgMod.SCRAPE_CONFIG.suning?.mobileOnly && !cfgMod.SCRAPE_CONFIG.taobao?.mobileOnly);

  const fp = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/server/fingerprint.ts');
  const gen = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/server/adapters/scrape/generic.ts');

  // 全局端型 mixed：dewu 必须全部强制为移动档案
  fp.setFingerprintMode('mixed');
  fp.refreshProfilePool(10);
  const MOBILE_UA_RE = /iPhone|iPad|Android|Mobile|HRY-|Pixel/;
  let allMobile = true, allMobileUA = true;
  for (let i = 0; i < 12; i++) {
    const p = gen.resolveProfile('dewu');
    if (!p.mobile) allMobile = false;
    if (!MOBILE_UA_RE.test(p.userAgent || '')) allMobileUA = false;
  }
  check('mixed 模式下 dewu 档案 12/12 强制 mobile:true', allMobile);
  check('dewu 档案 UA 全部为移动设备（iPhone/iPad/Android）', allMobileUA);

  // 全局端型 desktop：dewu 仍强制移动；vip/suning 跟随全局保持桌面
  fp.setFingerprintMode('desktop');
  fp.refreshProfilePool(10);
  const dewuMobile = gen.resolveProfile('dewu');
  const vipP = gen.resolveProfile('vip');
  const suningP = gen.resolveProfile('suning');
  check('desktop 模式下 dewu 仍强制移动画像（不受全局端型影响）', dewuMobile.mobile === true && MOBILE_UA_RE.test(dewuMobile.userAgent || ''));
  check('desktop 模式下 vip 档案保持桌面（行为不变）', vipP.mobile === false && !MOBILE_UA_RE.test(vipP.userAgent || ''));
  check('desktop 模式下 suning 档案保持桌面（行为不变）', suningP.mobile === false);
  fp.setFingerprintMode('mixed');
  fp.refreshProfilePool(10);

  // ---------- 2. Playwright 上下文：isMobile/hasTouch 与移动档案联动（自托管空页验证，无外网） ----------
  const b = await chromium.launch({ headless: true });
  // 模拟 loadPlaywright 的 context 构造：移动档案 → isMobile+hasTouch
  const mctx = await b.newContext({
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mp = await mctx.newPage();
  await mp.setContent('<h1>probe</h1>');
  const mob = await mp.evaluate(() => ({
    ua: navigator.userAgent.slice(0, 30),
    maxTouch: navigator.maxTouchPoints,
    screenW: screen.width,
  }));
  check('移动上下文 UA 为 iPhone', /iPhone/.test(mob.ua));
  check('移动上下文 maxTouchPoints>0（hasTouch 生效）', mob.maxTouch > 0);
  check('移动上下文物理屏宽 390（无 meta viewport 时布局视口按标准 980，属移动端正常行为）', mob.screenW === 390);
  await mctx.close();
  // 桌面档案 → 不带 isMobile
  const dctx = await b.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124', viewport: { width: 1440, height: 900 } });
  const dp = await dctx.newPage();
  await dp.setContent('<h1>probe</h1>');
  const dsk = await dp.evaluate(() => ({ maxTouch: navigator.maxTouchPoints, vw: window.innerWidth }));
  check('桌面上下文无触摸（行为不变）', dsk.maxTouch === 0 && dsk.vw === 1440);
  await dctx.close();
  await b.close();

  // ---------- 3. 端到端：API 采集得物 → 返回专属错误提示（真实外网，验证全链路） ----------
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto('http://127.0.0.1:4311', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const api = await page.evaluate(async () => {
    const r = await (await fetch('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'dewu', dataType: 'product', query: '跑步鞋', limit: 3 }),
    })).json();
    return r;
  });
  check('端到端采集得物返回 failed（预期：无网页商城）', api.status === 'failed' && api.platform === 'dewu');
  check('错误信息含得物专属说明（485/开放平台/抓包）', /没有网页商城/.test(api.message || '') && /485/.test(api.message || ''));
  // 运行日志确认用了移动 UA
  await page.waitForTimeout(500);
  const logs = await page.evaluate(async () => (await (await fetch('/api/logs')).json()).lines);
  const lastRun = logs.filter((l) => l.msg.includes('引擎=浏览器')).slice(-1)[0];
  check('运行日志显示移动设备 UA 出网', lastRun && MOBILE_UA_RE.test(lastRun.msg));
  check('全程无 JS 报错', errors.length === 0);
  if (errors.length) console.log('JS errors:', errors);
  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})();
