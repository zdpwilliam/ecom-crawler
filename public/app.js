// 仪表盘前端逻辑（原生 JS，无构建依赖）
const $ = (s) => document.querySelector(s);

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    // 优先展示服务器返回的真实错误信息（而非干巴巴的状态码）
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
      else if (j && j.reason) msg = j.reason;
    } catch {}
    if (res.status === 404 && !msg.includes('VPN')) {
      msg += ' —— 接口不存在。若反复出现：可能是 VPN/系统代理拦截了 localhost 请求，请改用 http://127.0.0.1:4311 访问，或在 VPN 里把 localhost/127.0.0.1 加入直连白名单后按 Ctrl+F5 刷新页面。';
    }
    throw new Error(msg);
  }
  return res;
}
async function apiJson(path, opts) {
  return api(path, opts).then((r) => r.json());
}
function esc(s) {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

let currentType = 'product';

// ---------- 页面路由（侧边导航） ----------
const PAGES = ['collect', 'data', 'jobs', 'settings'];
function showPage(name) {
  if (!PAGES.includes(name)) name = 'collect';
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${name}`));
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === name));
  if (location.hash !== `#/${name}`) history.replaceState(null, '', `#/${name}`);
  // 数据页每次进入都刷新（数据可能被采集/清空过）
  if (name === 'data') renderTable(currentType, true);
  if (name === 'jobs') {
    loadJobs();
    loadRuns();
  }
  // 系统设置页：进入即刷新平台登录状态表
  if (name === 'settings') loadLoginStatus();
}

// ---------- 平台能力元数据（联动信息卡用） ----------
const PLATFORM_META = {
  vip: { direct: 'rank/list 直连 + 详情接口（需登录态）', login: '必需' },
  huawei: { direct: '搜索+详情 全链路直连（匿名）', login: '不需要' },
  suning: { direct: '搜索 SSR + 批量价格 + 详情直连', login: '不需要' },
  amazon: { direct: '搜索+详情 全直连（SSR 解析）', login: '不需要' },
  taobao: { direct: 'mtop 签名直连', login: '必需' },
  xianyu: { direct: 'mtop 签名直连', login: '必需' },
  jd: { direct: '详情 SSR 直连（价格/规格）；搜索需登录态浏览器', login: '推荐' },
  pdd: { direct: '无直连（anti-content 强签名）', login: '必需' },
  dewu: { direct: '无直连，浏览器渲染', login: '推荐' },
};

// 平台联动信息卡：随平台选择实时展示 直连能力 / 登录态 / 代理池 三项状态
async function updatePlatCard() {
  const platform = $('#platform').value;
  const card = $('#platCard');
  if (!platform) {
    card.innerHTML = '<span class="muted">请选择平台查看联动信息。</span>';
    return;
  }
  const meta = PLATFORM_META[platform] || { direct: '浏览器渲染', login: '—' };
  card.innerHTML = `<span class="badge"><b>${esc($('#platform').selectedOptions[0]?.textContent || platform)}</b></span>
    <span class="badge">直连通道：${esc(meta.direct)}</span>
    <span id="pcLogin" class="badge">登录态：检测中…</span>
    <span id="pcProxy" class="badge">代理池：…</span>`;
  // 登录态检测（异步，不阻塞卡片其余内容）
  try {
    const c = await apiJson('/api/cookies');
    const has = (c.files || []).some((f) => f.startsWith(platform));
    const el = $('#pcLogin');
    if (el) {
      el.className = `badge ${has ? 'ok' : 'off'}`;
      el.innerHTML = `<span class="dot"></span>登录态：${has ? '已有（采集自动注入）' : `无${meta.login === '必需' ? ' · 该平台必需，请到系统设置提取' : meta.login === '推荐' ? ' · 建议提取' : ''}`}`;
    }
  } catch {
    const el = $('#pcLogin');
    if (el) el.textContent = '登录态：检测失败';
  }
  try {
    const p = await apiJson('/api/proxy');
    const okCount = p.proxies.filter((x) => x.cooldownUntil <= Date.now()).length;
    const el = $('#pcProxy');
    if (el) el.className = `badge ${okCount ? 'ok' : 'off'}`;
    if (el) el.textContent = `代理池：${okCount}/${p.poolSize} 可用`;
  } catch {
    const el = $('#pcProxy');
    if (el) el.textContent = '代理池：加载失败';
  }
}

// 数据类型联动：切换类型时同步 查询词标签/占位符 与 详情选项可见性
function syncDataTypeUi() {
  const t = $('#dataType').value;
  const label = $('#queryLabel');
  const q = $('#query');
  if (t === 'review' || t === 'qa') {
    label.childNodes[0].textContent = '商品链接或 ItemId ';
    q.placeholder = '如：https://item.jd.com/… 或 100012043978';
    $('#withDetailsWrap').hidden = true;
  } else {
    label.childNodes[0].textContent = '查询词 / ItemId ';
    q.placeholder = '如：手机 / item_123';
    $('#withDetailsWrap').hidden = false;
  }
  syncDetailLimitUi();
}
function syncDetailLimitUi() {
  const show = $('#dataType').value === 'product' && $('#withDetails').checked;
  $('#detailLimitWrap').hidden = !show;
}
// 定时任务表单：仅「商品类型 + 勾选带详情」时显示详情数
function syncJobDetailLimitUi() {
  const show = $('#jobType').value === 'product' && $('#jobDetails').checked;
  if ($('#jobDetailLimitWrap')) $('#jobDetailLimitWrap').hidden = !show;
}

async function loadPlatforms() {
  const list = await apiJson('/api/platforms');
  const opts = list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  // 平台选择全局联动：采集 / 诊断 / 登录态提取 / 数据管理筛选 / 手动保存登录信息 共用一套平台清单
  $('#platform').innerHTML = opts;
  $('#jobPlatform').innerHTML = opts;
  $('#dataPlatform').innerHTML = '<option value="">全部平台</option>' + opts;
  const lgSel = $('#lgPlatform');
  if (lgSel) lgSel.innerHTML = opts; // 手动保存登录信息下拉（index.html 里的静态 option 仅作首帧兜底）
}

// ---------- 采集过程日志（滚动展示） ----------
const runLogState = { last: -1, timer: null };

function logLine(l) {
  const box = $('#runLog');
  const div = document.createElement('div');
  div.textContent = `[${l.t}] ${l.msg}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function startRunLogPolling() {
  const box = $('#runLog');
  box.hidden = false;
  box.innerHTML = '';
  runLogState.last = -1;
  clearInterval(runLogState.timer);
  runLogState.timer = setInterval(async () => {
    try {
      const d = await apiJson(`/api/logs?since=${runLogState.last}`);
      (d.lines || []).forEach(logLine);
      runLogState.last = d.last;
    } catch {}
  }, 1000);
}

function stopRunLogPolling() {
  // 结束后再多拉 1.5 秒，把收尾日志收全
  clearInterval(runLogState.timer);
  runLogState.timer = setTimeout(async () => {
    try {
      const d = await apiJson(`/api/logs?since=${runLogState.last}`);
      (d.lines || []).forEach(logLine);
      runLogState.last = d.last;
    } catch {}
  }, 1500);
}

async function loadStats() {
  const s = await apiJson('/api/stats');
  $('#stats').innerHTML = `
    <span>商品 <b>${s.product}</b></span>
    <span>评论 <b>${s.review}</b></span>
    <span>问答 <b>${s.qa}</b></span>`;
  return s;
}

// 数据变化自动感知：轮询统计数，只要库里有增删（面板采集/命令行/定时任务/外部触发），
// 就自动刷新顶部统计与底部数据表格，页面不用手动刷新。
let lastStatsKey = null;
async function pollStats() {
  try {
    const s = await apiJson('/api/stats');
    const key = JSON.stringify(s);
    if (lastStatsKey !== null && key !== lastStatsKey) {
      loadStats();
      if (!drawerOpen) renderTable(currentType, true); // 抽屉打开时不打断阅读；其余情况刷新当前视图
    }
    lastStatsKey = key;
  } catch {}
}

async function runCollect() {
  const platform = $('#platform').value;
  if (!platform) {
    $('#runResult').textContent = '请先选择具体平台再运行采集。';
    return;
  }
  const body = {
    platform,
    dataType: $('#dataType').value,
    strategy: $('#strategy').value,
    query: $('#query').value,
    limit: Number($('#limit').value),
    withDetails: $('#withDetails').checked,
    detailLimit: Number($('#detailLimit').value),
  };
  $('#runResult').textContent = '采集中…（下方日志实时滚动展示采集过程）';
  $('#runBtn').disabled = true;
  $('#stopBtn').hidden = false;
  $('#stopBtn').disabled = false;
  startRunLogPolling();
  try {
    const r = await apiJson('/api/collect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#runResult').textContent =
      r.status === 'stopped' ? '⏹ 已手动停止采集。' + (r.message || '') : JSON.stringify(r, null, 2);
    // 采集成功联动：提示一键跳转数据管理页（自动带上平台筛选）
    if (r.status !== 'stopped' && r.count > 0) {
      $('#runResult').innerHTML =
        `<span style="font-family:inherit">本次入库 ${r.count} 条（${esc(platform)}）。</span> ` +
        `<button id="jumpData" class="btn-ghost" style="padding:3px 10px">查看采集结果 →</button>`;
      $('#jumpData').addEventListener('click', () => {
        $('#dataPlatform').value = platform;
        pager.page = 1;
        $('#dataSearch').value = '';
        showPage('data');
      });
    }
    await loadStats();
    renderTable(body.dataType, true);
  } catch (e) {
    $('#runResult').textContent = '错误：' + e.message;
  } finally {
    stopRunLogPolling();
    $('#runBtn').disabled = false;
    $('#stopBtn').hidden = true;
  }
}

// 手动停止采集：服务端置位停止标志，当前网络请求完成后不再继续（已入库数据保留）
async function stopCollect() {
  $('#stopBtn').disabled = true;
  $('#runResult').textContent = '正在停止…（当前网络请求完成后不再继续，已入库数据保留）';
  try {
    await apiJson('/api/collect/stop', { method: 'POST' });
  } catch (e) {
    $('#runResult').textContent = '停止指令发送失败：' + e.message;
    $('#stopBtn').disabled = false;
  }
}

// 采集配置 → 定时任务联动：把当前工作台配置带入任务表单并跳转
function saveAsJob() {
  const platform = $('#platform').value;
  if (!platform) {
    $('#runResult').textContent = '请先选择平台再保存为定时任务。';
    return;
  }
  const type = $('#dataType').value;
  $('#jobPlatform').value = platform;
  $('#jobType').value = type;
  $('#jobQuery').value = $('#query').value;
  $('#jobLimit').value = $('#limit').value;
  $('#jobDetails').checked = type === 'product' ? $('#withDetails').checked : false;
  if ($('#jobDetailLimit')) $('#jobDetailLimit').value = $('#detailLimit').value || 3;
  syncJobDetailLimitUi();
  showPage('jobs');
  $('#jobResult').textContent = '已从采集工作台带入当前配置，确认参数后点「添加任务」。';
}

// ---------- 定时任务 ----------
async function loadJobs() {
  const jobs = await apiJson('/api/jobs');
  const rows = jobs
    .map(
      (j) => `<tr>
      <td>${esc(j.id)}</td><td>${esc(j.platform)}</td><td>${esc(j.dataType)}</td>
      <td>${esc(j.query || '')}</td><td>${j.everyMinutes}</td>
      <td>${j.withDetails ? `是（评论+问答+SPU/SKU，详情前 ${j.detailLimit || 3} 个）` : '否'}</td><td>${j.enabled ? '✅' : '⛔'}</td>
      <td>
        <button data-run="${esc(j.id)}">运行</button>
        <button data-del="${esc(j.id)}">删除</button>
      </td></tr>`
    )
    .join('');
  $('#jobTable').innerHTML =
    `<thead><tr><th>ID</th><th>平台</th><th>类型</th><th>查询</th><th>周期(分)</th><th>带详情</th><th>启用</th><th>操作</th></tr></thead><tbody>${rows || '<tr><td colspan="8">暂无任务</td></tr>'}</tbody>`;
  $('#jobTable').querySelectorAll('[data-run]').forEach((b) =>
    b.addEventListener('click', () => runJob(b.dataset.run))
  );
  $('#jobTable').querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', () => delJob(b.dataset.del))
  );
}

async function loadRuns() {
  const runs = await apiJson('/api/jobs/runs');
  const rows = runs
    .map(
      (r) => `<tr><td>${esc(r.job_id)}</td><td>${esc(r.platform)}</td><td>${esc(r.data_type)}</td>
      <td>${esc(r.status)}</td><td>${r.count}</td><td>${esc((r.message || '').slice(0, 40))}</td>
      <td>${esc(fmtTime(r.finished_at))}</td></tr>`
    )
    .join('');
  $('#runTable').innerHTML =
    `<thead><tr><th>任务</th><th>平台</th><th>类型</th><th>状态</th><th>条数</th><th>信息</th><th>完成时间</th></tr></thead><tbody>${rows || '<tr><td colspan="7">暂无运行记录</td></tr>'}</tbody>`;
}

async function addJob() {
  const body = {
    platform: $('#jobPlatform').value,
    dataType: $('#jobType').value,
    query: $('#jobQuery').value,
    everyMinutes: Number($('#jobEvery').value),
    limit: Number($('#jobLimit').value),
    withDetails: $('#jobDetails').checked,
    detailLimit: Number($('#jobDetailLimit')?.value) || 3,
    enabled: $('#jobEnabled').checked,
  };
  $('#jobResult').textContent = '添加中…';
  try {
    const r = await apiJson('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#jobResult').textContent = '已添加：' + JSON.stringify(r);
    await loadJobs();
  } catch (e) {
    $('#jobResult').textContent = '错误：' + e.message;
  }
}

async function runJob(id) {
  try {
    const r = await apiJson('/api/jobs/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    $('#jobResult').textContent = '运行结果：' + JSON.stringify(r);
    await loadRuns();
    await loadStats();
  } catch (e) {
    $('#jobResult').textContent = '错误：' + e.message;
  }
}

async function delJob(id) {
  try {
    await api(`/api/jobs?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadJobs();
  } catch (e) {
    $('#jobResult').textContent = '错误：' + e.message;
  }
}

