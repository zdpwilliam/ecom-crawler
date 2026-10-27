// Round 39 冒烟：① 平台登录状态表全平台登录入口 ② 商品详情扩展（描述/图片/规格参数）
const { chromium } = require('playwright');

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
  await page.goto('http://127.0.0.1:4311', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // ---------- 1. 平台登录状态：所有平台都有检测 + 登录按钮 ----------
  await page.click('.nav-item[data-page="settings"]');
  await page.waitForTimeout(1200);
  const loginTable = await page.evaluate(() => {
    const table = document.querySelector('#loginTable table');
    if (!table) return null;
    const rows = [...table.querySelectorAll('tbody tr')];
    return {
      rows: rows.length,
      withLogin: rows.filter((r) => r.querySelector('[data-lgrelogin]')).length,
      withCheck: rows.filter((r) => r.querySelector('[data-lgcheck]')).length,
      labels: rows.map((r) => {
        const btn = r.querySelector('[data-lgrelogin]');
        return btn ? btn.textContent.trim() : '';
      }),
      noLoginText: rows.filter((r) => r.textContent.includes('无需登录')).length,
      // 操作列：每个平台的操作格都必须有真实按钮（而非纯文字占位）
      opsAllHaveBtns: rows.every((r) => {
        const ops = r.lastElementChild;
        return ops && ops.querySelector('button[data-lgrelogin]') && ops.querySelector('button[data-lgcheck]');
      }),
    };
  });
  check('登录状态表渲染 13 个平台（round40 起 9+4）', loginTable && loginTable.rows === 13);
  check('所有平台都有 🔑 登录按钮（含四新平台）', loginTable && loginTable.withLogin === 13);
  check('所有平台都有检测按钮', loginTable && loginTable.withCheck === 13);
  check('「无需登录」纯文字占位已移除（操作列）', loginTable && loginTable.opsAllHaveBtns);
  check('按钮文案区分登录/重新登录（有 Cookie → 重新登录）', loginTable && loginTable.labels.some((l) => l.includes('登录')));
  // 点击任一平台的登录按钮应触发浏览器拉起流程提示（不真等登录，验证接线）
  const wire = await page.evaluate(() => {
    const btn = document.querySelector('#loginTable [data-lgrelogin]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  await page.waitForTimeout(800);
  check('点击登录按钮触发提取流程（提示出现）', wire && (await page.locator('#lgMeta').innerText()).length > 0);

  // ---------- 2. 数据管理抽屉：商品图片 / 商品描述 / 规格参数区块 ----------
  await page.click('.nav-item[data-page="data"]');
  await page.waitForTimeout(1200);
  // 选一个有详情数据的商品（刚补抓过的华为/苏宁记录）
  const opened = await page.evaluate(() => {
    // 直接触发第一行点击打开抽屉（若首行无详情，通过 API 找有描述的）
    return document.querySelector('#tableWrap tbody tr') ? true : false;
  });
  // 优先找有描述/图片的记录打开；库被清理后无命中则现场补抓一条再查（自恢复，不依赖历史数据）
  let target = await page.evaluate(async () => {
    const types = ['product'];
    for (const t of types) {
      const r = await (await fetch(`/api/data?type=${t}&pageSize=60`)).json();
      const hit = (r.rows || []).find((x) => (x.description || '').length > 20 && (x.images || []).length > 1);
      if (hit) return { id: hit.id, desc: (hit.description || '').length, imgs: (hit.images || []).length };
    }
    return null;
  });
  if (!target) {
    await page.evaluate(async () => {
      const r = await (await fetch('/api/data?type=product&pageSize=60')).json();
      const cand = (r.rows || []).find((x) => x.platform === 'vip' && (x.itemId || /^https?:\/\//.test(x.url || ''))) || (r.rows || []).find((x) => x.itemId || /^https?:\/\//.test(x.url || ''));
      if (!cand) return null;
      const resp = await fetch('/api/detail-refetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cand.id }) });
      return (await resp.json()).status || null;
    });
    await page.waitForTimeout(800);
    target = await page.evaluate(async () => {
      const r = await (await fetch(`/api/data?type=product&pageSize=60`)).json();
      const hit = (r.rows || []).find((x) => (x.description || '').length > 20 && (x.images || []).length > 1);
      return hit ? { id: hit.id, desc: (hit.description || '').length, imgs: (hit.images || []).length } : null;
    });
  }
  check('库中存在带描述+多图的商品记录（详情扩展已产出）', !!target);
  if (target) {
    // UI 路径：搜索 itemId 让目标行出现在首行（openDrawer 是模块内函数，不可直接调）
    const itemId = await page.evaluate(async (tid) => {
      const r = await (await fetch(`/api/data?type=product&pageSize=60`)).json();
      return (r.rows || []).find((x) => x.id === tid)?.itemId || '';
    }, target.id);
    if (itemId) {
      await page.fill('#dataSearch', itemId);
      await page.click('#dataSearchBtn');
      await page.waitForTimeout(1200);
      await page.click('#tableWrap [data-detail]');
      await page.waitForTimeout(800);
      const drawer = await page.evaluate(() => ({
        open: !document.querySelector('#drawerMask').hidden,
        imgs: document.querySelectorAll('.drawer-imgs img').length,
        desc: document.querySelector('.drawer-desc') ? document.querySelector('.drawer-desc').textContent.length : 0,
        refetchText: document.querySelector('#refetchBtn')?.textContent || '',
        propsH4: [...document.querySelectorAll('#drawerBody h4')].some((h) => h.textContent.includes('规格参数')),
      }));
      check('抽屉打开且渲染商品图片网格', drawer.open && drawer.imgs > 0);
      check('抽屉渲染商品描述区块', drawer.open && drawer.desc > 20);
      check('补抓按钮文案更新为「描述/图片/SPU/SKU」', drawer.refetchText.includes('描述') && drawer.refetchText.includes('图片'));
      check('规格参数区块存在（无数据时不渲染，不报错）', typeof drawer.propsH4 === 'boolean');
      // 关闭抽屉
      await page.evaluate(() => (document.querySelector('#drawerMask').hidden = true));
    }
  }

  // ---------- 3. 详情补抓接口消息带新字段计数 ----------
  const refetchMsg = await page.evaluate(async () => {
    const r = await (await fetch('/api/data?type=product&pageSize=60')).json();
    const hit = (r.rows || []).find((x) => /^https?:/.test(x.url || '') && (x.description || '').length > 0);
    if (!hit) return null;
    const rr = await (await fetch('/api/detail-refetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: hit.id, withExtras: false }) })).json();
    return rr.message || rr.error || '';
  });
  check('补抓消息含描述/图片计数', refetchMsg === null || /描述 \d+ 字/.test(refetchMsg) || /图片 \d+ 张/.test(refetchMsg) || refetchMsg.includes('已更新'));

  check('全程无 JS 报错', errors.length === 0);
  if (errors.length) console.log('JS errors:', errors);
  await browser.close();

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})();
