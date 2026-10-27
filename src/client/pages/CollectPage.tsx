import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';
import { useApp } from '../ctx';
import { TestModal } from '../components/TestModal';

// 平台能力元数据（联动信息卡用）
const PLATFORM_META: any = {
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

export function CollectPage() {
  const app = useApp();
  const platform = app.platform;

  // ---------- 运行采集 ----------
  const [dataType, setDataType] = useState('product');
  const [strategy, setStrategy] = useState('auto');
  const [query, setQuery] = useState('手机');
  const [limit, setLimit] = useState('10');
  const [withDetails, setWithDetails] = useState(false);
  const [detailLimit, setDetailLimit] = useState('3');
  const [runResult, setRunResult] = useState('');
  const [runJumpPlatform, setRunJumpPlatform] = useState('');
  const [running, setRunning] = useState(false);
  const [stopDisabled, setStopDisabled] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testCfg, setTestCfg] = useState<any>(null);
  const [testMeta, setTestMeta] = useState('');

  // ---------- 平台联动信息卡 ----------
  const [card, setCard] = useState<any>(null);
  useEffect(() => {
    if (!platform) {
      setCard(null);
      return;
    }
    const meta = PLATFORM_META[platform] || { direct: '浏览器渲染兜底', login: '—' };
    const sel = app.platforms.find((p: any) => p.id === platform);
    setCard({ name: sel ? sel.name : platform, direct: meta.direct, login: meta.login, loginState: 'loading', proxyState: 'loading' });
    let alive = true;
    (async () => {
      try {
        const c = await apiJson('/api/cookies');
        if (!alive) return;
        const has = (c.files || []).some((f: string) => f.startsWith(platform));
        const suffix = meta.login === '必需' ? ' · 该平台必需，请到系统设置提取' : meta.login === '推荐' ? ' · 建议提取' : '';
        setCard((cd: any) => cd && { ...cd, loginState: 'ready', loginHas: has, loginSuffix: suffix });
      } catch {
        if (alive) setCard((cd: any) => cd && { ...cd, loginState: 'error' });
      }
      try {
        const p = await apiJson('/api/proxy');
        if (!alive) return;
        const okCount = (p.proxies || []).filter((x: any) => x.cooldownUntil <= Date.now()).length;
        setCard((cd: any) => cd && { ...cd, proxyState: 'ready', proxyText: `${okCount}/${p.poolSize} 可用`, proxyOk: okCount > 0 });
      } catch {
        if (alive) setCard((cd: any) => cd && { ...cd, proxyState: 'error' });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, app.platCardTick, app.platforms]);

  // ---------- 采集过程日志（滚动展示） ----------
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const logBoxRef = useRef<HTMLDivElement>(null);
  const logTimer = useRef<any>(null);
  const logLast = useRef(-1);
  const appendLogs = (lines: any[]) => {
    if (!lines.length) return;
    setLogLines((ls) => [...ls, ...lines.map((l: any) => `[${l.t}] ${l.msg}`)]);
    requestAnimationFrame(() => {
      const b = logBoxRef.current;
      if (b) b.scrollTop = b.scrollHeight;
    });
  };
  function startRunLogPolling() {
    setLogOpen(true);
    setLogLines([]);
    logLast.current = -1;
    clearInterval(logTimer.current);
    logTimer.current = setInterval(async () => {
      try {
        const d = await apiJson(`/api/logs?since=${logLast.current}`);
        appendLogs(d.lines || []);
        logLast.current = d.last;
      } catch {}
    }, 1000);
  }
  function stopRunLogPolling() {
    // 结束后再多拉 1.5 秒，把收尾日志收全
    clearInterval(logTimer.current);
    logTimer.current = setTimeout(async () => {
      try {
        const d = await apiJson(`/api/logs?since=${logLast.current}`);
        appendLogs(d.lines || []);
        logLast.current = d.last;
      } catch {}
    }, 1500);
  }

  async function runCollect() {
    if (!platform) {
      setRunResult('请先选择具体平台再运行采集。');
      return;
    }
    const body = {
      platform,
      dataType,
      strategy,
      query,
      limit: Number(limit),
      withDetails,
      detailLimit: Number(detailLimit),
    };
    setRunResult('采集中…（下方日志实时滚动展示采集过程）');
    setRunning(true);
    startRunLogPolling();
    try {
      const r = await apiJson('/api/collect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 'stopped') setRunResult('⏹ 已手动停止采集。' + (r.message || ''));
      else if (r.count > 0) {
        setRunJumpPlatform(platform);
        setRunResult(`本次入库 ${r.count} 条（${platform}）。`);
      } else setRunResult(JSON.stringify(r, null, 2));
      await app.refreshStats();
      app.refreshTable(true, { type: body.dataType });
    } catch (e: any) {
      setRunResult('错误：' + e.message);
    } finally {
      stopRunLogPolling();
      setRunning(false);
    }
  }

  async function stopCollect() {
    setStopDisabled(true);
    setRunResult('正在停止…（当前网络请求完成后不再继续，已入库数据保留）');
    try {
      await apiJson('/api/collect/stop', { method: 'POST' });
    } catch (e: any) {
      setRunResult('停止指令发送失败：' + e.message);
      setStopDisabled(false);
    }
  }

  // 采集配置 → 定时任务联动：把当前工作台配置带入任务表单并跳转
  function saveAsJob() {
    if (!platform) {
      setRunResult('请先选择平台再保存为定时任务。');
      return;
    }
    app.setJobPrefill({
      platform,
      dataType,
      query,
      limit: Number(limit),
      withDetails: dataType === 'product' ? withDetails : false,
      detailLimit: Number(detailLimit) || 3,
      msg: '已从采集工作台带入当前配置，确认参数后点「添加任务」。',
    });
    app.showPage('jobs');
  }

  function jumpToData() {
    app.refreshTable(false, { platform: runJumpPlatform, search: '' });
    app.showPage('data');
  }

  function openTest() {
    if (!platform) {
      setRunResult('请先选择平台，再一键测试。');
      return;
    }
    const q = query.trim() || '手机';
    setTestCfg({ platform, dataType, query: q, itemId: dataType === 'review' || dataType === 'qa' ? q : '' });
    setTestMeta(`（${platform} · ${dataType} · ${q.slice(0, 24)}）`);
    setTestOpen(true);
  }

  // ---------- 字段提取诊断（本地 HTML 离线诊断） ----------
  const [dgKind, setDgKind] = useState('product');
  const [dgFile, setDgFile] = useState<File | null>(null);
  const [dgSource, setDgSource] = useState('');
  const [dgResult, setDgResult] = useState<any>('');

  function renderDgResult(r: any) {
    const head = [
      `诊断对象：${r.source}`,
      `页面大小：${(r.htmlSize / 1024).toFixed(0)} KB`,
      `CSS 选择器卡片块：${r.selectorBlocks} 个（其中可抽出字段 ${r.usableBlocks} 个）`,
      `JSON-LD 结构化数据：${r.jsonLd} 条`,
      `当前可用策略：${r.strategy}`,
      `建议：${r.advice}`,
    ].join('\n');
    return (
      <>
        <p className="count" style={{ whiteSpace: 'pre-wrap' }}>
          {head}
        </p>
        <table>
          <thead>
            <tr>
              <th>字段</th>
              <th>选择器写法</th>
              <th>命中</th>
              <th>样例值</th>
            </tr>
          </thead>
          <tbody>
            {(r.fields || []).map((f: any, i: number) => (
              <tr key={i}>
                <td>{f.field}</td>
                <td>
                  <code>{f.selector}</code>
                </td>
                <td>{String(f.matched)}</td>
                <td>{(f.sample || []).join(' ｜ ').slice(0, 120) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(r.sample || []).length ? (
          <>
            <p className="count">组合样例（按当前选择器实际会入库的记录）：</p>
            {(r.sample || []).map((s: any, i: number) => (
              <pre key={i} style={{ margin: '4px 0' }}>
                {JSON.stringify(s, null, 1)}
              </pre>
            ))}
          </>
        ) : null}
      </>
    );
  }

  async function diagnoseApi(body: any) {
    if (!platform) {
      setDgResult('请先在「采集工作台」上方共用平台选择里挑一个具体平台（诊断需要平台对应的选择器配置）。');
      return;
    }
    setDgResult('诊断中…（解析 HTML，逐字段核对选择器命中）');
    try {
      const r = await apiJson('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, kind: dgKind, ...body }),
      });
      if (!r.ok) {
        setDgResult('诊断失败：' + (r.reason || r.error || '未知原因'));
        return;
      }
      setDgResult(renderDgResult(r));
    } catch (e: any) {
      setDgResult('错误：' + e.message);
    }
  }

  // 方式①：选择本地 HTML 文件，浏览器读出内容直接上传诊断（无需知道服务器路径）
  async function runDiagnoseFile() {
    if (!dgFile) {
      setDgResult('请先点「① 选择 HTML 文件」选中一个 .html 文件。');
      return;
    }
    const html = await dgFile.text();
    await diagnoseApi({ htmlContent: html, url: dgFile.name });
  }

  // 方式②（高级）：直接填服务器可访问路径
  async function runDiagnosePath() {
    const src = dgSource.trim();
    if (!src) {
      setDgResult('请填写服务器可访问的 HTML 文件路径（如把文件放进项目 data/ 目录后填 data/xxx.html）。');
      return;
    }
    await diagnoseApi({ fixturePath: src });
  }

  const itemMode = dataType === 'review' || dataType === 'qa';

  return (
    <section className={`page${app.page === 'collect' ? ' active' : ''}`} id="page-collect">
      <div className="banner">
        采集采用「<b>官方 API 优先 → 浏览器渲染兜底</b>」分层策略；平台能力见下方联动信息卡，随平台选择实时更新。
      </div>

      <section className="panel">
        <h2>运行采集</h2>
        <div id="platCard" className="plat-card">
          {!card ? (
            <span className="muted">请选择平台查看联动信息。</span>
          ) : (
            <>
              <span className="badge">
                <b>{card.name}</b>
              </span>
              <span className="badge">直连通道：{card.direct}</span>
              <span id="pcLogin" className={`badge ${card.loginState === 'ready' ? (card.loginHas ? 'ok' : 'off') : ''}`}>
                {card.loginState === 'ready' && <span className="dot"></span>}
                登录态：
                {card.loginState === 'ready'
                  ? card.loginHas
                    ? '已有（采集自动注入）'
                    : `无${card.loginSuffix}`
                  : card.loginState === 'error'
                    ? '检测失败'
                    : '检测中…'}
              </span>
              <span id="pcProxy" className={`badge ${card.proxyState === 'ready' && card.proxyOk ? 'ok' : card.proxyState === 'ready' ? 'off' : ''}`}>
                {card.proxyState === 'ready' ? `代理池：${card.proxyText}` : card.proxyState === 'error' ? '代理池：加载失败' : '代理池：…'}
              </span>
            </>
          )}
        </div>
        <div className="controls">
          <label>
            平台（采集 / 诊断 / 登录态 全局联动）
            <select id="platform" value={platform} onChange={(e) => app.setPlatform(e.target.value)}>
              {app.platforms.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            数据类型
            <select id="dataType" value={dataType} onChange={(e) => setDataType(e.target.value)}>
              <option value="product">商品</option>
              <option value="review">评论</option>
              <option value="qa">问答(问大家)</option>
            </select>
          </label>
          <label>
            策略
            <select id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)}>
              <option value="auto">auto（官方优先→爬取回退）</option>
              <option value="mock">mock（无凭证演示）</option>
            </select>
          </label>
          <label id="queryLabel">{itemMode ? '商品链接或 ItemId ' : '查询词 / ItemId '}
            <input
              id="query"
              type="text"
              placeholder={itemMode ? '如：https://item.jd.com/… 或 100012043978' : '如：手机 / item_123'}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label>
            数量
            <input id="limit" type="number" value={limit} min={1} max={100} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <label className="check" id="withDetailsWrap" hidden={itemMode}>
            <input id="withDetails" type="checkbox" checked={withDetails} onChange={(e) => setWithDetails(e.target.checked)} /> 带商详和评论
          </label>
          <label id="detailLimitWrap" hidden={!(dataType === 'product' && withDetails)}>
            详情数
            <input id="detailLimit" type="number" value={detailLimit} min={1} max={20} onChange={(e) => setDetailLimit(e.target.value)} />
          </label>
        </div>
        {/* 按钮行：存为定时任务靠左；一键测试/运行采集靠右 */}
        <div className="controls" style={{ marginTop: 8 }}>
          <button id="saveAsJob" className="btn-ghost btn-sm" style={{ alignSelf: 'center' }} onClick={saveAsJob}>
            存为定时任务 →
          </button>
          <button id="testBtn" className="btn-ghost" style={{ marginLeft: 'auto' }} onClick={openTest}>
            ⚡ 一键测试
          </button>
          <button id="runBtn" disabled={running} onClick={runCollect}>
            运行采集
          </button>
          <button id="stopBtn" className="btn-danger" hidden={!running} disabled={stopDisabled} onClick={stopCollect}>
            ■ 停止采集
          </button>
        </div>
        <div id="runResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
          {runJumpPlatform ? (
            <>
              <span style={{ fontFamily: 'inherit' }}>{runResult}</span>{' '}
              <button id="jumpData" className="btn-ghost" style={{ padding: '3px 10px' }} onClick={jumpToData}>
                查看采集结果 →
              </button>
            </>
          ) : (
            runResult
          )}
        </div>
        <div id="runLog" className="log-box" hidden={!logOpen} ref={logBoxRef}>
          {logLines.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
        <p className="hint">
          「一键测试」按当前已选平台 / 数据类型 / 查询词发真实请求，弹框展示<b>最终链接 → 运行状态（含本步技术通道）→ 响应内容 → 提取后数据</b>，顶部给出该平台「哪种技术效果最好」的结论（全量技术矩阵见系统设置页「数据抓取技术」面板）；确认通道可用后再运行采集。
        </p>
      </section>

      <section className="panel">
        <h2>字段提取诊断（本地 HTML 离线诊断）</h2>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          校准「采集时」的字段抽取（三层策略：① 浏览器启发式 ② CSS 选择器 ③ JSON-LD，逐字段报告命中与校准建议）。
          在线 URL 诊断已合并进「一键测试」弹框；本面板做<b>离线诊断</b>，HTML 文件<b>由你自己另存得到</b>，操作三步：
          ① 用浏览器打开目标商品/列表页 → 按 <code>Ctrl+S</code> 保存类型选「网页，仅 HTML」，存到本地任意位置；
          ② 点下方「选择 HTML 文件」选中该文件；③ 点「诊断所选文件」出报告。
          也可以直接体验：高级模式填项目自带样例 <code>data/fixtures/demo-products.html</code>。
        </p>
        <div className="controls">
          <label>
            数据类型
            <select id="dgKind" value={dgKind} onChange={(e) => setDgKind(e.target.value)}>
              <option value="product">商品</option>
              <option value="review">评论</option>
              <option value="qa">问答</option>
            </select>
          </label>
          <button id="dgFileBtn" className="btn-ghost" onClick={() => document.getElementById('dgFile')?.click()}>
            📂 ① 选择 HTML 文件
          </button>
          <span id="dgFileName" className="kv muted">
            {dgFile ? `${dgFile.name}（${(dgFile.size / 1024).toFixed(0)} KB）` : '未选择文件'}
          </span>
          <input
            type="file"
            id="dgFile"
            accept=".html,.htm"
            hidden
            onChange={(e) => setDgFile((e.target as HTMLInputElement).files?.[0] || null)}
          />
          <button id="dgBtn" disabled={!dgFile} onClick={runDiagnoseFile}>
            ② 诊断所选文件
          </button>
        </div>
        <div className="controls" style={{ marginTop: 8 }}>
          <label>
            （高级）直接填服务器可访问的 HTML 路径
            <input id="dgSource" type="text" style={{ minWidth: 320 }} placeholder="data/fixtures/demo-products.html" value={dgSource} onChange={(e) => setDgSource(e.target.value)} />
          </label>
          <button id="dgPathBtn" className="btn-ghost" onClick={runDiagnosePath}>
            诊断该路径
          </button>
        </div>
        <div id="dgResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
          {dgResult}
        </div>
      </section>

      <TestModal open={testOpen} meta={testMeta} cfg={testCfg} onClose={() => setTestOpen(false)} />
    </section>
  );
}