// ---------- 代理池 & Cookie ----------
// 最近一次测速结果（proxy -> {ok, ms, error}），渲染列表时展示
let lastTest = {};

async function loadProxy() {
  try {
    const p = await apiJson('/api/proxy');
    const bad = p.proxies.filter((x) => x.cooldownUntil > Date.now()).length;
    $('#proxyInfo').textContent = `代理池：共 ${p.poolSize} 个（冷却中 ${bad} 个）`;
    const rows = p.proxies
      .map((x) => {
        const t = lastTest[x.proxy];
        let speed, status;
        if (t) {
          speed = t.ok ? `✅ ${t.ms}ms` : '❌ 失败';
          status = t.ok ? (x.failures > 0 ? `成功(此前失败${x.failures}次)` : '正常') : esc(t.error || '失败');
        } else {
          speed = x.lastLatencyMs != null ? x.lastLatencyMs + 'ms' : '未测速';
          status = x.cooldownUntil > Date.now() ? '❄️冷却' : x.failures > 0 ? `失败${x.failures}次` : '正常';
        }
        return `<tr><td>${esc(x.proxy)}</td><td>${speed}</td><td>${status}</td><td><button data-delproxy="${esc(x.proxy)}" class="btn-danger" style="padding:2px 8px">删除</button></td></tr>`;
      })
      .join('');
    $('#proxyList').innerHTML = p.proxies.length
      ? `<table><thead><tr><th>代理</th><th>测速</th><th>状态</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table>`
      : '代理池为空：直连本机 IP 抓取。建议添加 VPN 本地端口或代理服务，避免家庭 IP 直接暴露。';
    $('#proxyList')
      .querySelectorAll('[data-delproxy]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          if (!confirm(`删除代理 ${b.dataset.delproxy}？`)) return;
          await api(`/api/proxy?proxy=${encodeURIComponent(b.dataset.delproxy)}`, { method: 'DELETE' });
          delete lastTest[b.dataset.delproxy];
          await loadProxy();
        })
      );
  } catch (e) {
    $('#proxyInfo').textContent = '代理池加载失败：' + e.message;
  }
}
async function addProxyUi() {
  let proxy = $('#proxyInput').value.trim();
  if (!proxy) {
    alert('请先填写代理地址，如 127.0.0.1:7890');
    return;
  }
  // 自动补协议头：127.0.0.1:7890 → http://127.0.0.1:7890
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) proxy = 'http://' + proxy;
  try {
    const r = await apiJson('/api/proxy/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxy }),
    });
    $('#proxyInput').value = '';
    await loadProxy();
    if (r.added === false) {
      alert('该代理已在池中，无需重复添加。');
    } else {
      // 添加成功后自动测一次速，立即反馈可用性
      $('#proxyInfo').textContent = '已添加，测速中…（最多 6 秒）';
      try {
        const t = await apiJson('/api/proxy/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        (t.results || []).forEach((x) => (lastTest[x.proxy] = x));
      } catch {}
      await loadProxy();
    }
  } catch (e) {
    alert('添加失败：' + e.message);
  }
}
async function testProxiesUi() {
  if (!Number((await apiJson('/api/proxy')).poolSize)) {
    $('#proxyInfo').textContent = '代理池为空，无可测速的代理。请先添加。';
    return;
  }
  $('#proxyInfo').textContent = '测速中…（每条最多 6 秒，测完自动展示每条延迟/失败原因）';
  try {
    const r = await apiJson('/api/proxy/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    lastTest = {};
    (r.results || []).forEach((x) => (lastTest[x.proxy] = x));
    await loadProxy();
    const ok = r.results.filter((x) => x.ok);
    const fail = r.results.filter((x) => !x.ok);
    let summary = `测速完成：${ok.length}/${r.results.length} 条可用`;
    if (ok.length) summary += `，延迟 ${Math.min(...ok.map((x) => x.ms))}-${Math.max(...ok.map((x) => x.ms))}ms`;
    if (fail.length) summary += `；失败 ${fail.length} 条（原因见列表，常见：VPN 未运行 / 端口填错 / 代理需要认证）`;
    $('#proxyInfo').textContent = summary;
  } catch (e) {
    $('#proxyInfo').textContent = '测速失败：' + e.message;
  }
}
// 一键提取登录态核心：服务端拉起系统 Chrome，用户登录后 cookie-tool 自动保存。
// 抽成可复用：系统设置「提取登录态」按钮与登录状态表「重新登录」按钮共用。
function launchCookieExtract(platform, statusEl, onSaved) {
  statusEl.textContent = '正在弹出浏览器…（约需 2~5 秒）';
  let baseline;
  (async () => {
    try {
      // 基线用「条数:mtime」指纹而非文件名列表：重登场景下同名文件被重新保存也能感知
      baseline = JSON.stringify((await apiJson('/api/cookies')).fingerprint || {});
      await apiJson('/api/cookies/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      statusEl.textContent = `浏览器已弹出：请在窗口内登录「${platform}」，登录成功后自动保存（10 分钟内有效）。保存后自动重测并刷新本表。`;
    } catch (e) {
      statusEl.textContent = '启动失败：' + e.message;
      return;
    }
    // 轮询 Cookie 指纹：文件内容变化（新文件 / 同名文件重新保存）即认为保存成功
    const t0 = Date.now();
    const timer = setInterval(async () => {
      try {
        const c = await apiJson('/api/cookies');
        if (JSON.stringify(c.fingerprint || c.files) !== baseline) {
          clearInterval(timer);
          statusEl.textContent = `✅ ${platform} 登录态已保存，正在重新检测有效性…`;
          // 联动：登录态变化后刷新工作台平台信息卡（若当前平台一致）
          if ($('#platform').value === platform) updatePlatCard();
          if (onSaved) await onSaved(platform);
          return;
        }
        if (Date.now() - t0 > 600000) {
          clearInterval(timer);
          statusEl.textContent = '等待超时（10 分钟）未检测到保存。若已登录仍未保存，请重试一次。';
          return;
        }
      } catch {}
    }, 3000);
  })();
}

// 登录状态表「重新登录」：对失效/缺失的平台直接弹出浏览器重登，保存后自动重测
function reloginUi(platform) {
  // 联动工作台平台下拉（保证全局平台一致）
  if ([...$('#platform').options].some((o) => o.value === platform)) $('#platform').value = platform;
  // 若用户在系统设置页，滚动到登录状态面板顶部，让状态文字可见
  launchCookieExtract(platform, $('#lgMeta'), async (p) => {
    await loadLoginStatus();
    checkLoginUi(p);
  });
}

// ---------- 登录态内容查看弹窗 ----------
let ckModalData = [];

async function viewCookies(platform) {
  const p = platform || 'vip';
  $('#ckModalTitle').textContent = `（${p}）`;
  $('#cookieModal').hidden = false;
  const body = $('#ckModalBody');
  body.textContent = '加载中…';
  try {
    const r = await apiJson(`/api/cookies/view?platform=${encodeURIComponent(p)}`);
    ckModalData = r.cookies || [];
    const rows = ckModalData
      .map((c, i) => {
        let exp = '会话';
        if (c.expires != null && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
          const d = new Date(Number(c.expires) * 1000);
          exp = isNaN(d.getTime()) ? String(c.expires) : fmtTime(d.toISOString());
        }
        return `<tr><td>${i + 1}</td><td><code>${esc(c.name)}</code></td><td class="ck-val" title="${esc(c.value)}">${esc(
          c.value.length > 70 ? c.value.slice(0, 70) + '…' : c.value
        )}</td><td>${esc(c.domain || '')}</td><td>${exp}</td></tr>`;
      })
      .join('');
    body.innerHTML =
      `<p class="count">文件：${esc(r.file)} ｜ 共 ${r.count} 条 ｜ 采集时自动注入全部条目</p>` +
      `<table><thead><tr><th>#</th><th>名称</th><th>值（悬停看全文）</th><th>域</th><th>有效期至</th></tr></thead><tbody>${rows}</tbody></table>`;
  } catch (e) {
    body.textContent = '加载失败：' + e.message;
    ckModalData = [];
  }
}

async function copyCookiesJson() {
  if (!ckModalData.length) {
    alert('暂无可复制的 Cookie 内容。');
    return;
  }
  const text = JSON.stringify(ckModalData, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    alert(`已复制 ${ckModalData.length} 条 Cookie 的 JSON 到剪贴板。`);
  } catch {
    // 剪贴板权限受限时的兜底：下载为文件
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cookies.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// ---------- 平台登录状态（系统设置） ----------
const LOGIN_STATUS_TEXT = {
  valid: '已登录 · 有效',
  invalid: '已失效',
  probable: '疑似有效（未实测）',
  expired: 'Cookie 已全部过期',
  absent: '未登录（无 Cookie）',
  unknown: '无法判定',
  none: '无需登录',
};

function loginBadgeCls(status) {
  if (status === 'valid') return 'ok';
  if (status === 'none') return '';
  return 'off';
}

async function loadLoginStatus() {
  const box = $('#loginTable');
  const meta = $('#lgMeta');
  try {
    const d = await apiJson('/api/login/status');
    const rows = Object.values(d.results || {});
    meta.textContent = `上次检测：${d.at ? fmtTime(d.at) : '尚未检测'} ｜ 定时检测：${d.intervalMin > 0 ? `每 ${d.intervalMin} 分钟` : '已关闭'}`;
    const trs = rows
      .map((r) => {
        const need = r.needLogin === '必需' ? '<b style="color:#9a3412">必需</b>' : r.needLogin === '推荐' ? '推荐' : '不需要';
        const cookie =
          r.count > 0
            ? `<a href="javascript:void(0)" class="ck-link" data-ckview="${esc(r.platform)}" title="点击查看 Cookie 明细">${r.count} 条（过期 ${r.expired}）</a>`
            : '<span class="muted">无</span>';
        const statusCell = `<span class="badge ${loginBadgeCls(r.status)}"><span class="dot"></span>${esc(LOGIN_STATUS_TEXT[r.status] || r.status)}</span>`;
        // 所有平台都提供登录入口：即使「不需要登录」的平台，评论/问答等详情数据也常要求登录后才能拿到
        // 布局：第一行 [🔑登录 …… 检测]（两端对齐，检测在右），第二行 [🌐 当前浏览态]
        const ops = `<div style="display:flex;flex-direction:column;gap:4px">
             <div style="display:flex;gap:6px;align-items:center">
               <button data-lgrelogin="${esc(r.platform)}" class="btn-ghost btn-sm">🔑 ${r.count > 0 ? '重新登录' : '登录'}</button>
               <button data-lgcheck="${esc(r.platform)}" style="padding:2px 10px;margin-left:auto">检测</button>
             </div>
             <button data-lgbrowser="${esc(r.platform)}" class="btn-ghost btn-sm" title="headless 读取提取浏览器档案的实时登录态并弹窗展示（已登录则同步为采集用快照，约 10~40 秒）">🌐 当前浏览态</button>
           </div>`;
        return `<tr>
        <td>${esc(r.platform)}</td><td>${need}</td><td>${cookie}</td>
        <td>${statusCell}</td>
        <td class="lg-detail" title="${esc(r.detail || '')}">${esc(r.detail || '')}</td>
        <td>${r.checkedAt ? timeCell(r.checkedAt) : '<span class="muted">—</span>'}</td>
        <td>${ops}</td>
      </tr>`;
      })
      .join('');
    box.innerHTML =
      `<table><thead><tr><th>平台</th><th>需要登录</th><th>已存 Cookie</th><th>登录状态</th><th>说明</th><th>检测时间</th><th>操作</th></tr></thead><tbody>${trs}</tbody></table>`;
    box.querySelectorAll('[data-lgcheck]').forEach((b) => b.addEventListener('click', () => checkLoginUi(b.dataset.lgcheck)));
    box.querySelectorAll('[data-lgrelogin]').forEach((b) => b.addEventListener('click', () => reloginUi(b.dataset.lgrelogin)));
    box.querySelectorAll('[data-lgbrowser]').forEach((b) => b.addEventListener('click', () => checkBrowserUi(b.dataset.lgbrowser)));
    // 已存 Cookie 列：点击唤起 Cookie 明细弹窗
    box.querySelectorAll('[data-ckview]').forEach((a) => a.addEventListener('click', () => viewCookies(a.dataset.ckview)));
  } catch (e) {
    meta.textContent = '登录状态加载失败：' + e.message;
  }
}

async function checkLoginUi(platform) {
  const meta = $('#lgMeta');
  // 行内反馈：该行状态列切「检测中」，按钮禁用，其余行不受影响
  const btn = box_queryLoginBtn(platform);
  const row = btn ? btn.closest('tr') : null;
  const statusCell = row ? row.cells[3] : null;
  const detailCell = row ? row.cells[4] : null;
  const oldStatusCell = statusCell ? statusCell.innerHTML : '';
  if (btn) btn.disabled = true;
  if (statusCell) statusCell.innerHTML = '<span class="badge"><span class="dot" style="background:#b45309"></span>检测中…</span>';
  if (detailCell) detailCell.textContent = '正在发真实请求验证该平台登录态，约需数秒到数十秒…';
  meta.textContent = `正在检测 ${platform} 登录态（真实请求验证，约需数秒到数十秒）…`;
  try {
    const r = await apiJson('/api/login/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform }),
    });
    meta.textContent = `${platform} 检测完成：${LOGIN_STATUS_TEXT[r.status] || r.status}${r.detail ? ` · ${r.detail}` : ''}`;
    if (statusCell) {
      statusCell.innerHTML = `<span class="badge ${loginBadgeCls(r.status)}"><span class="dot"></span>${esc(LOGIN_STATUS_TEXT[r.status] || r.status)}</span>`;
      if (detailCell) detailCell.textContent = r.detail || '';
    } else {
      await loadLoginStatus();
    }
    if ($('#platform').value === platform) updatePlatCard();
  } catch (e) {
    meta.textContent = `检测失败：${e.message}`;
    if (statusCell) statusCell.innerHTML = oldStatusCell;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 「🌐 当前浏览态」：headless 读取提取浏览器档案中该平台的实时登录态，弹窗展示获取到的登录数据
async function checkBrowserUi(platform) {
  const meta = $('#lgMeta');
  const btn = box_queryLoginBtn(platform, 'data-lgbrowser');
  const row = btn ? btn.closest('tr') : null;
  const statusCell = row ? row.cells[3] : null;
  if (btn) btn.disabled = true;
  if (statusCell) statusCell.innerHTML = '<span class="badge"><span class="dot" style="background:#b45309"></span>读取浏览器档案中…</span>';
  meta.textContent = `正在 headless 读取 ${platform} 的提取浏览器档案（约 10~40 秒，请勿同时对该平台点「🔑登录」）…`;
  try {
    const r = await apiJson('/api/login/check-browser', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform }),
    });
    const textMap = { 'logged-in': '已登录', guest: '游客态（档案内无登录 Cookie）', uncertain: '疑似登录但未确认', 'no-profile': '暂无浏览器档案（请先🔑登录）', unsupported: '该平台暂不支持浏览态判定', error: '读取失败' };
    meta.textContent = `${platform} 当前浏览态：${textMap[r.status] || r.status}${r.detail ? ` · ${r.detail}` : ''}`;
    // 弹窗展示获取到的登录数据（复用 Cookie 明细弹窗外壳）
    const modal = $('#cookieModal');
    $('#ckModalTitle').textContent = `当前浏览态（${platform}）`;
    modal.hidden = false;
    const body = $('#ckModalBody');
    const cookies = Array.isArray(r.cookies) ? r.cookies : [];
    ckModalData = cookies;
    if (r.status === 'no-profile' || r.status === 'unsupported' || r.status === 'error') {
      body.innerHTML = `<p class="count">${esc(r.detail || textMap[r.status] || '')}</p>`;
    } else {
      const rows = cookies
        .map((c, i) => {
          let exp = '会话';
          if (c.expires != null && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
            const d = new Date(Number(c.expires) * 1000);
            exp = isNaN(d.getTime()) ? String(c.expires) : fmtTime(d.toISOString());
          }
          return `<tr><td>${i + 1}</td><td><code>${esc(c.name)}</code></td><td class="ck-val" title="${esc(c.value)}">${esc(String(c.value).slice(0, 26))}${String(c.value).length > 26 ? '…' : ''}</td><td>${esc(c.domain || '')}</td><td>${exp}</td></tr>`;
        })
        .join('');
      body.innerHTML =
        `<p class="count">档案内实时读取到 <b>${cookies.length}</b> 条 Cookie ｜ 判定：<b>${esc(textMap[r.status] || r.status)}</b>${r.saved ? ' ｜ <b>已同步为采集用快照</b>' : ''}<br/><span class="muted">${esc(r.detail || '')}</span></p>` +
        (cookies.length
          ? `<table><thead><tr><th>#</th><th>名称</th><th>值（悬停看全文）</th><th>域</th><th>有效期</th></tr></thead><tbody>${rows}</tbody></table>`
          : '');
    }
    await loadLoginStatus();
  } catch (e) {
    meta.textContent = `浏览态读取失败：${e.message}`;
    await loadLoginStatus();
  } finally {
    if (btn) btn.disabled = false;
  }
}

function box_queryLoginBtn(platform, attr = 'data-lgcheck') {
  return document.querySelector(`#loginTable [${attr}="${platform}"]`);
}

async function checkAllLoginUi() {
  const meta = $('#lgMeta');
  meta.textContent = '正在全量检测所有平台（逐个发真实请求，约需 1~3 分钟）…';
  $('#lgCheckAll').disabled = true;
  try {
    await apiJson('/api/login/check-all', { method: 'POST' });
    meta.textContent = '全量检测完成。';
    await loadLoginStatus();
    updatePlatCard();
  } catch (e) {
    meta.textContent = '全量检测失败：' + e.message;
  } finally {
    $('#lgCheckAll').disabled = false;
  }
}

async function saveLoginInterval() {
  const v = Number($('#lgInterval').value);
  if (!Number.isFinite(v) || v < 0) {
    $('#lgMeta').textContent = '间隔需为 ≥0 的整数分钟（0=关闭定时检测）。';
    return;
  }
  try {
    await apiJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginCheckMin: v }),
    });
    $('#lgMeta').textContent = v > 0 ? `已保存：每 ${v} 分钟自动检测一次登录态（立即生效）。` : '已保存：定时检测已关闭。';
    await loadLoginStatus();
  } catch (e) {
    $('#lgMeta').textContent = '保存失败：' + e.message;
  }
}

