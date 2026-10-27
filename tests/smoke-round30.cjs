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
  //  数据驱动：找一条 specs.spu+specs.skus 的记录；库被清理后无命中则现场对一条 VIP 记录补抓（验证详情补抓链路）
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(800);
  let spuTarget = await page.evaluate(async () => {
    const r = await (await fetch('/api/data?type=product&pageSize=100')).json();
    return (r.rows || []).find((x) => x.specs && x.specs.spu && x.specs.skus && x.specs.skus.length) || null;
  });
  if (!spuTarget) {
    const refetched = await page.evaluate(async () => {
      const r = await (await fetch('/api/data?type=product&pageSize=100')).json();
      const cand = (r.rows || []).find((x) => x.platform === 'vip' && (x.itemId || /^https?:\/\//.test(x.url || ''))) || (r.rows || []).find((x) => x.itemId || /^https?:\/\//.test(x.url || ''));
      if (!cand) return null;
      const resp = await fetch('/api/detail-refetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cand.id }) });
      const out = await resp.json();
      return out.status === 'ok' ? cand : null;
    });
    if (refetched) {
      await page.waitForTimeout(800);
      spuTarget = await page.evaluate(async (tid) => {
        const r = await (await fetch('/api/data?type=product&pageSize=100')).json();
        return (r.rows || []).find((x) => x.id === tid && x.specs && x.specs.spu) || null;
      }, refetched.id) || refetched;
    }
  }
  check('存在可验证 SPU/SKU 的商品记录（现场补抓或历史数据）', !!spuTarget);
  await page.fill('#dataSearch', spuTarget ? String(spuTarget.itemId || spuTarget.id).slice(0, 40) : '不存在的商品');
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
