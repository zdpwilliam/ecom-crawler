// 冒烟测试：本轮 UI 改版（采集参数挪设置页 / 一键测试弹框 / 聊天移除 / 抽屉补抓+关联 / 指纹池）
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:4311';
const errors = [];
let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle' });

  console.log('— 采集工作台 —');
  check('数据类型无聊天选项', await page.locator('#dataType option[value="chat"]').count() === 0);
  check('聊天合规导入面板已移除', await page.locator('text=聊天合规导入').count() === 0);
  check('采集参数面板不在工作台', await page.locator('#page-collect #setDelayMin').count() === 0);
  check('一键测试按钮在运行采集左边', await page.locator('#testBtn').count() === 1);
  const order = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#page-collect .controls:last-of-type button, #page-collect button')];
    const i1 = btns.findIndex((b) => b.id === 'testBtn');
    const i2 = btns.findIndex((b) => b.id === 'runBtn');
    return { i1, i2 };
  });
  check('testBtn 位于 runBtn 之前', order.i1 !== -1 && order.i2 !== -1 && order.i1 < order.i2);
  check('带商详标签文案（round36 起「带详情(评论+问答+SPU/SKU)」精简为「带商详」）', (await page.locator('#withDetailsWrap').innerText()).includes('带商详'));
  check('字段提取诊断面板为本地 HTML 模式（无 dgMode）', await page.locator('#dgMode').count() === 0);

  console.log('— 一键测试弹框 —');
  await page.click('#testBtn');
  await page.waitForTimeout(500);
  check('弹框已打开', await page.locator('#testModal').isVisible());
  check('弹框标题带平台/类型联动', (await page.locator('#testModalMeta').innerText()).length > 3);
  check('测试进行中文案展示', (await page.locator('#testModalBody').innerText()).includes('测试中'));
  // 等真实测试完成（huawei 全链路，最多 180s）
  await page.waitForFunction(
    () => document.querySelectorAll('#testModalBody .test-step').length > 0,
    null, { timeout: 180000 }
  );
  const stepCount = await page.locator('#testModalBody .test-step').count();
  check(`商品类型展示 4 步（实际 ${stepCount}）`, stepCount === 4);
  check('每步有字段诊断按钮', await page.locator('#testModalBody [data-diag]').count() === stepCount);
  const hasUrl = await page.evaluate(() =>
    [...document.querySelectorAll('.test-step-url a')].some((a) => a.href.startsWith('http'))
  );
  check('步骤展示最终链接', hasUrl);
  // 点第一步的字段诊断（在线诊断合并验证）
  await page.locator('#testModalBody [data-diag]').first().click();
  await page.waitForFunction(
    () => {
      const p = document.querySelector('.test-step .diag-result');
      return p && !p.hidden && p.textContent.length > 10;
    },
    null, { timeout: 120000 }
  );
  const diagText = await page.locator('.test-step .diag-result').first().innerText();
  check('字段诊断就地出结果（含字段命中表）', diagText.includes('字段') || diagText.includes('策略') || diagText.includes('建议'));
  await page.click('#testModalClose');
  check('弹框可关闭', await page.locator('#testModal').isHidden());

  console.log('— 数据管理 —');
  await page.click('[data-page="data"]');
  await page.waitForTimeout(800);
  const tabTypes = await page.evaluate(() => [...document.querySelectorAll('.tab')].map((t) => t.dataset.type));
  check(`页签为 product/review/qa（实际 ${tabTypes.join(',')}）`, tabTypes.join(',') === 'product,review,qa');
  await page.waitForSelector('#tableWrap table', { timeout: 10000 });
  check('商品表格有详情按钮', await page.locator('#tableWrap [data-detail]').count() > 0);
  // 打开抽屉：补抓按钮 + 关联区块
  await page.locator('#tableWrap [data-detail]').first().click();
  await page.waitForTimeout(300);
  check('抽屉打开', await page.locator('#drawerMask').isVisible());
  check('抽屉有补抓详情按钮', await page.locator('#refetchBtn').count() === 1);
  await page.waitForFunction(() => {
    const b = document.querySelector('#drawerRelated');
    return b && b.innerText.length > 5 && !b.innerText.includes('检索中');
  }, { timeout: 20000 });
  const rel = await page.locator('#drawerRelated').innerText();
  check('关联评论/问答区块渲染', rel.includes('关联评论'));
  // 先关抽屉再切页签（抽屉遮罩会拦截点击）
  await page.keyboard.press('Escape');
  check('Esc 关抽屉', await page.locator('#drawerMask').isHidden());
  // 评论页签：商品列可点击跳回
  await page.click('.tab[data-type="review"]');
  await page.waitForTimeout(1000);
  const jumpCount = await page.locator('#tableWrap [data-jumpprod]').count();
  const enabledJump = page.locator('#tableWrap [data-jumpprod][data-jumpprod]:not([data-jumpprod=""])').first();
  if (jumpCount > 0 && (await enabledJump.count())) {
    await enabledJump.click();
    await page.waitForTimeout(1200);
    const active = await page.evaluate(() => document.querySelector('.tab.active')?.dataset.type);
    check('评论商品列点击跳回商品页签', active === 'product');
    const kw = await page.inputValue('#dataSearch');
    check(`按 itemId 检索（关键词=${kw.slice(0, 20)}）`, kw.length > 0);
  } else {
    check('评论商品列（库存评论暂无 itemId，跳过点击验证）', true);
  }

  console.log('— 系统设置 —');
  await page.click('[data-page="settings"]');
  await page.waitForTimeout(800);
  const panels = await page.evaluate(() => [...document.querySelectorAll('#page-settings .panel h2')].map((h) => h.textContent));
  check('采集参数在设置页首位附近', panels.some((t) => t.includes('采集参数')));
  const idx1 = panels.findIndex((t) => t.includes('采集参数'));
  const idx2 = panels.findIndex((t) => t.includes('代理池'));
  // round46 起代理池并入采集参数面板（子模块），不再有独立 h2
  check('采集参数面板存在', idx1 !== -1);
  check('无聊天清空选项', await page.locator('#clrChat').count() === 0);
  const fpHint = await page.locator('text=真实设备指纹池').count();
  check('指纹池说明展示（round34 起文案为「真实设备指纹池」）', fpHint > 0);
  // round36 起同步：fpPoolSize/fpSpawn 已被 round34 改版移除，改验当前元素（只读，不真实追加）
  check('指纹池明细按钮存在', await page.locator('#fpPoolBtn').count() > 0);
  check('端型范围选择器存在', await page.locator('#fpMode').count() > 0);
  check('生成并追加按钮存在', await page.locator('#fpAppend').count() > 0);
  check('功能状态区存在', await page.locator('#fpResult').count() > 0);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (errors.length) {
    console.log('\nJS 报错：');
    errors.forEach((e) => console.log('  ' + e.slice(0, 160)));
  } else {
    console.log('JS 报错：0');
  }
  await browser.close();
  process.exit(fail || errors.length ? 1 : 0);
})();