async function saveLoginCookie() {
  const platform = $('#lgPlatform').value;
  const raw = $('#lgCookieJson').value.trim();
  const box = $('#lgSaveResult');
  box.hidden = false;
  if (!raw) {
    box.textContent = '请先粘贴 Cookie JSON（数组格式）。';
    return;
  }
  let cookies;
  try {
    cookies = JSON.parse(raw);
  } catch (e) {
    box.textContent = 'JSON 解析失败：' + e.message;
    return;
  }
  box.textContent = '保存中…';
  try {
    const r = await apiJson('/api/login/save-cookie', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, cookies }),
    });
    box.textContent =
      `✅ 已保存 ${r.count} 条 Cookie 到 data/cookies/${platform}.json。\n` +
      `登录状态：${LOGIN_STATUS_TEXT[r.login?.status] || r.login?.status}\n${r.login?.detail || ''}`;
    $('#lgCookieJson').value = '';
    await loadLoginStatus();
    if ($('#platform').value === platform) updatePlatCard();
  } catch (e) {
    box.textContent = '保存失败：' + e.message;
  }
}

// ---------- 一键测试（采集前体检，弹框交互） ----------
// 按当前工作台配置（平台/数据类型/查询词/ItemId）发真实请求，弹框逐步展示：
// 最终链接 → 运行状态日志 → 响应内容 → 提取后的结构化数据，并支持逐步「字段诊断」。
let testRunning = false;

