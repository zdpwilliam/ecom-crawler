// 本轮冒烟：设置页清空入口移除 / 登录表整理 / 指纹端型切换
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:4311';
const results = [];
const check = (name, ok) => {
  results.push(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) process.exitCode = 1;
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(800);

  // 1. 清空数据入口已移除（数据管理页入口仍在）
  check('系统设置无 clrBtn 清空按钮', (await page.locator('#clrBtn').count()) === 0);
  check('存储管理 hint 指向数据管理页', (await page.locator('#page-settings').innerText()).includes('数据管理」页'));
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(600);
  check('数据管理页清理入口仍在', await page.locator('#dataClearBtn').isVisible());

  // 2. 登录状态表：无修复提示 + 说明列省略样式
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1200);
  const lt = await page.locator('#loginTable').innerText();
  check('登录表无「点右侧重新登录修复」提示', !lt.includes('点右侧'));
  check('登录表仍有「重新登录」操作按钮', (await page.locator('#loginTable [data-lgrelogin]').count()) > 0);
  const hasOverflow = await page.evaluate(() => {
    const td = document.querySelector('#loginTable td.lg-detail');
    if (!td) return false;
    const cs = getComputedStyle(td);
    return cs.textOverflow === 'ellipsis' && cs.overflow === 'hidden';
  });
  check('说明列 ellipsis 省略样式生效', hasOverflow);

  // 3. 指纹端型切换：切 desktop → 状态与子池联动；还原 mixed
  const sel = page.locator('#fpMode');
  check('端型范围选择器存在', await sel.isVisible());
  await sel.selectOption('desktop');
  await page.waitForTimeout(1200);
  const statusTxt = await page.locator('#fpModeStatus').innerText();
  check('切换提示显示「仅桌面端」', statusTxt.includes('仅桌面端') && statusTxt.includes('立即生效'));
  // 展开池明细：应全为桌面
  await page.click('#fpPoolBtn');
  await page.waitForTimeout(1000);
  const poolTxt = await page.locator('#fpPoolBox').innerText();
  check('池明细标题为仅桌面端子池', poolTxt.includes('仅桌面端'));
  check('池明细无移动档案（iPhone/Android/iPad 不出现）', !/iPhone|Android|iPad/.test(poolTxt));
  check('池明细含 10 行桌面档案（2026-10-27 基础池扩容 7→10）', (await page.locator('#fpPoolBox tbody tr').count()) === 10);
  // 还原 mixed
  await sel.selectOption('mixed');
  await page.waitForTimeout(1200);
  const saved = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).fpMode);
  check('还原 mixed 已持久化', saved === 'mixed');

  check('0 JS 报错', errors.length === 0);
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('✅')).length}/${results.length} 通过`);
  if (errors.length) console.log('JS 错误：', errors.join(' | '));
  await browser.close();
})();
