// 本轮冒烟：代理池面板独立 / 无登录态残留 / 代理原理图 / Cookie 列超链接唤起弹窗
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

  // 1. 代理池面板独立成面板，标题不再带「登录态」
  const h2s = await page.locator('#page-settings .panel h2').allInnerTexts();
  check('设置页面板标题含独立「代理池」', h2s.some((t) => t.trim() === '代理池'));
  check('面板标题不再有「代理池 & 登录态」', !h2s.some((t) => t.includes('登录态')));

  // 2. 登录态提取控件已移除（ckPlatform/ckExtract/ckView/cookieInfo）
  const removed = await page.evaluate(() => ({
    ckPlatform: !!document.querySelector('#ckPlatform'),
    ckExtract: !!document.querySelector('#ckExtract'),
    ckView: !!document.querySelector('#ckView'),
    cookieInfo: !!document.querySelector('#cookieInfo'),
    ckStatus: !!document.querySelector('#ckStatus'),
  }));
  check('登录态提取下拉已移除', !removed.ckPlatform);
  check('提取登录态按钮已移除', !removed.ckExtract);
  check('查看登录态按钮已移除', !removed.ckView);
  check('cookieInfo 摘要块已移除', !removed.cookieInfo);

  // 3. 代理池面板保留完整代理能力
  const proxyBox = await page.evaluate(() => {
    const panels = [...document.querySelectorAll('#page-settings .panel')];
    const p = panels.find((x) => x.querySelector('h2')?.textContent.trim() === '代理池');
    return p
      ? {
          hasInfo: !!p.querySelector('#proxyInfo'),
          hasReload: !!p.querySelector('#proxyReload'),
          hasTest: !!p.querySelector('#proxyTest'),
          hasAdd: !!p.querySelector('#proxyAdd'),
          hasList: !!p.querySelector('#proxyList'),
          text: p.innerText,
        }
      : null;
  });
  check('代理池面板含 载入/测速/添加/列表 全套控件', proxyBox && proxyBox.hasInfo && proxyBox.hasReload && proxyBox.hasTest && proxyBox.hasAdd && proxyBox.hasList);
  check('代理池 hint 指向「平台登录状态」', proxyBox && proxyBox.text.includes('平台登录状态'));

  // 4. 代理传输原理图：details 内嵌 SVG，主链路 5 节点 + 失败反馈环
  const diag = await page.evaluate(() => {
    const d = document.querySelector('details.diag');
    if (!d) return null;
    const svg = d.querySelector('svg');
    const txt = d.innerText;
    return {
      exists: true,
      open: d.open,
      hasSvg: !!svg,
      viewBox: svg ? svg.getAttribute('viewBox') : '',
      nodes: ['① 采集请求', '② 代理池选路', '③ 协议适配', '④ 代理服务器', '⑤ 目标电商站点'].filter((t) => txt.includes(t)).length,
      hasFeedback: txt.includes('reportFailure') && txt.includes('冷却'),
      hasPlaywright: txt.includes('Playwright'),
    };
  });
  check('原理图 details 存在且默认展开', diag && diag.exists && diag.open);
  check('原理图内嵌 SVG', diag && diag.hasSvg);
  check('原理图主链路 5 节点齐全', diag && diag.nodes === 5);
  check('原理图含失败反馈环（冷却/指数退避）', diag && diag.hasFeedback);
  check('原理图含 Playwright 渲染路径说明', diag && diag.hasPlaywright);

  // 5. 平台登录状态表：已存 Cookie 列为超链接样式，点击唤起 Cookie 明细弹窗
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1200); // 等登录状态表渲染
  const ckCell = await page.evaluate(() => {
    const a = document.querySelector('#loginTable a.ck-link[data-ckview]');
    if (!a) return null;
    const st = getComputedStyle(a);
    return { platform: a.dataset.ckview, underline: st.textDecorationLine.includes('underline'), visible: !!a.offsetParent };
  });
  check('已存 Cookie 列渲染为超链接（a.ck-link）', !!ckCell);
  check('Cookie 超链接有下划线样式', ckCell && ckCell.underline);
  check('Cookie 超链接在设置页可见', ckCell && ckCell.visible);
  // 点击唤起弹窗（库内已有淘宝真实 Cookie，直接用第一条）
  await page.click('#loginTable a.ck-link[data-ckview]');
  await page.waitForTimeout(800);
  check('点击 Cookie 超链接弹出明细弹窗', await page.evaluate(() => !document.querySelector('#cookieModal').hidden));
  const modalText = await page.locator('#ckModalBody').innerText();
  check('弹窗展示 Cookie 条目表（含名称/值/域）', modalText.includes('名称') && modalText.includes('域'));
  check('弹窗标题带平台名', (await page.locator('#ckModalTitle').innerText()).length > 2);
  await page.click('#ckModalClose');
  check('关闭按钮可关闭弹窗', await page.evaluate(() => document.querySelector('#cookieModal').hidden));

  check('全程无 JS 报错', errors.length === 0);
  if (errors.length) console.log('JS errors:', errors);
  console.log(results.join('\n'));
  await browser.close();
})();