function testStepIcon(s) {
  return s.ok ? '✅' : (s.detail || '').startsWith('跳过') || (s.detail || '').startsWith('该平台暂未') ? '⏭' : '❌';
}

async function runDiagnoseInline(preEl, platform, url, kind) {
  preEl.hidden = false;
  preEl.textContent = '字段诊断中…（拉取页面并核对每个字段的选择器命中）';
  try {
    const r = await apiJson('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, url, kind }),
    });
    if (!r.ok) {
      preEl.textContent = '诊断失败：' + (r.reason || r.error || '未知原因');
      return;
    }
    const fieldRows = (r.fields || [])
      .map((f) => `<tr><td>${esc(f.field)}</td><td><code>${esc(f.selector)}</code></td><td>${f.matched}</td><td>${esc((f.sample || []).join(' ｜ ').slice(0, 60) || '—')}</td></tr>`)
      .join('');
    preEl.innerHTML =
      `<p style="margin:0 0 6px">页面 ${(r.htmlSize / 1024).toFixed(0)}KB ｜ 可用策略：${esc(r.strategy)} ｜ 建议：${esc(r.advice)}</p>` +
      `<table><thead><tr><th>字段</th><th>选择器</th><th>命中</th><th>样例</th></tr></thead><tbody>${fieldRows}</tbody></table>`;
  } catch (e) {
    preEl.textContent = '诊断失败：' + e.message;
  }
}

