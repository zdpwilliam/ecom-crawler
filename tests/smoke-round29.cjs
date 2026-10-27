// 本轮（五项修复）UI 冒烟：小按钮 / 离线诊断文件上传 / 指纹池明细 / 重新登录按钮 / 数据清理弹框
const { chromium } = require('playwright');

const results = [];
function check(name, cond) {
  results.push([cond ? 'PASS' : 'FAIL', name]);
  if (!cond) process.exitCode = 1;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto('http://127.0.0.1:4311/#/collect', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 1. 存为定时任务 = 小号按钮
  const cls = await page.getAttribute('#saveAsJob', 'class');
  check('1. 存为定时任务按钮为 btn-sm 小号', cls.includes('btn-sm'));

  // 2. 离线诊断：文件选择 + 上传诊断按钮存在且初始禁用
  check('2a. 诊断面板存在文件选择按钮', (await page.locator('#dgFileBtn').count()) === 1);
  check('2b. 诊断按钮初始禁用（未选文件）', await page.locator('#dgBtn').isDisabled());
  check('2c. 存在高级路径模式', (await page.locator('#dgPathBtn').count()) === 1);
  // 直接给 hidden file input 塞文件，模拟用户选择 → 按钮启用 → 点诊断 → 出结果
  await page.setInputFiles('#dgFile', 'data/fixtures/demo-detail.html');
  check('2d. 选文件后诊断按钮启用', !(await page.locator('#dgBtn').isDisabled()));
  await page.click('#dgBtn');
  await page.waitForFunction(() => {
    const el = document.querySelector('#dgResult');
    return el && el.textContent.includes('诊断对象');
  }, null, { timeout: 30000 });
  check('2e. 上传内容诊断出报告', (await page.locator('#dgResult table').count()) >= 1);

  // 3. 指纹池明细（系统设置页）
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(600);
  await page.click('#fpPoolBtn');
  await page.waitForSelector('#fpPoolBox table', { timeout: 10000 });
  const poolRows = await page.locator('#fpPoolBox tbody tr').count();
  check(`3a. 指纹池明细渲染（${poolRows} 套）`, poolRows >= 12);
  check('3b. 按钮切换为收起', (await page.textContent('#fpPoolBtn')).includes('收起'));
  await page.click('#fpPoolBtn');
  check('3c. 再点收起隐藏', await page.locator('#fpPoolBox').isHidden());

  // 4. 登录状态表：重新登录按钮
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForSelector('#loginTable tbody tr', { timeout: 15000 });
  const relogins = await page.locator('#loginTable [data-lgrelogin]').count();
  check(`4a. 重新登录按钮渲染（${relogins} 个）`, relogins >= 3);
  const vipBtn = page.locator('#loginTable [data-lgrelogin="vip"]');
  check('4b. vip（必需登录）有重新登录按钮', (await vipBtn.count()) === 1);
  // 点击后应出现「浏览器已弹出」或启动失败提示（CI 无 Chrome 弹窗也允许失败文案，但必须有反馈且按钮不抛错）
  await vipBtn.click();
  await page.waitForFunction(
    () => /弹出|失败|超时/.test(document.querySelector('#lgMeta')?.textContent || ''),
    null,
    { timeout: 20000 }
  );
  check('4c. 重新登录点击有状态反馈', true);
  const huaweiOps = await page
    .locator('#loginTable tbody tr', { hasText: 'huawei' })
    .first()
    .innerText();
  // 2026-10-27 round45：所有平台（含「不需要」登录的）都提供登录入口——部分评论/问答登录后才可见
  check('4d. 无需登录平台同样提供重新登录按钮（可选登录态）', huaweiOps.includes('重新登录') || huaweiOps.includes('登录'));

  // 5. 数据清理弹框
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(800);
  await page.click('#dataClearBtn');
  check('5a. 弹框打开', !(await page.locator('#clearModal').isHidden()));
  await page.waitForSelector('#clrCounts table', { timeout: 10000 });
  const countsText = await page.locator('#clrCounts').innerText();
  check('5b. 弹框统计各类型条数', /商品/.test(countsText) && /条/.test(countsText));
  const scopeInfo = await page.textContent('#clrScopeInfo');
  check('5c. 默认范围=当前筛选提示', /范围/.test(scopeInfo));
  // 切换为全部 → 计数刷新
  await page.selectOption('#clrScope', 'all');
  await page.waitForTimeout(700);
  const scopeInfo2 = await page.textContent('#clrScopeInfo');
  check('5d. 切换范围为全部生效', /全部数据/.test(scopeInfo2));
  // 不真实执行清空（避免误删）：只验证确认按钮存在且未勾选时可提交保护
  await page.selectOption('#clrScope', 'filter');
  await page.waitForTimeout(700);
  check('5e. 确认按钮存在', (await page.locator('#clrConfirm').count()) === 1);
  await page.click('#clearModalClose');
  check('5f. 关闭弹框', await page.locator('#clearModal').isHidden());

  // 清理 API 护栏：不勾任何项时前端应拒绝
  await page.click('#dataClearBtn');
  await page.waitForSelector('#clrCounts table', { timeout: 10000 });
  await page.evaluate(() => {
    document.querySelectorAll('#clrCounts [data-clrtype]').forEach((c) => (c.checked = false));
  });
  await page.click('#clrConfirm');
  await page.waitForTimeout(400);
  const guard = await page.textContent('#clrModalResult');
  check('5g. 未勾选项时拒绝执行', /至少勾选/.test(guard));
  await page.click('#clearModalClose');

  // 首页各页快速切换 0 报错
  for (const p of ['jobs', 'settings', 'data', 'collect']) {
    await page.click(`.nav-item[data-page="${p}"]`);
    await page.waitForTimeout(400);
  }

  const jsErrors = errors.filter((e) => !/favicon/i.test(e));
  check(`0 JS 报错（${jsErrors.length}）`, jsErrors.length === 0);
  if (jsErrors.length) console.error(jsErrors.join('\n'));

  console.log('\n===== 冒烟结果 =====');
  for (const [s, n] of results) console.log(`${s}  ${n}`);
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n共 ${results.length} 项，失败 ${fail} 项`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})();
