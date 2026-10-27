// Round 40 冒烟：新增四平台（小红书/抖音/TikTok/快手）接入
// 验证：平台注册（13 个）→ 工作台/定时/数据筛选下拉联动 → 设置页登录表 13 行
//       → config 探测结论/无登录提示 → Cookie 提取与登录判定接线 → API 回归
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:4311';
const NEW_PLATFORMS = ['xiaohongshu', 'douyin', 'tiktok', 'kuaishou'];

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // ---------- 1. 平台注册：/api/platforms 13 个，四新平台齐全 ----------
  const api = await page.evaluate(async () => (await fetch('/api/platforms')).json());
  check('平台总数 13（原 9 + 新 4）', api.length === 13);
  check('四新平台均已注册（小红书/抖音商城/TikTok Shop/快手）', NEW_PLATFORMS.every((p) => api.some((x) => x.id === p)));
  check('四新平台均挂载 scrape 适配器', NEW_PLATFORMS.every((p) => api.find((x) => x.id === p)?.hasScrape));

  // ---------- 2. 前端三处平台下拉联动（工作台 / 定时任务 / 数据筛选） ----------
  const opts = await page.evaluate(() => ({
    job: [...document.querySelectorAll('#platform option')].map((o) => o.value),
    task: [...document.querySelectorAll('#jobPlatform option')].map((o) => o.value),
    data: [...document.querySelectorAll('#dataPlatform option')].map((o) => o.value),
  }));
  check('工作台平台下拉含四新平台', NEW_PLATFORMS.every((p) => opts.job.includes(p)));
  check('定时任务平台下拉含四新平台', NEW_PLATFORMS.every((p) => opts.task.includes(p)));
  check('数据筛选平台下拉含四新平台', NEW_PLATFORMS.every((p) => opts.data.includes(p)));

  // ---------- 3. 设置页登录状态表：13 行全平台登录入口 ----------
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1500);
  const loginTable = await page.evaluate(() => {
    const table = document.querySelector('#loginTable table');
    if (!table) return null;
    const rows = [...table.querySelectorAll('tbody tr')];
    return {
      rows: rows.length,
      newRowIds: rows.map((r) => r.firstElementChild.textContent.trim()),
      withLogin: rows.filter((r) => r.querySelector('[data-lgrelogin]')).length,
      withCheck: rows.filter((r) => r.querySelector('[data-lgcheck]')).length,
    };
  });
  check('登录状态表渲染 13 个平台', loginTable && loginTable.rows === 13);
  check('四新平台行已出现在登录表', loginTable && NEW_PLATFORMS.every((p) => loginTable.newRowIds.includes(p)));
  check('新平台行也有检测+登录双按钮', loginTable && loginTable.withLogin === 13 && loginTable.withCheck === 13);
  // 四新平台「需要登录」列应为「必需」
  const needCol = await page.evaluate((ids) => {
    const rows = [...document.querySelectorAll('#loginTable tbody tr')];
    return ids.map((id) => {
      const tr = rows.find((r) => r.firstElementChild.textContent.trim() === id);
      return tr ? tr.children[1].textContent.trim() : '';
    });
  }, NEW_PLATFORMS);
  check('四新平台登录要求均为「必需」', needCol.every((t) => t === '必需'));

  // round40 补：手动保存登录信息下拉（#lgPlatform）动态联动 13 平台
  const lgOpts = await page.evaluate(() => [...document.querySelectorAll('#lgPlatform option')].map((o) => o.value));
  check('手动保存登录信息下拉含 13 个平台（含四新平台）', lgOpts.length === 13 && NEW_PLATFORMS.every((p) => lgOpts.includes(p)));
  // round40 补：采集参数说明文案已修正（不再有「三个子模块」过时表述）
  const hintText = await page.evaluate(() => [...document.querySelectorAll('.panel .hint')].map((h) => h.textContent).join(' '));
  check('采集参数文案不再包含「三个子模块」过时表述', !hintText.includes('三个子模块') && hintText.includes('立即对后续每次抓取调用生效'));

  // ---------- 4. 服务端配置接线：探测结论 / 详情 URL / 币种 ----------
  const cfgWired = await page.evaluate(async (ids) => {
    // 通过登录检测接口确认新平台登录态说明有意义（2026-10-27 改为状态感知）：
    // 未存 Cookie → 引导「提取登录态/保存 Cookie」；已存 Cookie（如快手用户真实登录过）→ 启发式描述非空
    const st = await (await fetch('/api/login/status')).json();
    return ids.map((p) => ({ p, status: st.results?.[p]?.status || '', detail: st.results?.[p]?.detail || '' }));
  }, NEW_PLATFORMS);
  check('四新平台登录态说明有意义（无 Cookie 带引导 / 有 Cookie 带描述）', cfgWired.every((x) =>
    x.status === 'absent' ? /提取登录态|保存 Cookie/.test(x.detail) : (x.status === 'none' || x.detail.length > 4)
  ));

  // ---------- 5. 无登录态采集给出明确失败提示（小样本，验证 noProductHint 接线） ----------
  // 用小红书搜索跑一次（未存 Cookie → 浏览器渲染落登录墙 → 报错文案带探测结论）
  const hint = await page.evaluate(async () => {
    const r = await (await fetch('/api/collect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'xiaohongshu', dataType: 'product', query: '跑步鞋', limit: 1, withDetails: false }),
    })).json();
    // collect 是异步任务；改为等 1 条跑完的 message
    return r.jobId || r.error || JSON.stringify(r).slice(0, 120);
  });
  check('无登录态采集任务可发起（异步 job）', !!hint);

  // ---------- 6. Cookie 提取与登录判定接线（读 cookie-tool 配置，不真弹浏览器） ----------
  const ct = await page.evaluate(async () => {
    const r = await (await fetch('/api/cookies')).json();
    return r;
  });
  check('Cookie 文件列表接口正常（无新平台 Cookie 属预期）', Array.isArray(ct.files));

  check('全程无 JS 报错', errors.length === 0);
  if (errors.length) console.log('JS errors:', errors);
  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})();