async function runTestUi() {
  if (testRunning) return;
  const platform = $('#platform').value;
  if (!platform) {
    $('#runResult').textContent = '请先选择平台，再一键测试。';
    return;
  }
  const dataType = $('#dataType').value;
  const query = $('#query').value.trim() || '手机';
  const config = {
    platform,
    dataType,
    query,
    itemId: dataType === 'review' || dataType === 'qa' ? query : '',
  };
  $('#testModalMeta').textContent = `（${platform} · ${dataType} · ${query.slice(0, 24)}）`;
  const body = $('#testModalBody');
  $('#testModal').hidden = false;
  testRunning = true;
  body.innerHTML = '<p class="count">测试中…（每步走完整引擎：代理池 + 指纹 + 浏览器渲染；商品类型走 列表→详情→评价→问答 全链路，约需 10~120 秒）</p>';
  try {
    const r = await apiJson('/api/test-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    const blocks = r.steps
      .map((s) => {
        const urlLine = s.url
          ? `<p class="test-step-url">最终链接：<a href="${esc(s.url.startsWith('http') ? s.url : 'https://' + s.url)}" target="_blank" rel="noopener">${esc(s.url.slice(0, 110))}</a></p>`
          : '';
        const extras = [];
        if (s.responseText) {
          extras.push(
            `<details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">展开响应内容</summary><pre class="test-pre">${esc(s.responseText)}</pre></details>`
          );
        }
        if (s.dataText && s.dataText !== s.responseText) {
          extras.push(
            `<details><summary style="cursor:pointer;font-size:12px;color:var(--accent)">展开提取后的数据</summary><pre class="test-pre">${esc(s.dataText)}</pre></details>`
          );
        }
        return `<div class="test-step" data-key="${esc(s.key)}">
          <p class="test-step-head">
            <b>${testStepIcon(s)} ${esc(s.label)}</b>
            <span class="badge ${s.ok ? 'ok' : 'off'}">${s.ok ? '通过' : '未通过'}</span>
            ${s.count ? `<span class="badge">${s.count} 条</span>` : ''}
            ${s.saved ? `<span class="badge ok">入库 ${s.saved}</span>` : ''}
            ${s.ms ? `<span class="badge">${(s.ms / 1000).toFixed(1)}s</span>` : ''}
            <button class="btn-ghost" data-diag="${esc(s.key)}" data-url="${esc(s.url)}" style="padding:2px 10px;margin-left:auto">🔬 字段诊断</button>
          </p>
          ${urlLine}
          <p class="test-detail">${esc(s.detail || '')}</p>
          ${extras.join('\n')}
          <pre class="test-pre diag-result" hidden></pre>
        </div>`;
      })
      .join('\n');
    const pass = r.steps.filter((s) => s.ok).length;
    const savedNote = (r.savedTotal || 0) > 0 ? `通过步骤的数据已自动入库 ${r.savedTotal} 条（按链接去重）` : '本次测试无入库数据（未通过或为空结果）';
    body.innerHTML =
      `<p class="count" style="margin:0 0 8px">测试目标：${esc(r.target || '—')} ｜ 通过 ${pass}/${r.steps.length} 项 ｜ ${esc(savedNote)}</p>${blocks}`;
    // 每步「字段诊断」：把该步最终链接喂给诊断引擎，就地展示字段命中表
    body.querySelectorAll('[data-diag]').forEach((b) =>
      b.addEventListener('click', () => {
        const stepEl = b.closest('.test-step');
        const pre = stepEl.querySelector('.diag-result');
        runDiagnoseInline(pre, platform, b.dataset.url, 'product');
      })
    );
  } catch (e) {
    body.innerHTML = `<p style="color:#9a3412">测试失败：${esc(e.message)}</p>`;
  } finally {
    testRunning = false;
  }
}

// ---------- 请求指纹随机化 ----------
const FP_MODE_TEXT = { mixed: '混合端', desktop: '仅桌面端', mobile: '仅手机端' };
async function loadFingerprintStatus() {
  try {
    const f = await apiJson('/api/fingerprint/spawn');
    if ($('#fpMode') && f.mode) $('#fpMode').value = f.mode;
  } catch {}
}

// 生成指定数量指定端型的档案，追加至指纹池（持久化，采集时按端型范围参与抽档）
async function appendFingerprints() {
  const btn = $('#fpAppend');
  const count = $('#fpGenCount').value;
  const kind = $('#fpGenKind').value;
  btn.disabled = true;
  try {
    const r = await apiJson('/api/fingerprint/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ count, kind }),
    });
    const sample = r.samples.map((s) => `· ${s.device}（${s.viewport[0]}×${s.viewport[1]}）`).join('\n');
    $('#fpResult').textContent =
      `✅ 已生成 ${r.added} 套「${kind === 'desktop' ? '仅桌面' : '仅手机'}」档案并入池，全池现有 ${r.poolSize} 套（端型范围保存后按子池抽取）。\n样例：\n${sample}`;
    if (!$('#fpPoolBox').hidden) {
      $('#fpPoolBox').hidden = true;
      await toggleFingerprintPool();
    }
    await loadFingerprintStatus();
  } catch (e) {
    $('#fpResult').textContent = '追加失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// 清空追加档案，恢复基础真实设备池
async function clearExtraFingerprints() {
  if (!confirm('确定清空全部追加档案、恢复基础 12 套设备池？')) return;
  try {
    const r = await apiJson('/api/fingerprint/extra', { method: 'DELETE' });
    $('#fpResult').textContent = `✅ 已清空 ${r.removed} 套追加档案，恢复基础池（现 ${r.poolSize} 套）。`;
    if (!$('#fpPoolBox').hidden) {
      $('#fpPoolBox').hidden = true;
      await toggleFingerprintPool();
    }
    await loadFingerprintStatus();
  } catch (e) {
    $('#fpResult').textContent = '清空失败：' + e.message;
  }
}

// 指纹池明细：展开/收起展示当前端型模式子池的设备档案（UA/平台/视口/Client Hints/语言）
// 每次展开都重新拉取（带当前端型 ?mode=），不做缓存——避免切换端型后仍显示旧池内容的时序问题。
async function toggleFingerprintPool() {
  const box = $('#fpPoolBox');
  if (!box.hidden) {
    box.hidden = true;
    $('#fpPoolBtn').textContent = '查看指纹池明细';
    return;
  }
  try {
    const mode = $('#fpMode') ? $('#fpMode').value : '';
    const d = await apiJson(`/api/fingerprint/pool${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`);
    const pool = d.pool || [];
    if (!pool.length) {
      box.innerHTML = '<p class="count" style="margin:0">当前端型模式下子池为空。</p>';
    } else {
      const rows = pool
        .map(
          (f, i) => `<tr>
          <td>${i + 1}</td><td><b>${esc(f.device)}</b></td>
          <td>${esc(f.platform)}</td><td>${f.viewport[0]}×${f.viewport[1]}</td>
          <td>${f.mobile ? '移动' : '桌面'}</td>
          <td>${f.brand ? `<span title="${esc(f.brand)}">${esc(f.brand.slice(0, 42))}…</span>` : '<span class="muted">不发送</span>'}</td>
          <td><span title="${esc(f.ua)}">${esc(f.ua.slice(0, 58))}…</span></td>
          <td style="max-width:150px;white-space:normal;font-size:11px">${esc((f.langs || []).join('<br>'))}</td>
        </tr>`
        )
        .join('');
      box.innerHTML =
        `<p class="count" style="margin:0 0 6px">${esc(FP_MODE_TEXT[d.mode] || d.mode || '')}子池（${pool.length} 套）：采集时每次请求从该子池随机抽取一套完整档案；端型范围可在上方「端型范围」切换（保存即生效）。设备名带「追加 ·」前缀的是生成追加的档案，其余为基础真实设备池（版本随主流浏览器人工更新）。</p>` +
        `<table><thead><tr><th>#</th><th>设备档案</th><th>平台</th><th>视口</th><th>端型</th><th>Client Hints (sec-ch-ua)</th><th>User-Agent（悬停看全文）</th><th>语言候选</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
  } catch (e) {
    box.innerHTML = `<p style="color:#9a3412;font-size:12px">指纹池加载失败：${esc(e.message)}</p>`;
  }
  box.hidden = false;
  $('#fpPoolBtn').textContent = '收起指纹池明细';
}

// 切换端型范围：保存到 settings.json（保存即生效），并刷新状态与已展开的池明细
async function changeFpMode() {
  const mode = $('#fpMode').value;
  try {
    await apiJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fpMode: mode }),
    });
    $('#fpModeStatus').textContent = `端型范围已切换为「${FP_MODE_TEXT[mode]}」并保存，对后续每次抓取立即生效。`;
    if (!$('#fpPoolBox').hidden) {
      $('#fpPoolBox').hidden = true; // 先收起，再由 toggle 重新展开渲染
      await toggleFingerprintPool();
    }
    await loadFingerprintStatus();
  } catch (e) {
    $('#fpResult').textContent = '端型范围保存失败：' + e.message;
  }
}

// ---------- 存储管理 ----------
function fmtBytes(n) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
async function loadBackendInfo() {
  try {
    const b = await apiJson('/api/storage/backend');
    const label = b.backend === 'mongodb' ? (b.connected ? 'MongoDB（已连接）' : 'MongoDB（未连接）') : 'SQLite（文件库）';
    $('#backendInfo').textContent = `当前后端：${label}`;
  } catch {}
}
// ---------- 存储后端切换（确认弹窗 → 自动迁移 → 进度条 → 完成提醒） ----------
let beTarget = null; // 待确认的切换目标

function beLabel(name) {
  return name === 'mongodb' ? 'MongoDB' : 'SQLite';
}

// 点「切换到 SQLite / MongoDB」：先预检目标库，弹确认框展示校验结果与两侧数据统计
async function switchBackend(name) {
  try {
    const cur = await apiJson('/api/storage/backend');
    if (cur.backend === name) {
      alert(`当前已是 ${beLabel(name)} 后端，无需切换。`);
      return;
    }
  } catch {}
  beTarget = name;
  let fromLabel = beLabel(name) === 'SQLite' ? 'MongoDB' : 'SQLite';
  try {
    const cur = await apiJson('/api/storage/backend');
    fromLabel = beLabel(cur.backend);
  } catch {}
  $('#beModalDir').innerHTML = `切换方向：<b>${esc(fromLabel)}</b> → <b>${esc(beLabel(name))}</b>`;
  $('#beModalInfo').textContent = '正在校验目标库连通性与数据统计…';
  $('#beModalConfirm').disabled = true;
  $('#beModal').hidden = false;
  try {
    const pf = await apiJson(`/api/storage/preflight?backend=${encodeURIComponent(name)}`);
    if (!pf.ok) {
      $('#beModalInfo').innerHTML = `<p style="margin:0;color:#b91c1c">❌ 校验未通过：${esc(pf.error)}</p>`;
      return; // 保持弹窗打开，用户可关闭后修复（如启动 mongod）
    }
    const fmt = (c) => `商品 ${c.product || 0} ｜ 评论 ${c.review || 0} ｜ 问答 ${c.qa || 0} ｜ 聊天 ${c.chat || 0}`;
    $('#beModalInfo').innerHTML =
      `<p style="margin:0 0 6px">✅ 目标库连通性校验通过。</p>` +
      `<p style="margin:0 0 6px"><b>源（${esc(pf.from)}）待迁移：</b>${fmt(pf.sourceCounts)} ｜ 定时任务 ${pf.sourceJobs} 个</p>` +
      `<p style="margin:0"><b>目标（${esc(pf.to)}）现有：</b>${fmt(pf.targetCounts)} ｜ 定时任务 ${pf.targetJobs} 个（相同 id 将覆盖更新，其余保留）</p>`;
    $('#beModalConfirm').disabled = false;
  } catch (e) {
    $('#beModalInfo').innerHTML = `<p style="margin:0;color:#b91c1c">❌ 预检失败：${esc(e.message)}</p>`;
  }
}

// 确认切换：启动「迁移 → 切换」后台任务，轮询进度条，完成后提醒
async function confirmBackendSwitch() {
  if (!beTarget) return;
  $('#beModalConfirm').disabled = true;
  let started;
  try {
    started = await apiJson('/api/storage/backend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: beTarget, migrate: true }),
    });
  } catch (e) {
    alert('启动迁移失败：' + e.message);
    $('#beModalConfirm').disabled = false;
    return;
  }
  if (started.status !== 'started') {
    alert(started.error || '启动迁移失败。');
    $('#beModalConfirm').disabled = false;
    return;
  }
  $('#beModal').hidden = true;
  $('#beModalConfirm').disabled = false;
  const fill = $('#migFill');
  const text = $('#migText');
  $('#migBox').hidden = false;
  fill.className = 'mig-fill';
  fill.style.width = '0%';
  text.textContent = '迁移任务已启动…';
  const timer = setInterval(async () => {
    let s;
    try {
      s = await apiJson('/api/storage/migration');
    } catch {
      return;
    }
    fill.style.width = `${s.pct || 0}%`;
    text.textContent = `⏳ ${s.phase || '迁移中'}：${s.done}/${s.total}（${s.pct || 0}%）`;
    if (s.running) return;
    clearInterval(timer);
    beTarget = null;
    if (s.error) {
      fill.className = 'mig-fill fail';
      text.textContent = `❌ 迁移失败：${s.error}（后端未切换，原数据不受影响，可修复后重试）`;
      alert(`❌ 数据迁移失败：${s.error}\n后端保持不变，源数据不受影响，可修复后重试。`);
      return;
    }
    fill.className = 'mig-fill done';
    fill.style.width = '100%';
    const m = s.result?.migrated || {};
    const sum = `商品 ${m.product || 0} ｜ 评论 ${m.review || 0} ｜ 问答 ${m.qa || 0} ｜ 聊天 ${m.chat || 0} ｜ 定时任务 ${m.jobs || 0}`;
    text.textContent = `✅ 迁移完成（${sum}），已切换到 ${beLabel(s.result?.to)}，立即生效。`;
    alert(`✅ 数据迁移完成！\n${sum}\n已切换到 ${beLabel(s.result?.to)} 并立即生效（源库数据原样保留，可随时切回）。`);
    await Promise.all([loadBackendInfo(), loadStorage(), loadStats()]);
  }, 500);
}
async function loadStorage() {
  try {
    const s = await apiJson('/api/storage');
    const counts = s.counts || {};
    const lines = [
      `存储后端：${s.backend === 'mongodb' ? 'MongoDB' : 'SQLite'}`,
      s.backend === 'mongodb'
        ? `连接状态：${s.connected ? '已连接' : '未连接'} ｜ URI：${s.mongoUri} ｜ 库：${s.dbName}`
        : `数据库文件：${s.dbFile}（${fmtBytes(s.dbSize)}）`,
      `数据目录：${s.dataDir}`,
      `导出目录：${s.exportsDir}（${s.exportFiles} 个文件，${fmtBytes(s.exportsSize)}）`,
      `Cookie 目录：${s.cookiesDir}（${s.cookieFiles.length} 个文件）`,
      `代理文件：${s.proxiesFile}${s.proxiesExists ? '' : '（不存在）'}`,
      `记录数：商品 ${counts.product || 0} ｜ 评论 ${counts.review || 0} ｜ 问答 ${counts.qa || 0}`,
    ];
    $('#storageInfo').textContent = lines.join('\n');
  } catch (e) {
    $('#storageInfo').textContent = '错误：' + e.message;
  }
}
// ---------- 数据清理（弹框确认，数据管理页 + 存储管理共用） ----------
function clearScopeParams() {
  if ($('#clrScope').value === 'filter') {
    return { platform: $('#dataPlatform').value || '', q: $('#dataSearch').value.trim() };
  }
  return { platform: '', q: '' };
}

function syncClearScopeInfo() {
  const { platform, q } = clearScopeParams();
  const info = $('#clrScopeInfo');
  if ($('#clrScope').value === 'all') {
    info.textContent = '范围：全部数据（忽略筛选）';
    return;
  }
  const parts = [];
  if (platform) parts.push(`平台=${platform}`);
  if (q) parts.push(`关键字="${q}"`);
  info.textContent = '范围：' + (parts.length ? parts.join(' 且 ') : '（未设筛选 = 全部数据）');
}

// 弹框统计：按当前范围实时查各类型条数，勾选项 = 将删除项
async function refreshClearCounts() {
  const box = $('#clrCounts');
  box.textContent = '统计中…';
  const { platform, q } = clearScopeParams();
  const qs = (type) => {
    const p = new URLSearchParams({ type, pageSize: '1' });
    if (platform) p.set('platform', platform);
    if (q) p.set('q', q);
    return `/api/data?${p}`;
  };
  try {
    const list = await Promise.all(
      [
        ['product', '商品'],
        ['review', '评论'],
        ['qa', '问答'],
      ].map(async ([t, label]) => {
        try {
          const d = await apiJson(qs(t));
          return [t, label, d.total || 0];
        } catch {
          return [t, label, '?'];
        }
      })
    );
    box.innerHTML =
      `<table style="max-width:420px"><thead><tr><th>数据类型</th><th>该范围内条数</th><th>是否删除</th></tr></thead><tbody>` +
      list
        .map(
          ([t, label, n]) =>
            `<tr><td>${label}</td><td><b>${n}</b> 条</td><td><label class="check" style="display:flex"><input type="checkbox" data-clrtype="${t}" checked /> 删除</label></td></tr>`
        )
        .join('') +
      `</tbody></table>`;
  } catch (e) {
    box.textContent = '统计失败：' + e.message;
  }
}

async function openClearModal() {
  $('#clrModalResult').textContent = '';
  syncClearScopeInfo();
  $('#clearModal').hidden = false;
  await refreshClearCounts();
}

async function confirmClear() {
  const types = [...$('#clrCounts').querySelectorAll('[data-clrtype]:checked')].map((c) => c.dataset.clrtype);
  const jobs = $('#clrJobs2').checked;
  const exports = $('#clrExports2').checked;
  const out = $('#clrModalResult');
  if (!types.length && !jobs && !exports) {
    out.textContent = '⚠ 请至少勾选一项要删除的内容。';
    return;
  }
  const { platform, q } = clearScopeParams();
  out.textContent = '清空中…';
  try {
    const r = await apiJson('/api/storage/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, types, jobs, exports, platform, q }),
    });
    const scope = platform || q ? '（按当前筛选范围）' : '（全部）';
    out.textContent = `✅ 已清空 ${r.removed ?? r.count ?? 0} 条${scope}${r.exportsRemoved ? `，导出文件 ${r.exportsRemoved} 个` : ''}。`;
    await Promise.all([loadStorage(), loadStats()]);
    pager.page = 1;
    renderTable(currentType);
    await refreshClearCounts(); // 刷新弹框内计数（应归零）
  } catch (e) {
    out.textContent = '❌ 清空失败：' + e.message;
  }
}

// ---------- 爬虫设置 ----------
async function loadSettingsUi() {
  try {
    const s = await apiJson('/api/settings');
    $('#setDelayMin').value = s.delayMin;
    $('#setDelayMax').value = s.delayMax;
    $('#setTimeout').value = s.timeout;
    $('#setRetries').value = s.retries;
    $('#setRenderWait').value = s.renderWait;
    $('#setUsePw').checked = !!s.usePlaywright;
    $('#setRandFp').checked = !!s.randomizeFingerprint;
    $('#lgInterval').value = s.loginCheckMin ?? 30;
    if ($('#fpMode')) $('#fpMode').value = s.fpMode || 'mixed';
    $('#settingsResult').textContent =
      `当前设置：延迟 ${s.delayMin}-${s.delayMax}ms ｜ 超时 ${s.timeout}ms ｜ 重试 ${s.retries} 次 ｜ 渲染等待 ${s.renderWait}ms ｜ Playwright:${s.usePlaywright ? '开' : '关'} ｜ 指纹随机化:${s.randomizeFingerprint ? '开' : '关'} ｜ 存储后端:${s.storageBackend}`;
  } catch (e) {
    $('#settingsResult').textContent = '错误：' + e.message;
  }
}
async function saveSettingsUi() {
  const btn = $('#saveSettings');
  const body = {
    delayMin: $('#setDelayMin').value,
    delayMax: $('#setDelayMax').value,
    timeout: $('#setTimeout').value,
    retries: $('#setRetries').value,
    renderWait: $('#setRenderWait').value,
    usePlaywright: $('#setUsePw').checked,
    randomizeFingerprint: $('#setRandFp').checked,
    fpMode: $('#fpMode') ? $('#fpMode').value : undefined,
  };
  try {
    btn.disabled = true;
    $('#settingsResult').textContent = '保存中…';
    await apiJson('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadSettingsUi();
    // 在「当前设置」前追加显式保存成功标记，避免看起来像没反应
    const el = $('#settingsResult');
    el.textContent = `✅ 已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ｜ ${el.textContent}`;
  } catch (e) {
    $('#settingsResult').textContent = '保存失败：' + e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- 字段提取诊断（本地 HTML 离线模式） ----------
// 说明：在线 URL 诊断已合并进「一键测试」弹框（每步结果旁的「字段诊断」按钮）；
// 本面板做离线诊断：① 直接选本地 HTML 文件上传内容（推荐）② 高级：填服务器可访问路径。
// 诊断结果统一渲染（概要 + 字段命中表 + 组合样例）。
function renderDgResult(r) {
  const head = [
    `诊断对象：${r.source}`,
    `页面大小：${(r.htmlSize / 1024).toFixed(0)} KB`,
    `CSS 选择器卡片块：${r.selectorBlocks} 个（其中可抽出字段 ${r.usableBlocks} 个）`,
    `JSON-LD 结构化数据：${r.jsonLd} 条`,
    `当前可用策略：${r.strategy}`,
    `建议：${r.advice}`,
  ].join('\n');
  const fieldRows = (r.fields || [])
    .map(
      (f) =>
        `<tr><td>${esc(f.field)}</td><td><code>${esc(f.selector)}</code></td><td>${f.matched}</td><td>${esc(
          (f.sample || []).join(' ｜ ').slice(0, 120) || '—'
        )}</td></tr>`
    )
    .join('');
  const sampleRows = (r.sample || [])
    .map((s) => `<pre style="margin:4px 0">${esc(JSON.stringify(s, null, 1))}</pre>`)
    .join('');
  $('#dgResult').innerHTML =
    `<p class="count" style="white-space:pre-wrap">${esc(head)}</p>` +
    `<table><thead><tr><th>字段</th><th>选择器写法</th><th>命中</th><th>样例值</th></tr></thead><tbody>${fieldRows}</tbody></table>` +
    (sampleRows ? `<p class="count">组合样例（按当前选择器实际会入库的记录）：</p>${sampleRows}` : '');
}

async function diagnoseApi(body) {
  const platform = $('#platform').value;
  if (!platform) {
    $('#dgResult').textContent = '请先在「采集工作台」上方共用平台选择里挑一个具体平台（诊断需要平台对应的选择器配置）。';
    return;
  }
  $('#dgResult').textContent = '诊断中…（解析 HTML，逐字段核对选择器命中）';
  try {
    const r = await apiJson('/api/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, kind: $('#dgKind').value, ...body }),
    });
    if (!r.ok) {
      $('#dgResult').textContent = '诊断失败：' + (r.reason || r.error || '未知原因');
      return;
    }
    renderDgResult(r);
  } catch (e) {
    $('#dgResult').textContent = '错误：' + e.message;
  }
}

// 方式①：选择本地 HTML 文件，浏览器读出内容直接上传诊断（无需知道服务器路径）
function dgFileSelected() {
  const f = $('#dgFile').files[0];
  $('#dgFileName').textContent = f ? `${f.name}（${(f.size / 1024).toFixed(0)} KB）` : '未选择文件';
  $('#dgBtn').disabled = !f;
}
async function runDiagnoseFile() {
  const f = $('#dgFile').files[0];
  if (!f) {
    $('#dgResult').textContent = '请先点「① 选择 HTML 文件」选中一个 .html 文件。';
    return;
  }
  const html = await f.text();
  await diagnoseApi({ htmlContent: html, url: f.name });
}

// 方式②（高级）：直接填服务器可访问路径
async function runDiagnosePath() {
  const src = $('#dgSource').value.trim();
  if (!src) {
    $('#dgResult').textContent = '请填写服务器可访问的 HTML 文件路径（如把文件放进项目 data/ 目录后填 data/xxx.html）。';
    return;
  }
  await diagnoseApi({ fixturePath: src });
}

// ---------- 数据浏览 & 导出 ----------
// 分页状态（切类型/改每页条数时重置回第 1 页）
const pager = { page: 1, pageSize: 20, total: 0 };

function cell(v, max = 40) {
  const s = String(v ?? '');
  if (!s) return '<span class="muted">—</span>';
  const shown = s.length > max ? s.slice(0, max) + '…' : s;
  return `<span title="${esc(s)}">${esc(shown)}</span>`;
}
function linkCell(url) {
  if (!url) return '<span class="muted">—</span>';
  const href = url.startsWith('//') ? 'https:' + url : url;
  if (!/^https?:\/\//.test(href)) return cell(url, 24);
  return `<a href="${esc(href)}" target="_blank" rel="noopener">打开</a>`;
}

// 全站时间统一北京时间、精确到分钟。时间戳是 UTC ISO（带 Z），new Date 会自动转浏览器本地时区；
// 中国用户本地即北京时间，不能再加 8h（否则国内机器上会多加 8 小时——历史 bug）。
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return esc(String(iso).slice(0, 16));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function timeCell(iso) {
  return esc(fmtTime(iso));
}

// 渲染序号令牌：筛选快速切换 / 轮询并发时，旧响应后到会覆盖新结果（表现为「筛选不生效」），
// 只有最新一次请求允许写表格。
let renderSeq = 0;

function renderTable(type, keepPage = false) {
  currentType = type;
  if (!keepPage) pager.page = 1;
  const seq = ++renderSeq;
  const q = new URLSearchParams({ type, page: pager.page, pageSize: pager.pageSize });
  // 数据管理页筛选联动：平台 + 关键字（后端已支持，空值不传）
  const plat = $('#dataPlatform') ? $('#dataPlatform').value : '';
  const kw = $('#dataSearch') ? $('#dataSearch').value.trim() : '';
  if (plat) q.set('platform', plat);
  if (kw) q.set('q', kw);
  apiJson(`/api/data?${q}`)
    .then((d) => {
      if (seq !== renderSeq) return; // 已有更新的请求，丢弃过期响应
      pager.total = d.total || 0;
    const rows = d.rows || [];
    const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
    let html = '';
    if (type === 'product') {
      html = `<table><thead><tr><th>#</th><th>平台</th><th>标题</th><th>价格</th><th>类目</th><th>品牌</th><th>销量</th><th>店铺</th><th>ItemId</th><th>链接</th><th>采集时间</th><th>操作</th></tr></thead><tbody>
        ${rows
          .map(
            (r, i) =>
              `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td>${cell(r.title, 46)}</td><td>¥${r.price}</td><td>${cell(r.category, 14)}</td><td>${cell(r.brand, 12)}</td><td>${r.sales > 0 ? r.sales : '<span class="muted">—</span>'}</td><td>${cell(r.shopName, 16)}</td><td>${cell(r.itemId, 14)}</td><td>${linkCell(r.url)}</td><td>${timeCell(r.collectedAt)}</td><td><button data-detail="${i}" style="padding:2px 10px">详情</button></td></tr>`
          )
          .join('')}</tbody></table>`;
      drawerRows = rows;
    } else if (type === 'review') {
      html = `<table><thead><tr><th>#</th><th>平台</th><th>商品</th><th>评分</th><th>内容</th><th>作者</th><th>标签</th><th>评价时间</th><th>采集时间</th></tr></thead><tbody>
        ${rows
          .map(
            (r, i) =>
              `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td><button class="btn-ghost" data-jumpprod="${esc(r.itemId || '')}" data-plat="${esc(r.platform)}" style="padding:1px 6px;font-size:12px" ${r.itemId ? '' : 'disabled'} title="点击查看该商品">${esc(String(r.productTitle || '—').slice(0, 24))}</button></td><td>${r.rating}★</td><td>${cell(r.content, 60)}</td><td>${esc(r.authorMasked)}</td><td>${cell((r.tags || []).join(','), 10)}</td><td>${timeCell(r.createdAt)}</td><td>${timeCell(r.collectedAt)}</td></tr>`
          )
          .join('')}</tbody></table>`;
    } else if (type === 'qa') {
      html = `<table><thead><tr><th>#</th><th>平台</th><th>商品</th><th>问题</th><th>回答</th><th>提问人</th><th>时间</th></tr></thead><tbody>
        ${rows
          .map(
            (r, i) =>
              `<tr><td>${(pager.page - 1) * pager.pageSize + i + 1}</td><td>${esc(r.platform)}</td><td><button class="btn-ghost" data-jumpprod="${esc(r.itemId || '')}" data-plat="${esc(r.platform)}" style="padding:1px 6px;font-size:12px" ${r.itemId ? '' : 'disabled'}>${esc(String(r.productTitle || '—').slice(0, 24))}</button></td><td>${cell(r.question, 40)}</td><td>${cell(r.answer, 40)}</td><td>${esc(r.askerMasked)}</td><td>${timeCell(r.createdAt)}</td></tr>`
          )
          .join('')}</tbody></table>`;
    } else {
      html = '';
    }
    $('#tableWrap').innerHTML = (rows.length ? '' : '<p>暂无数据</p>') + html;
    $('#pgInfo').textContent = `共 ${pager.total} 条 ｜ 第 ${pager.page} / ${totalPages} 页`;
    $('#pgPrev').disabled = pager.page <= 1;
    $('#pgNext').disabled = pager.page >= totalPages;
    if (type === 'product') {
      $('#tableWrap').querySelectorAll('[data-detail]').forEach((b) =>
        b.addEventListener('click', () => openDrawer(drawerRows[Number(b.dataset.detail)]))
      );
    } else {
      // 评论/问答「商品」列 → 点击跳回商品页签并按 itemId 检索（数据关联）
      $('#tableWrap').querySelectorAll('[data-jumpprod]').forEach((b) =>
        b.addEventListener('click', () => jumpToProduct(b.dataset.plat, b.dataset.jumpprod))
      );
    }
    })
    .catch((e) => {
      if (seq !== renderSeq) return;
      // 请求失败必须可见：过去静默吞掉错误，表格纹丝不动，看起来就像「筛选没联动」
      $('#tableWrap').innerHTML = `<p style="color:#9a3412">数据加载失败：${esc(e.message)}</p>`;
    });
}

// 评论/问答 → 关联商品跳转：切到商品页签，按 itemId 检索并高亮该商品
function jumpToProduct(platform, itemId) {
  if (!itemId) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.type === 'product'));
  $('#dataPlatform').value = [...$('#dataPlatform').options].some((o) => o.value === platform) ? platform : '';
  $('#dataSearch').value = itemId;
  renderTable('product');
}

// ---------- 数据详情抽屉 ----------
let drawerRows = [];
let drawerOpen = false;

// SPU/SKU 规格拆解渲染：spu/skus 翻译成维度×价格表；specs 其它字段（促销/市场价等）一并列出
function renderSpecs(specs) {
  if (!specs || typeof specs !== 'object') return '';
  const spu = specs.spu || {};
  const skus = specs.skus || [];
  const label = { marketPrice: '市场价', discount: '促销', skuCode: 'SKU编码', skuCount: 'SKU数', tags: '标签', inStock: '有货', goodRate: '好评率', currency: '币种', stock: '库存', color: '颜色', version: '版本' };
  const propTable = specs.props && typeof specs.props === 'object' ? Object.entries(specs.props) : null;
  const extra = Object.entries(specs).filter(
    ([k]) => !['spu', 'skus', 'propGroups', 'props'].includes(k) && specs[k] !== '' && specs[k] != null
  );
  let html = '<h4>SPU 商品信息</h4>';
  const spuFields = [
    ['标题', spu.title], ['品牌', spu.brandName || spu.brand], ['店铺', spu.shopName || spu.vendorName],
    ['类目', spu.categoryName], ['价格', spu.price ? '¥' + spu.price : ''], ['SPU', spu.spuId || spu.prodSpuId],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (spuFields.length) {
    html += `<table><tbody>${spuFields.map(([k, v]) => `<tr><th style="width:70px">${esc(k)}</th><td>${cell(v, 60)}</td></tr>`).join('')}</tbody></table>`;
  } else {
    html += '<p class="muted" style="font-size:12px;margin:0">无结构化 SPU 字段（带详情采集后会出现）</p>';
  }
  if (extra.length) {
    html += `<h4>商品附加字段</h4><table><tbody>${extra
      .map(([k, v]) => `<tr><th style="width:70px">${esc(label[k] || k)}</th><td>${cell(typeof v === 'object' ? JSON.stringify(v) : v, 60)}</td></tr>`)
      .join('')}</tbody></table>`;
  }
  if (propTable && propTable.length) {
    html +=
      `<h4>规格参数（${propTable.length} 项）</h4><table><tbody>` +
      propTable
        .map(([k, v]) => `<tr><th style="width:110px">${esc(k)}</th><td>${cell(String(v), 80)}</td></tr>`)
        .join('') +
      `</tbody></table>`;
  }
  html += `<h4>SKU 明细（${skus.length} 条）</h4>`;
  if (skus.length) {
    html +=
      `<table><thead><tr><th>#</th><th>SKU</th><th>规格</th><th>价格</th><th>状态</th></tr></thead><tbody>` +
      skus
        .slice(0, 60)
        .map((s, i) => {
          const name = s.name || s.skuName || s.title || s.skuId || `#${i + 1}`;
          const props = [s.props, s.spec, s.value, s.color, s.version].filter(Boolean).join(' / ');
          const price = s.price != null && s.price !== '' && Number(s.price) > 0 ? '¥' + s.price : '—';
          const status = s.stock === false || s.offline ? '下架' : s.stock === true ? '有货' : s.status || '—';
          return `<tr><td>${i + 1}</td><td>${cell(s.skuId || '', 14)}</td><td>${esc(String(name)).slice(0, 40)}${props ? `<span class="muted" style="font-size:11px"> ${esc(String(props)).slice(0, 40)}</span>` : ''}</td><td>${price}</td><td>${esc(String(status)).slice(0, 12)}</td></tr>`;
        })
        .join('') +
      `</tbody></table>${skus.length > 60 ? `<p class="hint">仅展示前 60 条，完整数据见下方 JSON。</p>` : ''}`;
  } else {
    html += '<p class="muted" style="font-size:12px;margin:0">该记录无 SKU 明细（可能未开启带详情采集）</p>';
  }
  return html;
}

// 商品抽屉「关联评论/问答」：按 itemId 精确过滤该商品的评论与问答（前 6 条）
async function loadRelatedItems(p) {
  const box = $('#drawerRelated');
  if (!box) return;
  if (!p.itemId) {
    box.innerHTML = '<h4>关联评论 / 问答</h4><p class="muted" style="font-size:12px;margin:0">该记录无 itemId，无法关联</p>';
    return;
  }
  box.innerHTML = '<h4>关联评论 / 问答</h4><p class="muted" style="font-size:12px;margin:0">检索中…</p>';
  try {
    const [rv, qa] = await Promise.all([
      apiJson(`/api/data?type=review&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId)}&pageSize=50`),
      apiJson(`/api/data?type=qa&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId)}&pageSize=50`),
    ]);
    const rvRows = (rv.rows || []).filter((r) => r.itemId === p.itemId);
    const qaRows = (qa.rows || []).filter((r) => r.itemId === p.itemId);
    let html = `<h4>关联评论（${rvRows.length}）/ 问答（${qaRows.length}）</h4>`;
    if (!rvRows.length && !qaRows.length) {
      html += `<p class="muted" style="font-size:12px;margin:0">该商品暂无关联评论/问答。可勾选「带详情」采集，或在上方点「补抓详情」一并列出。</p>`;
    } else {
      if (rvRows.length) {
        html += `<table><thead><tr><th>评分</th><th>内容</th><th>作者</th><th>时间</th></tr></thead><tbody>${rvRows
          .slice(0, 6)
          .map((r) => `<tr><td>${r.rating}★</td><td>${cell(r.content, 50)}</td><td>${esc(r.authorMasked || '')}</td><td>${timeCell(r.createdAt || r.collectedAt)}</td></tr>`)
          .join('')}</tbody></table>`;
      }
      if (qaRows.length) {
        html += `<table style="margin-top:8px"><thead><tr><th>问题</th><th>回答</th></tr></thead><tbody>${qaRows
          .slice(0, 6)
          .map((q) => `<tr><td>${cell(q.question, 40)}</td><td>${cell(q.answer, 40)}</td></tr>`)
          .join('')}</tbody></table>`;
      }
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = `<h4>关联评论 / 问答</h4><p style="color:#9a3412;font-size:12px">检索失败：${esc(e.message)}</p>`;
  }
}

// 商品抽屉「补抓详情」：对该商品发一次真实详情请求，回填 SPU/SKU 到记录并刷新抽屉
async function refetchDetail(p) {
  const btn = $('#refetchBtn');
  const box = $('#refetchResult');
  btn.disabled = true;
  box.textContent = '补抓中…（对该商品发一次真实详情请求，约需 5~60 秒）';
  try {
    const r = await apiJson('/api/detail-refetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id }),
    });
    if (r.status === 'empty') {
      box.textContent = '⚠ ' + (r.message || '详情页未暴露 SPU/SKU 数据');
    } else {
      box.textContent = '✅ ' + (r.message || '已更新');
      // 拉回更新后的记录重开抽屉
      const d = await apiJson(`/api/data?type=product&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId || p.title)}&pageSize=20`);
      const fresh = (d.rows || []).find((x) => x.id === p.id);
      if (fresh) openDrawer(fresh);
    }
  } catch (e) {
    box.textContent = '❌ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}

function openDrawer(p) {
  if (!p) return;
  drawerOpen = true;
  $('#drawerTitle').textContent = p.title || `itemId=${p.itemId}`;
  const specs = typeof p.specs === 'string' ? (() => { try { return JSON.parse(p.specs); } catch { return null; } })() : p.specs;
  const meta = [
    ['平台', p.platform], ['价格', p.price != null ? '¥' + p.price : '—'], ['品牌', p.brand || '—'],
    ['店铺', p.shopName || '—'], ['类目', p.category || '—'], ['销量', p.sales > 0 ? p.sales : '—'],
    ['ItemId', p.itemId], ['采集时间', fmtTime(p.collectedAt)],
  ];
  const hasDetail = !!(specs && (specs.spu || (specs.skus || []).length || specs.props));
  const imgs = Array.isArray(p.images) ? p.images : typeof p.images === 'string' ? (() => { try { return JSON.parse(p.images); } catch { return []; } })() : [];
  const absImg = (u) => (typeof u === 'string' && u ? (u.startsWith('//') ? 'https:' + u : u) : '');
  $('#drawerBody').innerHTML =
    `<table><tbody>${meta.map(([k, v]) => `<tr><th style="width:76px">${esc(k)}</th><td>${esc(String(v ?? ''))}</td></tr>`).join('')}</tbody></table>` +
    (p.url
      ? `<h4>商品链接</h4><p style="margin:0;font-size:13px"><a href="${esc(p.url.startsWith('//') ? 'https:' + p.url : p.url)}" target="_blank" rel="noopener">${esc(p.url).slice(0, 90)}</a></p>`
      : '') +
    (imgs.length
      ? `<h4>商品图片（${imgs.length}）</h4><div class="drawer-imgs">${imgs
          .slice(0, 12)
          .map((u) => {
            const a = absImg(u);
            return a ? `<a href="${esc(a)}" target="_blank" rel="noopener" title="点击查看原图"><img src="${esc(a)}" loading="lazy" referrerpolicy="no-referrer" alt=""/></a>` : '';
          })
          .join('')}${imgs.length > 12 ? `<span class="hint" style="align-self:center">共 ${imgs.length} 张，其余见 JSON</span>` : ''}</div>`
      : '') +
    (p.description
      ? `<h4>商品描述</h4><p class="drawer-desc" title="点击复制全文" data-desc="${esc(p.description)}">${esc(p.description.slice(0, 600))}${p.description.length > 600 ? `…（共 ${p.description.length} 字，点击复制全文）` : ''}</p>`
      : '') +
    renderSpecs(specs) +
    `<div class="controls" style="margin:12px 0 4px;padding-top:10px;border-top:1px dashed var(--line)">
      <button id="refetchBtn" class="btn-ghost">🔄 补抓详情（描述/图片/SPU/SKU）</button>
      <span id="refetchResult" class="hint" style="flex:1">${hasDetail ? '已有详情数据，可重新补抓刷新。' : '该商品缺详情数据，点按钮补抓（需真实访问详情页）。'}</span>
    </div>` +
    `<div id="drawerRelated"></div>` +
    `<h4>完整记录（JSON）</h4><pre class="drawer-json">${esc(JSON.stringify(p, null, 2))}</pre>`;
  $('#drawerMask').hidden = false;
  $('#refetchBtn').addEventListener('click', () => refetchDetail(p));
  const descEl = $('#drawerBody .drawer-desc');
  if (descEl) {
    descEl.addEventListener('click', () => {
      navigator.clipboard.writeText(descEl.dataset.desc || '').then(() => {
        descEl.style.color = 'var(--ok, #166534)';
        setTimeout(() => (descEl.style.color = ''), 1200);
      });
    });
  }
  loadRelatedItems(p);
}
function closeDrawer() {
  drawerOpen = false;
  $('#drawerMask').hidden = true;
}

function bindPager() {
  $('#pgPrev').addEventListener('click', () => {
    if (pager.page > 1) {
      pager.page--;
      renderTable(currentType, true);
    }
  });
  $('#pgNext').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
    if (pager.page < totalPages) {
      pager.page++;
      renderTable(currentType, true);
    }
  });
  $('#pageSize').addEventListener('change', () => {
    pager.pageSize = Number($('#pageSize').value);
    renderTable(currentType, true);
  });
  $('#pgGo').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(pager.total / pager.pageSize));
    const n = Math.min(totalPages, Math.max(1, Number($('#pgJump').value) || 1));
    pager.page = n;
    renderTable(currentType, true);
  });
}

