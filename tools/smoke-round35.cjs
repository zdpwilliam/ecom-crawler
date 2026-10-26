// 本轮冒烟：存储后端切换确认弹窗 / 预检校验 / 迁移进度条结构 / mongod 缺失失败路径
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
  await page.waitForTimeout(1000);

  // 1. 面板结构：进度条区存在且默认隐藏
  const struct = await page.evaluate(() => ({
    migBox: !!document.querySelector('#migBox'),
    migHidden: document.querySelector('#migBox')?.hidden,
    bar: !!document.querySelector('#migBox .mig-bar .mig-fill'),
    modal: !!document.querySelector('#beModal'),
  }));
  check('迁移进度条区存在且默认隐藏', struct.migBox && struct.migHidden && struct.bar);
  check('切换确认弹窗存在', struct.modal);

  // 2. 同后端点击 → alert 提示无需切换，不弹确认框
  let alertText = '';
  page.on('dialog', async (d) => {
    alertText = d.message();
    await d.accept();
  });
  await page.click('#beSqlite');
  await page.waitForTimeout(800);
  check('同后端点击提示「无需切换」', alertText.includes('无需切换'));
  check('同后端不打开确认弹窗', await page.evaluate(() => document.querySelector('#beModal').hidden));

  // 3. 切换到 MongoDB（本机 mongod 未启动）→ 弹窗 + 预检失败 ❌ + 确认按钮禁用
  //    （预检等待 mongo 5s 连接超时，故用 waitForFunction 轮询）
  await page.click('#beMongo');
  await page
    .waitForFunction(() => {
      const info = document.querySelector('#beModalInfo')?.textContent || '';
      const disabled = document.querySelector('#beModalConfirm')?.disabled;
      return info.includes('❌') || info.includes('✅') || (!disabled && info.includes('目标库'));
    }, { timeout: 12000 })
    .catch(() => {});
  const mongoModal = await page.evaluate(() => ({
    open: !document.querySelector('#beModal').hidden,
    dir: document.querySelector('#beModalDir')?.textContent,
    info: document.querySelector('#beModalInfo')?.textContent,
    confirmDisabled: document.querySelector('#beModalConfirm')?.disabled,
  }));
  check('Mongo 切换打开确认弹窗', mongoModal.open);
  check('弹窗展示切换方向 SQLite → MongoDB', mongoModal.dir.includes('SQLite') && mongoModal.dir.includes('MongoDB'));
  check('预检失败展示 mongod 未启动错误', mongoModal.info.includes('❌') && mongoModal.info.includes('mongod'));
  check('预检失败时确认按钮禁用', mongoModal.confirmDisabled === true);
  // 取消关闭
  await page.click('#beModalCancel');
  check('取消按钮可关闭弹窗', await page.evaluate(() => document.querySelector('#beModal').hidden));

  // 4. API 层：migrate:true 切到 mongodb 应被预检拦截（400），后端保持 sqlite
  const apiTry = await page.evaluate(async () => {
    const r = await fetch('/api/storage/backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'mongodb', migrate: true }),
    });
    return { code: r.status, body: await r.json() };
  });
  check('mongod 缺失时 migrate 请求被拦截（400）', apiTry.code === 400 && (apiTry.body.error || '').includes('mongod'));
  const backendNow = await page.evaluate(async () => (await (await fetch('/api/storage/backend')).json()).backend);
  check('拦截后后端保持 sqlite', backendNow === 'sqlite');

  // 5. 进度查询接口可用
  const mig = await page.evaluate(async () => (await (await fetch('/api/storage/migration')).json()));
  check('迁移进度接口返回状态对象', typeof mig.running === 'boolean' && 'pct' in mig);

  // 预检失败路径的 503/400 资源日志属预期，不计入 JS 报错
  const realErrors = errors.filter((e) => !/Failed to load resource.*(503|400)/.test(e));
  check('全程无 JS 报错', realErrors.length === 0);
  if (realErrors.length) console.log('JS errors:', realErrors);
  console.log(results.join('\n'));
  await browser.close();
})();
