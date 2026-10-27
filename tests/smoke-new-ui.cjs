// 冒烟：采集参数面板迁移 + 一键测试入口 + 登录状态面板 + 数据页筛选
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:4311/#/collect', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 1. 采集工作台包含采集参数面板（在运行采集之前）
  const order = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('#page-collect .panel h2')].map((h) => h.textContent.trim());
    return panels;
  });
  console.log('工作台面板顺序:', JSON.stringify(order));
  console.log('采集参数在运行采集之前:', order.indexOf('采集参数（每次调用生效）') < order.indexOf('运行采集'));
  console.log('一键测试按钮存在:', !!(await page.$('#testBtn')));
  console.log('保存设置按钮存在(新位置):', !!(await page.$('#saveSettings')));

  // 2. 系统设置页：登录状态表 + 不再含采集参数
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1500);
  const settingsPanels = await page.evaluate(() => [...document.querySelectorAll('#page-settings .panel h2')].map((h) => h.textContent.trim()));
  console.log('设置页面板:', JSON.stringify(settingsPanels));
  const loginRows = await page.evaluate(() => document.querySelectorAll('#loginTable tbody tr').length);
  console.log('登录状态表行数:', loginRows);
  console.log('lgMeta:', await page.evaluate(() => document.querySelector('#lgMeta').textContent));
  console.log('lgInterval 值:', await page.evaluate(() => document.querySelector('#lgInterval').value));

  // 3. 登录状态表内容抽查（vip 应显示已失效）
  const vipRow = await page.evaluate(() => {
    const tr = [...document.querySelectorAll('#loginTable tbody tr')].find((r) => r.cells[0].textContent === 'vip');
    return tr ? tr.cells[3].innerText.trim() : 'ROW_NOT_FOUND';
  });
  console.log('vip 登录状态:', vipRow);

  // 4. 保存定时检测间隔
  await page.fill('#lgInterval', '60');
  await page.click('#lgSaveInterval');
  await page.waitForTimeout(800);
  console.log('保存间隔后 lgMeta:', await page.evaluate(() => document.querySelector('#lgMeta').textContent));

  // 5. 数据页平台筛选仍联动
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(1200);
  await page.selectOption('#dataPlatform', 'suning');
  await page.waitForTimeout(2000);
  const pg = await page.evaluate(() => document.querySelector('#pgInfo').textContent);
  const firstPlat = await page.evaluate(() => document.querySelector('#tableWrap tbody tr td:nth-child(2)')?.textContent);
  console.log('筛选苏宁后 pgInfo:', pg, '首行平台:', firstPlat);

  console.log('JS errors:', JSON.stringify(errors));
  await browser.close();
})();