function downloadExport(format) {
  const a = document.createElement('a');
  // 导出跟随数据管理页当前筛选（平台/关键字），后端接口同样支持这两个参数
  const plat = $('#dataPlatform').value;
  const kw = $('#dataSearch').value.trim();
  let url = `/api/export?type=${currentType}&format=${format}`;
  if (plat) url += `&platform=${encodeURIComponent(plat)}`;
  if (kw) url += `&q=${encodeURIComponent(kw)}`;
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- 事件绑定 ----------
$('#runBtn').addEventListener('click', runCollect);
$('#stopBtn').addEventListener('click', stopCollect);
$('#saveAsJob').addEventListener('click', saveAsJob);
$('#ckCopy').addEventListener('click', copyCookiesJson);
$('#ckModalClose').addEventListener('click', () => ($('#cookieModal').hidden = true));
$('#cookieModal').addEventListener('click', (e) => {
  if (e.target === $('#cookieModal')) $('#cookieModal').hidden = true; // 点遮罩关闭
});
$('#addJobBtn').addEventListener('click', addJob);
$('#jobType').addEventListener('change', syncJobDetailLimitUi);
$('#jobDetails').addEventListener('change', syncJobDetailLimitUi);
syncJobDetailLimitUi();
$('#proxyReload').addEventListener('click', () =>
  api('/api/proxy/reload', { method: 'POST' })
    .then(() => loadProxy())
    .catch(() => {})
);
$('#expCsv').addEventListener('click', () => downloadExport('csv'));
$('#expJson').addEventListener('click', () => downloadExport('json'));
$('#fpAppend').addEventListener('click', appendFingerprints);
$('#fpClear').addEventListener('click', clearExtraFingerprints);
$('#fpPoolBtn').addEventListener('click', toggleFingerprintPool);
$('#fpMode').addEventListener('change', changeFpMode);
$('#dataClearBtn').addEventListener('click', openClearModal); // 数据管理页入口（系统设置页无清理入口）
$('#clearModalClose').addEventListener('click', () => ($('#clearModal').hidden = true));
$('#clearModal').addEventListener('click', (e) => {
  if (e.target === $('#clearModal')) $('#clearModal').hidden = true; // 点遮罩关闭
});
$('#clrScope').addEventListener('change', () => {
  syncClearScopeInfo();
  refreshClearCounts();
});
$('#clrConfirm').addEventListener('click', confirmClear);
$('#saveSettings').addEventListener('click', saveSettingsUi);
// topTestBtn 已随「淘宝开放平台（官方 API）」子模块移除（round37）
// 字段提取诊断：① 选文件上传（推荐） ② 高级：服务器路径
$('#dgFileBtn').addEventListener('click', () => $('#dgFile').click());
$('#dgFile').addEventListener('change', dgFileSelected);
$('#dgBtn').addEventListener('click', runDiagnoseFile);
$('#dgPathBtn').addEventListener('click', runDiagnosePath);
$('#beSqlite').addEventListener('click', () => switchBackend('sqlite'));
$('#beMongo').addEventListener('click', () => switchBackend('mongodb'));
$('#beModalConfirm').addEventListener('click', confirmBackendSwitch);
$('#beModalClose').addEventListener('click', () => ($('#beModal').hidden = true));
$('#beModalCancel').addEventListener('click', () => ($('#beModal').hidden = true));
$('#beModal').addEventListener('click', (e) => {
  if (e.target === $('#beModal')) $('#beModal').hidden = true; // 点遮罩关闭
});
$('#proxyAdd').addEventListener('click', addProxyUi);
$('#proxyTest').addEventListener('click', testProxiesUi);
// 一键测试（弹框交互）
$('#testBtn').addEventListener('click', runTestUi);
$('#testModalRerun').addEventListener('click', runTestUi);
$('#testModalClose').addEventListener('click', () => ($('#testModal').hidden = true));
$('#testModal').addEventListener('click', (e) => {
  if (e.target === $('#testModal') && !testRunning) $('#testModal').hidden = true; // 测试进行中不允许误关
});
// 平台登录状态（系统设置）
$('#lgSaveInterval').addEventListener('click', saveLoginInterval);
$('#lgCheckAll').addEventListener('click', checkAllLoginUi);
$('#lgSaveCookie').addEventListener('click', saveLoginCookie);
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    renderTable(t.dataset.type);
  })
);

