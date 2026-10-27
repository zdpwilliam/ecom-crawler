// 本轮冒烟：定时任务详情数 / 诊断hint / 按钮布局 / 指纹面板合并 / 共用保存
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

  // 1. 采集工作台：按钮布局（round36 起：存为定时任务/一键测试/运行采集 同一行靠左）
  const layout = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#page-collect .controls')];
    const runRow = rows.find((r) => r.querySelector('#runBtn'));
    const rects = ['saveAsJob', 'testBtn', 'runBtn'].map((i) => document.getElementById(i)?.getBoundingClientRect());
    const centers = rects.map((x) => x && Math.round(x.top + x.height / 2));
    const rowLeft = runRow && runRow.getBoundingClientRect().left;
    return {
      sameRow: centers.every((c) => c != null && Math.abs(c - centers[1]) < 3),
      leftAligned: rects[0] && Math.round(rects[0].left - rowLeft) < 2,
      runRowHasTest: !!runRow?.querySelector('#testBtn'),
      runRowHasRun: !!runRow?.querySelector('#runBtn'),
    };
  });
  check('存为定时任务/一键测试/运行采集 同一行', layout.sameRow);
  check('按钮行靠左（存为定时任务贴行左缘）', layout.leftAligned);
  check('一键测试与运行采集同一行', layout.runRowHasTest && layout.runRowHasRun);

  // 2. 离线诊断 hint 含获取方式
  const dgHint = await page.locator('#page-collect').innerText();
  check('诊断 hint 说明 Ctrl+S 另存 + 样例路径', dgHint.includes('网页，仅 HTML') && dgHint.includes('data/fixtures/demo-products.html'));

  // 3. 定时任务页：带详情标签 + 详情数联动
  await page.click('.nav-item[data-page="jobs"]');
  await page.waitForTimeout(600);
  const jdLabel = await page.locator('#page-jobs').innerText();
  check('任务表单标签含「评论+问答+SPU/SKU」', jdLabel.includes('评论+问答+SPU/SKU'));
  check('详情数输入框默认可见', await page.locator('#jobDetailLimit').isVisible());
  await page.uncheck('#jobDetails');
  await page.waitForTimeout(200);
  check('取消带详情后详情数隐藏', await page.locator('#jobDetailLimitWrap').isHidden());
  await page.check('#jobDetails');
  await page.selectOption('#jobType', 'review');
  await page.waitForTimeout(200);
  check('切评论类型后详情数隐藏', await page.locator('#jobDetailLimitWrap').isHidden());
  await page.selectOption('#jobType', 'product');
  await page.waitForTimeout(200);
  // 添加任务（禁用，避免真的跑）：detailLimit 应入库
  await page.fill('#jobEvery', '600');
  await page.fill('#jobLimit', '3');
  await page.fill('#jobDetailLimit', '5');
  await page.uncheck('#jobEnabled');
  await page.click('#addJobBtn');
  await page.waitForTimeout(1200);
  const jobCell = await page.locator('#jobTable tbody tr').first().innerText();
  check('任务表显示详情数 5', jobCell.includes('详情前 5 个'));
  const saved = await page.evaluate(async () => {
    const jobs = await (await fetch('/api/jobs')).json();
    return jobs.find((j) => j.everyMinutes === 600);
  });
  check('任务 detailLimit=5 已持久化', saved && saved.detailLimit === 5);
  // 清理临时任务
  await page.evaluate(async () => { if (window.__tmpJobId) return; const jobs = await (await fetch('/api/jobs')).json(); const j = jobs.find((x) => x.everyMinutes === 600); if (j) await fetch(`/api/jobs?id=${j.id}`, { method: 'DELETE' }); });
  check('临时任务已清理', await page.evaluate(async () => !(await (await fetch('/api/jobs')).json()).some((j) => j.everyMinutes === 600)));

  // 4/5. 系统设置：合并面板 + 共用保存
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1200);
  const panelCount = await page.locator('#page-settings .panel').count();
  check('设置页面板数=4（登录状态/采集参数（含代理池）/存储管理/抓取技术）', panelCount === 4);
  const cp = await page.locator('#page-settings').innerText();
  check('「数据抓取技术」面板存在（round43）', cp.includes('数据抓取技术') && cp.includes('哪种技术效果最好'));
  check('采集参数内含指纹随机化子模块', cp.includes('请求指纹随机化') && cp.includes('端型范围'));
  check('淘宝开放平台子模块已移除（round37）', !cp.includes('淘宝开放平台'));
  check('共用「保存设置」按钮存在', await page.locator('#saveSettings').isVisible());
  check('指纹池明细按钮仍在', await page.locator('#fpPoolBtn').isVisible());
  // 共用保存：改端型为 desktop → 保存 → 持久化
  await page.selectOption('#fpMode', 'desktop');
  await page.click('#saveSettings');
  await page.waitForTimeout(1200);
  const fp = await page.evaluate(async () => (await (await fetch('/api/settings')).json()).fpMode);
  check('「保存设置」可保存 fpMode=desktop', fp === 'desktop');
  await page.selectOption('#fpMode', 'mixed');
  await page.click('#saveSettings');
  await page.waitForTimeout(800);

  check('0 JS 报错', errors.length === 0);
  console.log(results.join('\n'));
  console.log(`\n${results.filter((r) => r.startsWith('✅')).length}/${results.length} 通过`);
  if (errors.length) console.log('JS 错误：', errors.join(' | '));
  await browser.close();
})();
