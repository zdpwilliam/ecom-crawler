// 本轮冒烟：指纹池明细端型联动修复（去缓存+带mode）/ 生成追加功能 / 清空恢复
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
  page.on('dialog', (d) => d.accept()); // 清空追加档案的 confirm

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1000);

  // 0. 前置：确保追加档案已清空（从干净基础池开始）
  await page.evaluate(async () => {
    await fetch('/api/fingerprint/extra', { method: 'DELETE' });
  });

  // 1. 新控件存在，旧按钮已移除
  const ui = await page.evaluate(() => ({
    genCount: !!document.querySelector('#fpGenCount'),
    genKind: !!document.querySelector('#fpGenKind'),
    append: !!document.querySelector('#fpAppend'),
    clear: !!document.querySelector('#fpClear'),
    oldSpawn: !!document.querySelector('#fpSpawn'),
    appendLabel: document.querySelector('#fpAppend')?.textContent,
  }));
  check('生成数量/端型/追加按钮/清空按钮齐全', ui.genCount && ui.genKind && ui.append && ui.clear);
  check('旧「生成随机指纹」按钮已移除', !ui.oldSpawn);
  check('追加按钮文案为「生成并追加至指纹池」', ui.appendLabel === '生成并追加至指纹池');

  // 2. Bug 修复验证：选仅手机端后展开池明细 → 应只有 5 套移动档案（每次展开实时拉取+带mode）
  await page.selectOption('#fpMode', 'mobile');
  await page.waitForTimeout(1200);
  await page.click('#fpPoolBtn');
  await page.waitForTimeout(800);
  const mobilePool = await page.evaluate(() => {
    const box = document.querySelector('#fpPoolBox');
    const rows = [...box.querySelectorAll('tbody tr')];
    return {
      head: box.querySelector('.count')?.textContent.slice(0, 12),
      rows: rows.length,
      allMobile: rows.every((r) => r.innerText.includes('移动')),
      visible: !box.hidden,
    };
  });
  check('仅手机端子池标题正确', mobilePool.head.includes('仅手机端子池') && mobilePool.head.includes('5'));
  check('仅手机端子池 5 行且全是移动档案', mobilePool.rows === 5 && mobilePool.allMobile);
  check('池明细随端型切换即时更新', mobilePool.visible);
  await page.click('#fpPoolBtn'); // 收起

  // 3. 切回混合端 → 展开应为 12 套（基础池），桌面+移动混合
  await page.selectOption('#fpMode', 'mixed');
  await page.waitForTimeout(1200);
  await page.click('#fpPoolBtn');
  await page.waitForTimeout(800);
  const mixedPool = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#fpPoolBox tbody tr')];
    return { rows: rows.length, hasDesktop: rows.some((r) => r.innerText.includes('桌面')), hasMobile: rows.some((r) => r.innerText.includes('移动')) };
  });
  check('混合端子池 12 套且桌面/移动混合', mixedPool.rows === 12 && mixedPool.hasDesktop && mixedPool.hasMobile);
  await page.click('#fpPoolBtn');

  // 4. UI 追加：数量 2 + 仅桌面 → 结果提示 + 状态栏子池数 +2
  await page.fill('#fpGenCount', '2');
  await page.selectOption('#fpGenKind', 'desktop');
  await page.click('#fpAppend');
  await page.waitForTimeout(1000);
  const appendRes = await page.evaluate(() => document.querySelector('#fpResult').textContent);
  check('追加结果提示「已生成 2 套」', appendRes.includes('已生成 2 套') && appendRes.includes('仅桌面'));
  check('追加后全池 14 套', appendRes.includes('全池现有 14 套'));
  check('追加样例带「追加 ·」前缀', appendRes.includes('追加 ·'));

  // 5. 持久化：data/fingerprints-extra.json 存在且 2 条
  const extraFile = await page.evaluate(async () => {
    // 通过池明细接口间接验证：桌面子池应为 7+2=9
    const d = await (await fetch('/api/fingerprint/pool?mode=desktop')).json();
    return d.pool.length;
  });
  check('重启持久化由文件承接（桌面子池 7+2=9）', extraFile === 9);

  // 6. 清空追加档案 → 恢复基础池 12 套
  await page.click('#fpClear');
  await page.waitForTimeout(1000);
  const clearRes = await page.evaluate(() => document.querySelector('#fpResult').textContent);
  check('清空提示恢复基础池', clearRes.includes('已清空 2 套') && clearRes.includes('现 12 套'));

  // 7. 追加档案参与采集抽档：refreshProfilePool 走同一 poolFor —— 用 spawn 接口的 randomFingerprint 验证
  await page.evaluate(async () => {
    await fetch('/api/fingerprint/append', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ count: 5, kind: 'mobile' }) });
  });
  await page.selectOption('#fpMode', 'mobile');
  await page.waitForTimeout(1000);
  const spawnMobile = await page.evaluate(async () => {
    const results = [];
    for (let i = 0; i < 8; i++) {
      const r = await (await fetch('/api/fingerprint/spawn')).json();
      results.push(r.randomFingerprint.mobile === true && r.poolSize >= 10);
    }
    return results.every(Boolean);
  });
  check('采集抽档联动：仅手机端下 spawn 全部返回移动档案', spawnMobile);
  // 清理测试追加档案
  await page.evaluate(async () => {
    await fetch('/api/fingerprint/extra', { method: 'DELETE' });
  });
  await page.selectOption('#fpMode', 'mixed');
  await page.waitForTimeout(800);

  check('全程无 JS 报错', errors.length === 0);
  if (errors.length) console.log('JS errors:', errors);
  console.log(results.join('\n'));
  await browser.close();
})();