// ---------- 联动绑定 ----------
// 侧边导航路由
document.querySelectorAll('.nav-item').forEach((n) =>
  n.addEventListener('click', () => showPage(n.dataset.page))
);
window.addEventListener('hashchange', () => showPage((location.hash || '').replace('#/', '')));
// 平台选择变化 → 信息卡刷新
$('#platform').addEventListener('change', () => {
  updatePlatCard();
});
// 数据类型 ↔ 详情选项联动
$('#dataType').addEventListener('change', syncDataTypeUi);
$('#withDetails').addEventListener('change', syncDetailLimitUi);
// 数据管理页筛选联动：平台/搜索变化即刷新表格
$('#dataPlatform').addEventListener('change', () => renderTable(currentType));
$('#dataSearchBtn').addEventListener('click', () => renderTable(currentType));
$('#dataReset').addEventListener('click', () => {
  $('#dataPlatform').value = '';
  $('#dataSearch').value = '';
  renderTable(currentType);
});
// 搜索框回车与防抖自动搜索
$('#dataSearch').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renderTable(currentType);
});
let searchTimer = null;
$('#dataSearch').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderTable(currentType, true), 400);
});
// 详情抽屉关闭
$('#drawerClose').addEventListener('click', closeDrawer);
$('#drawerMask').addEventListener('click', (e) => {
  if (e.target === $('#drawerMask')) closeDrawer();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drawerOpen) closeDrawer();
  if (e.key === 'Escape' && !testRunning) $('#testModal').hidden = true;
  if (e.key === 'Escape') $('#clearModal').hidden = true;
  if (e.key === 'Escape') $('#beModal').hidden = true;
});
syncDataTypeUi();

// 初始化
loadPlatforms()
  .then(() => {
    // 从 URL hash 恢复上次所在页面
    showPage((location.hash || '').replace('#/', ''));
    return updatePlatCard();
  })
  .then(loadStats)
  .then(() => {
    renderTable('product');
    bindPager();
    loadJobs();
    loadRuns();
    loadProxy();
    loadFingerprintStatus();
    loadStorage();
    loadBackendInfo();
    loadSettingsUi();
    loadLoginStatus();
    setInterval(pollStats, 5000); // 数据变化自动感知
    pollStats();
  });
