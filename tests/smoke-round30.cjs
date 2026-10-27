// 本轮冒烟：系统设置淘宝文案 / 官方API面板 / 凭证字段 / top测试按钮 / SPU-SKU 完整记录
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

  // 1. 系统设置页：round37 起平台文案统一「淘宝/天猫」，淘宝开放平台子模块已移除
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(800);
  const lgOpt = await page.locator('#lgPlatform option[value="taobao"]').innerText();
  check('登录信息下拉文案=淘宝/天猫（无官方API后缀）', lgOpt.trim() === '淘宝/天猫');
  check('页面无「淘宝/天猫-有官方API」旧文案', !(await page.locator('#page-settings').innerText()).includes('有官方API'));
  check('淘宝开放平台子模块已移除', (await page.locator('text=淘宝开放平台（官方 API）').count()) === 0);
  check('TOP 凭证输入框已移除', (await page.locator('#setTopAppKey').count()) === 0 && (await page.locator('#topTestBtn').count()) === 0);

  // 5. 数据管理：补抓过的商品 SPU/SKU 在抽屉完整记录中
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(800);
  await page.fill('#dataSearch', '10086966141469');
  await page.waitForTimeout(1500);
  await page.locator('#tableWrap [data-detail]').first().click();
  await page.waitForTimeout(500);
  const drawerText = await page.locator('#drawerBody').innerText();
  check('抽屉含 SPU/SKU 区块', drawerText.includes('SPU') && drawerText.includes('SKU'));
  const drawerJson = await page.locator('#drawerBody pre').last().innerText();
  let jsonHasSpecs = false;
  try { const o = JSON.parse(drawerJson); jsonHasSpecs = !!(o.specs && o.specs.spu && o.specs.skus); } catch {}
  check('完整记录 JSON 内含 specs.spu + specs.skus', jsonHasSpecs);

  check('0 JS 报错', errors.length === 0);
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('✅')).length}/${results.length} 通过`);
  if (errors.length) console.log('JS 错误：', errors.join(' | '));
  await browser.close();
})();
