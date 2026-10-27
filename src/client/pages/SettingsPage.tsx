import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiJson, fmtBytes, fmtTime } from '../api';
import { useApp } from '../ctx';

const LOGIN_STATUS_TEXT: any = {
  valid: '已登录 · 有效',
  invalid: '已失效',
  probable: '疑似有效（未实测）',
  expired: 'Cookie 已全部过期',
  absent: '未登录（无 Cookie）',
  unknown: '无法判定',
  none: '无需登录',
};
const loginBadgeCls = (status: string) => (status === 'valid' ? 'ok' : status === 'none' ? '' : 'off');
const FP_MODE_TEXT: any = { mixed: '混合端', desktop: '仅桌面端', mobile: '仅手机端' };
const beLabel = (name: string) => (name === 'mongodb' ? 'MongoDB' : 'SQLite');

export function SettingsPage() {
  const app = useApp();

  // ---------- 平台登录状态 ----------
  const [lgMeta, setLgMeta] = useState('登录状态：加载中…');
  const [loginStatus, setLoginStatus] = useState<any>(null);
  const [lgInterval, setLgInterval] = useState('30');
  const [lgPlatform, setLgPlatform] = useState('');
  const [lgCookieJson, setLgCookieJson] = useState('');
  const [lgSaveResult, setLgSaveResult] = useState<string | null>(null);
  const [busy, setBusy] = useState<any>({});
  // 🩺 检测过程日志弹窗：entries 按发起顺序累积（全部检测从上到下逐平台追加）
  const [checkLogOpen, setCheckLogOpen] = useState(false);
  const [checkLogEntries, setCheckLogEntries] = useState<any[]>([]); // {platform, lines, done, status}
  const upsertCheckLog = (platform: string, patch: any) => {
    setCheckLogEntries((es: any[]) => {
      const i = es.findIndex((e) => e.platform === platform);
      if (i === -1) return [...es, { platform, lines: [], done: false, ...patch }];
      const n = [...es];
      n[i] = { ...n[i], ...patch };
      return n;
    });
  };
  const [cookieModal, setCookieModal] = useState<any>(null); // {title, body}
  const ckDataRef = useRef<any[]>([]);
  const extractTimer = useRef<any>(null);
  const lgSeq = useRef(0); // 时序守卫：丢弃过期的登录状态响应

  const loadLoginStatus = useCallback(async () => {
    const seq = ++lgSeq.current;
    try {
      const d = await apiJson('/api/login/status');
      if (seq !== lgSeq.current) return; // 已有更新一次的请求发出，丢弃本次
      setLoginStatus(d);
      setLgMeta(`上次检测：${d.at ? fmtTime(d.at) : '尚未检测'} ｜ 定时检测：${d.intervalMin > 0 ? `每 ${d.intervalMin} 分钟` : '已关闭'}`);
    } catch (e: any) {
      setLgMeta('登录状态加载失败：' + e.message);
    }
  }, []);

  useEffect(() => {
    loadLoginStatus();
  }, [app.loginTick, loadLoginStatus]);
  useEffect(() => {
    if (app.page === 'settings') loadLoginStatus();
  }, [app.page, loadLoginStatus]);

  // 一键提取登录态核心：服务端拉起系统 Chrome，用户登录后 cookie-tool 自动保存。
  // 系统设置「重新登录」与登录状态表共用；保存成功后自动重测。
  function launchCookieExtract(platform: string, onSaved?: (p: string) => Promise<void>) {
    setLgMeta('正在弹出浏览器…（约需 2~5 秒）');
    (async () => {
      let baseline = '';
      try {
        // 基线用「条数:mtime」指纹而非文件名列表：重登场景下同名文件被重新保存也能感知
        baseline = JSON.stringify((await apiJson('/api/cookies')).fingerprint || {});
        await apiJson('/api/cookies/extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform }),
        });
        setLgMeta(`浏览器已弹出：请在窗口内登录「${platform}」，登录成功后自动保存（10 分钟内有效）。保存后自动重测并刷新本表。`);
      } catch (e: any) {
        setLgMeta('启动失败：' + e.message);
        return;
      }
      // 轮询 Cookie 指纹：文件内容变化（新文件 / 同名文件重新保存）即认为保存成功
      const t0 = Date.now();
      clearInterval(extractTimer.current);
      extractTimer.current = setInterval(async () => {
        try {
          const c = await apiJson('/api/cookies');
          if (JSON.stringify(c.fingerprint || c.files) !== baseline) {
            clearInterval(extractTimer.current);
            setLgMeta(`✅ ${platform} 登录态已保存，正在重新检测有效性…`);
            // 联动：登录态变化后刷新工作台平台信息卡（若当前平台一致）
            if (app.platform === platform) app.bumpPlatCard();
            if (onSaved) await onSaved(platform);
            return;
          }
          if (Date.now() - t0 > 600000) {
            clearInterval(extractTimer.current);
            setLgMeta('等待超时（10 分钟）未检测到保存。若已登录仍未保存，请重试一次。');
          }
        } catch {}
      }, 3000);
    })();
  }

  // 登录状态表「重新登录」：对失效/缺失的平台直接弹出浏览器重登，保存后自动重测
  function reloginUi(platform: string) {
    // 联动工作台平台下拉（保证全局平台一致）
    if (app.platforms.some((o: any) => o.id === platform)) app.setPlatform(platform);
    launchCookieExtract(platform, async (p) => {
      await loadLoginStatus();
      // 静默复测：不弹检测日志窗（弹窗会遮挡页面，自动触发的检测不应打断用户操作）
      checkLoginUi(p, { silent: true });
    });
  }

  // silent=true：重登保存后的自动复测，不开弹窗只更新状态行（手动点「检测」才弹窗）
  async function checkLoginUi(platform: string, opts?: { silent?: boolean }) {
    const silent = !!opts?.silent;
    setBusy((b: any) => ({ ...b, [platform]: 'check' }));
    // 弹窗展示检测验证过程日志
    if (!silent) {
      setCheckLogOpen(true);
      upsertCheckLog(platform, { lines: [], done: false });
    }
    setLgMeta(`正在检测 ${platform} 登录态（真实请求验证，约需数秒到数十秒）…`);
    try {
      const r = await apiJson('/api/login/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      if (!silent) upsertCheckLog(platform, { lines: r.logs || [], done: true, status: r.status, detail: r.detail });
      setLgMeta(`${platform} 检测完成：${LOGIN_STATUS_TEXT[r.status] || r.status}${r.detail ? ` · ${r.detail}` : ''}`);
      await loadLoginStatus();
      if (app.platform === platform) app.bumpPlatCard();
    } catch (e: any) {
      if (!silent) upsertCheckLog(platform, { lines: [`请求失败：${e.message}`], done: true });
      setLgMeta(`检测失败：${e.message}`);
    } finally {
      setBusy((b: any) => {
        const n = { ...b };
        delete n[platform];
        return n;
      });
    }
  }

  // 「🌐 获取此浏览器态」：headless 读取提取浏览器档案中该平台的实时登录态，弹窗展示获取到的登录数据
  async function checkBrowserUi(platform: string) {
    setBusy((b: any) => ({ ...b, [platform]: 'browser' }));
    setLgMeta(`正在 headless 读取 ${platform} 的提取浏览器档案（约 10~40 秒，请勿同时对该平台点「🔑登录」）…`);
    try {
      const r = await apiJson('/api/login/check-browser', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform }),
      });
      const textMap: any = {
        'logged-in': '已登录',
        guest: '游客态（档案内无登录 Cookie）',
        uncertain: '疑似登录但未确认',
        'no-profile': '暂无浏览器档案（请先🔑登录）',
        unsupported: '该平台暂不支持浏览态判定',
        error: '读取失败',
      };
      setLgMeta(`${platform} 此浏览器态：${textMap[r.status] || r.status}${r.detail ? ` · ${r.detail}` : ''}`);
      const cookies = Array.isArray(r.cookies) ? r.cookies : [];
      ckDataRef.current = cookies;
      let body: any;
      if (r.status === 'no-profile' || r.status === 'unsupported' || r.status === 'error') {
        body = <p className="count">{r.detail || textMap[r.status] || ''}</p>;
      } else {
        body = (
          <>
            <p className="count">
              档案内实时读取到 <b>{cookies.length}</b> 条 Cookie ｜ 判定：<b>{textMap[r.status] || r.status}</b>
              {r.saved ? ' ｜ <b>已同步为采集用快照</b>' : ''}
              <br />
              <span className="muted">{r.detail || ''}</span>
            </p>
            {cookies.length ? (
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>名称</th>
                    <th>值（悬停看全文）</th>
                    <th>域</th>
                    <th>有效期</th>
                  </tr>
                </thead>
                <tbody>
                  {cookies.map((c: any, i: number) => (
                    <CookieRow key={i} c={c} short />
                  ))}
                </tbody>
              </table>
            ) : null}
          </>
        );
      }
      setCookieModal({ title: `此浏览器态（${platform}）`, body });
      await loadLoginStatus();
    } catch (e: any) {
      setLgMeta(`浏览态读取失败：${e.message}`);
      await loadLoginStatus();
    } finally {
      setBusy((b: any) => {
        const n = { ...b };
        delete n[platform];
        return n;
      });
    }
  }

  // 登录态 Cookie 内容查看弹窗
  async function viewCookies(platform: string) {
    const p = platform || 'vip';
    setCookieModal({ title: `（${p}）`, body: <p>加载中…</p> });
    try {
      const r = await apiJson(`/api/cookies/view?platform=${encodeURIComponent(p)}`);
      const cookies = r.cookies || [];
      ckDataRef.current = cookies;
      setCookieModal({
        title: `（${p}）`,
        body: (
          <>
            <p className="count">
              文件：{r.file} ｜ 共 {r.count} 条 ｜ 采集时自动注入全部条目
            </p>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>名称</th>
                  <th>值（悬停看全文）</th>
                  <th>域</th>
                  <th>有效期至</th>
                </tr>
              </thead>
              <tbody>
                {cookies.map((c: any, i: number) => (
                  <CookieRow key={i} c={c} />
                ))}
              </tbody>
            </table>
          </>
        ),
      });
    } catch (e: any) {
      ckDataRef.current = [];
      setCookieModal({ title: `（${p}）`, body: <p>加载失败：{e.message}</p> });
    }
  }

  async function copyCookiesJson() {
    const data = ckDataRef.current;
    if (!data.length) {
      alert('暂无可复制的 Cookie 内容。');
      return;
    }
    const text = JSON.stringify(data, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert(`已复制 ${data.length} 条 Cookie 的 JSON 到剪贴板。`);
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

  // 全部检测：弹窗内从上到下依次输出每个平台的检测过程日志（逐平台串行调用，完成一个出现一块）
  async function checkAllLoginUi() {
    const plats: string[] = loginStatus?.results ? Object.keys(loginStatus.results) : [];
    setCheckLogOpen(true);
    setCheckLogEntries([]);
    setLgMeta('正在全量检测所有平台（逐个发真实请求，约需 1~3 分钟）…');
    let ok = 0;
    for (const p of plats) {
      setBusy((b: any) => ({ ...b, [p]: 'check' }));
      upsertCheckLog(p, { lines: [], done: false });
      try {
        const r = await apiJson('/api/login/check', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform: p }),
        });
        upsertCheckLog(p, { lines: r.logs || [], done: true, status: r.status, detail: r.detail });
        if (r.status === 'valid') ok++;
      } catch (e: any) {
        upsertCheckLog(p, { lines: [`请求失败：${e.message}`], done: true });
      } finally {
        setBusy((b: any) => {
          const n = { ...b };
          delete n[p];
          return n;
        });
      }
    }
    setLgMeta(`全量检测完成：${plats.length ? `${ok}/${plats.length}` : '0'} 个平台有效。`);
    await loadLoginStatus();
    app.bumpPlatCard();
  }

  async function saveLoginInterval() {
    const v = Number(lgInterval);
    if (!Number.isFinite(v) || v < 0) {
      setLgMeta('间隔需为 ≥0 的整数分钟（0=关闭定时检测）。');
      return;
    }
    try {
      await apiJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginCheckMin: v }),
      });
      setLgMeta(v > 0 ? `已保存：每 ${v} 分钟自动检测一次登录态（立即生效）。` : '已保存：定时检测已关闭。');
      await loadLoginStatus();
    } catch (e: any) {
      setLgMeta('保存失败：' + e.message);
    }
  }

  async function saveLoginCookie() {
    const platform = lgPlatform;
    const raw = lgCookieJson.trim();
    if (!raw) {
      setLgSaveResult('请先粘贴 Cookie JSON（数组格式）。');
      return;
    }
    let cookies: any;
    try {
      cookies = JSON.parse(raw);
    } catch (e: any) {
      setLgSaveResult('JSON 解析失败：' + e.message);
      return;
    }
    setLgSaveResult('保存中…');
    try {
      const r = await apiJson('/api/login/save-cookie', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, cookies }),
      });
      setLgSaveResult(
        `✅ 已保存 ${r.count} 条 Cookie 到 data/cookies/${platform}.json。\n` +
          `登录状态：${LOGIN_STATUS_TEXT[r.login?.status] || r.login?.status}\n${r.login?.detail || ''}`
      );
      setLgCookieJson('');
      await loadLoginStatus();
      if (app.platform === platform) app.bumpPlatCard();
    } catch (e: any) {
      setLgSaveResult('保存失败：' + e.message);
    }
  }

  // ---------- 数据抓取技术 ----------
  const [tech, setTech] = useState<any>(null);
  useEffect(() => {
    apiJson('/api/tech-matrix')
      .then(setTech)
      .catch((e: any) => setTech({ error: e.message }));
  }, []);

  // ---------- 采集参数 ----------
  const [settings, setSettings] = useState<any>({});
  const [settingsResult, setSettingsResult] = useState('');
  const loadSettingsUi = useCallback(async () => {
    try {
      const s = await apiJson('/api/settings');
      setSettings(s);
      setLgInterval(String(s.loginCheckMin ?? 30));
      setFpMode(s.fpMode || 'mixed');
      setSettingsResult(
        `当前设置：延迟 ${s.delayMin}-${s.delayMax}ms ｜ 超时 ${s.timeout}ms ｜ 重试 ${s.retries} 次 ｜ 渲染等待 ${s.renderWait}ms ｜ Playwright:${s.usePlaywright ? '开' : '关'} ｜ 指纹随机化:${s.randomizeFingerprint ? '开' : '关'} ｜ 存储后端:${s.storageBackend}`
      );
    } catch (e: any) {
      setSettingsResult('错误：' + e.message);
    }
  }, []);
  useEffect(() => {
    loadSettingsUi();
  }, [loadSettingsUi]);

  const [setForm, setSetForm] = useState<any>({});
  useEffect(() => {
    if (settings.delayMin !== undefined) {
      setSetForm({
        delayMin: settings.delayMin,
        delayMax: settings.delayMax,
        timeout: settings.timeout,
        retries: settings.retries,
        renderWait: settings.renderWait,
        usePlaywright: !!settings.usePlaywright,
        randomizeFingerprint: !!settings.randomizeFingerprint,
      });
    }
  }, [settings]);
  const [savingSettings, setSavingSettings] = useState(false);

  async function saveSettingsUi() {
    const body = {
      delayMin: setForm.delayMin,
      delayMax: setForm.delayMax,
      timeout: setForm.timeout,
      retries: setForm.retries,
      renderWait: setForm.renderWait,
      usePlaywright: setForm.usePlaywright,
      randomizeFingerprint: setForm.randomizeFingerprint,
      fpMode,
    };
    setSavingSettings(true);
    try {
      setSettingsResult('保存中…');
      await apiJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await loadSettingsUi();
      // 在「当前设置」前追加显式保存成功标记，避免看起来像没反应
      setSettingsResult((prev: string) => `✅ 已保存 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ｜ ${prev}`);
    } catch (e: any) {
      setSettingsResult('保存失败：' + e.message);
    } finally {
      setSavingSettings(false);
    }
  }

  // ---------- 请求指纹随机化 ----------
  const [fpGenCount, setFpGenCount] = useState('5');
  const [fpGenKind, setFpGenKind] = useState('desktop');
  const [fpMode, setFpMode] = useState('mixed');
  const [fpModeStatus, setFpModeStatus] = useState('');
  const [fpResult, setFpResult] = useState('');
  const [fpPoolOpen, setFpPoolOpen] = useState(false);
  const [fpPool, setFpPool] = useState<any>(null);

  const fetchPool = useCallback(async (mode: string) => {
    try {
      const d = await apiJson(`/api/fingerprint/pool${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`);
      setFpPool(d);
    } catch (e: any) {
      setFpPool({ error: e.message });
    }
  }, []);

  // 指纹池明细：展开/收起展示当前端型模式子池的设备档案；每次展开都实时拉取（带当前端型 ?mode=），
  // 不做缓存——避免切换端型后仍显示旧池内容的时序问题。
  async function toggleFingerprintPool() {
    if (fpPoolOpen) {
      setFpPoolOpen(false);
      return;
    }
    await fetchPool(fpMode);
    setFpPoolOpen(true);
  }

  // 切换端型范围：保存到 settings.json（保存即生效），并刷新已展开的池明细
  async function changeFpMode(mode: string) {
    setFpMode(mode);
    try {
      await apiJson('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fpMode: mode }),
      });
      setFpModeStatus(`端型范围已切换为「${FP_MODE_TEXT[mode]}」并保存，对后续每次抓取立即生效。`);
      if (fpPoolOpen) await fetchPool(mode); // 重新展开渲染新端型子池
    } catch (e: any) {
      setFpResult('端型范围保存失败：' + e.message);
    }
  }

  // 生成指定数量指定端型的档案，追加至指纹池（持久化，采集时按端型范围参与抽档）
  async function appendFingerprints() {
    try {
      const r = await apiJson('/api/fingerprint/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: fpGenCount, kind: fpGenKind }),
      });
      const sample = (r.samples || []).map((s: any) => `· ${s.device}（${s.viewport[0]}×${s.viewport[1]}）`).join('\n');
      setFpResult(
        `✅ 已生成 ${r.added} 套「${fpGenKind === 'desktop' ? '仅桌面' : '仅手机'}」档案并入池，全池现有 ${r.poolSize} 套（端型范围保存后按子池抽取）。\n样例：\n${sample}`
      );
      if (fpPoolOpen) await fetchPool(fpMode); // 已展开则刷新明细
    } catch (e: any) {
      setFpResult('追加失败：' + e.message);
    }
  }

  // 清空追加档案，恢复基础真实设备池
  async function clearExtraFingerprints() {
    if (!confirm('确定清空全部追加档案、恢复基础 30 套设备池？')) return;
    try {
      const r = await apiJson('/api/fingerprint/extra', { method: 'DELETE' });
      setFpResult(`✅ 已清空 ${r.removed} 套追加档案，恢复基础池（现 ${r.poolSize} 套）。`);
      if (fpPoolOpen) await fetchPool(fpMode);
    } catch (e: any) {
      setFpResult('清空失败：' + e.message);
    }
  }

  // ---------- 代理池 ----------
  const [proxyInfo, setProxyInfo] = useState('代理池：加载中…');
  const [proxies, setProxies] = useState<any[]>([]);
  const [proxyInput, setProxyInput] = useState('');
  const lastTestRef = useRef<any>({});
  const proxySeq = useRef(0); // 时序守卫：丢弃过期的代理池响应

  const loadProxy = useCallback(async () => {
    const seq = ++proxySeq.current;
    try {
      const p = await apiJson('/api/proxy');
      if (seq !== proxySeq.current) return; // 过期响应丢弃
      const bad = (p.proxies || []).filter((x: any) => x.cooldownUntil > Date.now()).length;
      setProxyInfo(`代理池：共 ${p.poolSize} 个（冷却中 ${bad} 个）`);
      setProxies(p.proxies || []);
    } catch (e: any) {
      if (seq !== proxySeq.current) return;
      setProxyInfo('代理池加载失败：' + e.message);
    }
  }, []);
  useEffect(() => {
    loadProxy();
  }, [loadProxy]);

  async function addProxyUi() {
    let proxy = proxyInput.trim();
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
      setProxyInput('');
      await loadProxy();
      if (r.added === false) {
        alert('该代理已在池中，无需重复添加。');
      } else {
        // 添加成功后自动测一次速，立即反馈可用性
        setProxyInfo('已添加，测速中…（最多 6 秒）');
        try {
          const t = await apiJson('/api/proxy/test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          (t.results || []).forEach((x: any) => (lastTestRef.current[x.proxy] = x));
        } catch {}
        await loadProxy();
      }
    } catch (e: any) {
      alert('添加失败：' + e.message);
    }
  }

  async function testProxiesUi() {
    try {
      const cur = await apiJson('/api/proxy');
      if (!Number(cur.poolSize)) {
        setProxyInfo('代理池为空，无可测速的代理。请先添加。');
        return;
      }
    } catch {}
    setProxyInfo('测速中…（每条最多 6 秒，测完自动展示每条延迟/失败原因）');
    try {
      const r = await apiJson('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      lastTestRef.current = {};
      (r.results || []).forEach((x: any) => (lastTestRef.current[x.proxy] = x));
      await loadProxy();
      const ok = (r.results || []).filter((x: any) => x.ok);
      const fail = (r.results || []).filter((x: any) => !x.ok);
      let summary = `测速完成：${ok.length}/${r.results.length} 条可用`;
      if (ok.length) summary += `，延迟 ${Math.min(...ok.map((x: any) => x.ms))}-${Math.max(...ok.map((x: any) => x.ms))}ms`;
      if (fail.length) summary += `；失败 ${fail.length} 条（原因见列表，常见：VPN 未运行 / 端口填错 / 代理需要认证）`;
      setProxyInfo(summary);
    } catch (e: any) {
      setProxyInfo('测速失败：' + e.message);
    }
  }

  async function delProxyUi(proxy: string) {
    if (!confirm(`删除代理 ${proxy}？`)) return;
    await api(`/api/proxy?proxy=${encodeURIComponent(proxy)}`, { method: 'DELETE' });
    delete lastTestRef.current[proxy];
    await loadProxy();
  }

  // ---------- 存储管理 ----------
  const [backendInfo, setBackendInfo] = useState('后端：加载中…');
  const [storageInfo, setStorageInfo] = useState('加载中…');
  const [mig, setMig] = useState({ visible: false, pct: 0, text: '', cls: '' });
  const [beModal, setBeModal] = useState<any>(null); // {dir, info, confirmDisabled, target}

  const loadBackendInfo = useCallback(async () => {
    try {
      const b = await apiJson('/api/storage/backend');
      const label = b.backend === 'mongodb' ? (b.connected ? 'MongoDB（已连接）' : 'MongoDB（未连接）') : 'SQLite（文件库）';
      setBackendInfo(`当前后端：${label}`);
    } catch {}
  }, []);
  const loadStorage = useCallback(async () => {
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
      setStorageInfo(lines.join('\n'));
    } catch (e: any) {
      setStorageInfo('错误：' + e.message);
    }
  }, []);
  useEffect(() => {
    loadBackendInfo();
    loadStorage();
  }, [app.storageTick, loadBackendInfo, loadStorage]);

  // 点「切换到 SQLite / MongoDB」：先预检目标库，弹确认框展示校验结果与两侧数据统计
  async function switchBackend(name: string) {
    let cur = '';
    try {
      cur = (await apiJson('/api/storage/backend')).backend;
      if (cur === name) {
        alert(`当前已是 ${beLabel(name)} 后端，无需切换。`);
        return;
      }
    } catch {}
    let fromLabel = beLabel(name) === 'SQLite' ? 'MongoDB' : 'SQLite';
    try {
      const c = await apiJson('/api/storage/backend');
      fromLabel = beLabel(c.backend);
    } catch {}
    setBeModal({
      dir: (
        <>
          切换方向：<b>{fromLabel}</b> → <b>{beLabel(name)}</b>
        </>
      ),
      info: '正在校验目标库连通性与数据统计…',
      confirmDisabled: true,
      target: name,
    });
    try {
      const pf = await apiJson(`/api/storage/preflight?backend=${encodeURIComponent(name)}`);
      if (!pf.ok) {
        setBeModal((m: any) => ({ ...m, info: <p style={{ margin: 0, color: '#b91c1c' }}>❌ 校验未通过：{pf.error}</p> }));
        return; // 保持弹窗打开，用户可关闭后修复（如启动 mongod）
      }
      const fmt = (c: any) => `商品 ${c.product || 0} ｜ 评论 ${c.review || 0} ｜ 问答 ${c.qa || 0} ｜ 聊天 ${c.chat || 0}`;
      setBeModal((m: any) => ({
        ...m,
        confirmDisabled: false,
        info: (
          <>
            <p style={{ margin: '0 0 6px' }}>✅ 目标库连通性校验通过。</p>
            <p style={{ margin: '0 0 6px' }}>
              <b>源（{pf.from}）待迁移：</b>
              {fmt(pf.sourceCounts)} ｜ 定时任务 {pf.sourceJobs} 个
            </p>
            <p style={{ margin: 0 }}>
              <b>目标（{pf.to}）现有：</b>
              {fmt(pf.targetCounts)} ｜ 定时任务 {pf.targetJobs} 个（相同 id 将覆盖更新，其余保留）
            </p>
          </>
        ),
      }));
    } catch (e: any) {
      setBeModal((m: any) => ({ ...m, info: <p style={{ margin: 0, color: '#b91c1c' }}>❌ 预检失败：{e.message}</p> }));
    }
  }

  // 确认切换：启动「迁移 → 切换」后台任务，轮询进度条，完成后提醒
  async function confirmBackendSwitch() {
    const target = beModal?.target;
    if (!target) return;
    setBeModal((m: any) => ({ ...m, confirmDisabled: true }));
    let started: any;
    try {
      started = await apiJson('/api/storage/backend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: target, migrate: true }),
      });
    } catch (e: any) {
      alert('启动迁移失败：' + e.message);
      setBeModal((m: any) => ({ ...m, confirmDisabled: false }));
      return;
    }
    if (started.status !== 'started') {
      alert(started.error || '启动迁移失败。');
      setBeModal((m: any) => ({ ...m, confirmDisabled: false }));
      return;
    }
    setBeModal(null);
    setMig({ visible: true, pct: 0, text: '迁移任务已启动…', cls: '' });
    const timer = setInterval(async () => {
      let s: any;
      try {
        s = await apiJson('/api/storage/migration');
      } catch {
        return;
      }
      setMig({ visible: true, pct: s.pct || 0, text: `⏳ ${s.phase || '迁移中'}：${s.done}/${s.total}（${s.pct || 0}%）`, cls: '' });
      if (s.running) return;
      clearInterval(timer);
      if (s.error) {
        setMig({ visible: true, pct: s.pct || 0, text: `❌ 迁移失败：${s.error}（后端未切换，原数据不受影响，可修复后重试）`, cls: 'fail' });
        alert(`❌ 数据迁移失败：${s.error}\n后端保持不变，源数据不受影响，可修复后重试。`);
        return;
      }
      const m = s.result?.migrated || {};
      const sum = `商品 ${m.product || 0} ｜ 评论 ${m.review || 0} ｜ 问答 ${m.qa || 0} ｜ 聊天 ${m.chat || 0} ｜ 定时任务 ${m.jobs || 0}`;
      setMig({ visible: true, pct: 100, text: `✅ 迁移完成（${sum}），已切换到 ${beLabel(s.result?.to)}，立即生效。`, cls: 'done' });
      alert(`✅ 数据迁移完成！\n${sum}\n已切换到 ${beLabel(s.result?.to)} 并立即生效（源库数据原样保留，可随时切回）。`);
      loadBackendInfo();
      loadStorage();
      app.refreshStats();
    }, 500);
  }

  // Esc 关闭本页弹窗（Cookie / 后端切换）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCookieModal(null);
        setBeModal(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const rows: any[] = Object.values(loginStatus?.results || {});

  return (
    <section className={`page${app.page === 'settings' ? ' active' : ''}`} id="page-settings">
      {/* ═══ 面板 1 · 平台登录状态 ═══ */}
      <section className="panel">
        <h2>平台登录状态</h2>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          展示每个平台<b>是否需要登录</b>、<b>是否已保存登录信息</b>、以及登录态<b>是否真实有效</b>（用已保存 Cookie 发一次真实请求验证；无探针的平台按 Cookie 有效期推断）。采集会自动注入有效登录态。
        </p>
        <div className="controls">
          <span id="lgMeta" className="kv">
            {lgMeta}
          </span>
          <label>
            定时检测间隔(分钟)
            <input id="lgInterval" type="number" min={0} style={{ width: 76 }} value={lgInterval} onChange={(e) => setLgInterval(e.target.value)} />
          </label>
          <button id="lgSaveInterval" onClick={saveLoginInterval}>
            保存间隔
          </button>
          <button id="lgCheckAll" className="btn-ghost" onClick={checkAllLoginUi}>
            全部检测
          </button>
        </div>
        <div id="loginTable" className="table-wrap" style={{ marginTop: 10 }}>
          {rows.length ? (
            <table>
              <thead>
                <tr>
                  <th>平台</th>
                  <th>需要登录</th>
                  <th>已存 Cookie</th>
                  <th>登录状态</th>
                  <th>说明</th>
                  <th>检测时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const need = r.needLogin === '必需' ? <b style={{ color: '#9a3412' }}>必需</b> : r.needLogin === '推荐' ? '推荐' : '不需要';
                  const checking = busy[r.platform] === 'check';
                  const browsing = busy[r.platform] === 'browser';
                  // 所有平台都提供登录入口：即使「不需要登录」的平台，评论/问答等详情数据也常要求登录后才能拿到
                  return (
                    <tr key={r.platform}>
                      <td>{r.platform}</td>
                      <td>{need}</td>
                      <td>
                        {r.count > 0 ? (
                          // 不用 javascript: 伪协议（React 18 会告警）：无 href 的 <a> 同样可点击、样式走 a.ck-link
                          <a
                            className="ck-link"
                            data-ckview={r.platform}
                            title="点击查看 Cookie 明细"
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => {
                              e.preventDefault();
                              viewCookies(r.platform);
                            }}
                          >
                            {r.count} 条（过期 {r.expired}）
                          </a>
                        ) : (
                          <span className="muted">无</span>
                        )}
                      </td>
                      <td>
                        {checking ? (
                          <span className="badge">
                            <span className="dot" style={{ background: '#b45309' }}></span>检测中…
                          </span>
                        ) : browsing ? (
                          <span className="badge">
                            <span className="dot" style={{ background: '#b45309' }}></span>读取浏览器档案中…
                          </span>
                        ) : (
                          <span className={`badge ${loginBadgeCls(r.status)}`}>
                            <span className="dot"></span>
                            {LOGIN_STATUS_TEXT[r.status] || r.status}
                          </span>
                        )}
                      </td>
                      <td className="lg-detail" title={r.detail || ''}>
                        {checking ? '正在发真实请求验证该平台登录态，约需数秒到数十秒…' : r.detail || ''}
                      </td>
                      <td>{r.checkedAt ? fmtTime(r.checkedAt) : <span className="muted">—</span>}</td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <button data-lgrelogin={r.platform} className="btn-ghost btn-sm" disabled={checking || browsing} onClick={() => reloginUi(r.platform)}>
                              🔑 {r.count > 0 ? '重新登录' : '登录'}
                            </button>
                            <button data-lgcheck={r.platform} style={{ padding: '2px 10px', marginLeft: 'auto' }} disabled={checking || browsing} onClick={() => checkLoginUi(r.platform)}>
                              检测
                            </button>
                          </div>
                          <button
                            data-lgbrowser={r.platform}
                            className="btn-ghost btn-sm"
                            title="headless 读取提取浏览器档案的实时登录态并弹窗展示（已登录则同步为采集用快照，约 10~40 秒）"
                            disabled={checking || browsing}
                            onClick={() => checkBrowserUi(r.platform)}
                          >
                            🌐 获取此浏览器态
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <p className="muted">加载中…</p>
          )}
        </div>
        <div className="controls" style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
          <label>
            手动保存登录信息（平台）
            <select id="lgPlatform" value={lgPlatform} onChange={(e) => setLgPlatform(e.target.value)}>
              {app.platforms.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: 1, minWidth: 280 }}>
            Cookie JSON（数组，每条含 name/value；浏览器 DevTools → Application → Cookies 导出，或用 Playwright context.cookies()）
            <textarea
              id="lgCookieJson"
              rows={3}
              placeholder='[{"name":"sid","value":"xxx","domain":".taobao.com"}]'
              style={{ width: '100%', fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: 12 }}
              value={lgCookieJson}
              onChange={(e) => setLgCookieJson(e.target.value)}
            />
          </label>
          <button id="lgSaveCookie" onClick={saveLoginCookie}>
            保存并检测
          </button>
        </div>
        {lgSaveResult !== null && (
          <div id="lgSaveResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
            {lgSaveResult}
          </div>
        )}
        <p className="hint">
          保存后立即对该平台做一次真实有效性检测。也可在上方状态表点「🔑 重新登录」弹浏览器自动保存，两种方式等效，文件均为 <code>data/cookies/&lt;平台&gt;.json</code>。
        </p>
      </section>

      {/* ═══ 面板 2 · 采集参数 ═══ */}
      <section className="panel">
        <h2>采集参数（每次调用生效）</h2>
        <div className="controls">
          <label>
            随机延迟min(ms)
            <input id="setDelayMin" type="number" min={0} value={setForm.delayMin ?? ''} onChange={(e) => setSetForm((f: any) => ({ ...f, delayMin: e.target.value }))} />
          </label>
          <label>
            随机延迟max(ms)
            <input id="setDelayMax" type="number" min={0} value={setForm.delayMax ?? ''} onChange={(e) => setSetForm((f: any) => ({ ...f, delayMax: e.target.value }))} />
          </label>
          <label>
            单页超时(ms)
            <input id="setTimeout" type="number" min={1000} value={setForm.timeout ?? ''} onChange={(e) => setSetForm((f: any) => ({ ...f, timeout: e.target.value }))} />
          </label>
          <label>
            重试次数
            <input id="setRetries" type="number" min={1} max={10} value={setForm.retries ?? ''} onChange={(e) => setSetForm((f: any) => ({ ...f, retries: e.target.value }))} />
          </label>
          <label>
            渲染等待(ms)
            <input id="setRenderWait" type="number" min={0} value={setForm.renderWait ?? ''} onChange={(e) => setSetForm((f: any) => ({ ...f, renderWait: e.target.value }))} />
          </label>
          <label className="check">
            <input id="setUsePw" type="checkbox" checked={!!setForm.usePlaywright} onChange={(e) => setSetForm((f: any) => ({ ...f, usePlaywright: e.target.checked }))} /> 启用Playwright渲染
          </label>
          <label className="check">
            <input id="setRandFp" type="checkbox" checked={!!setForm.randomizeFingerprint} onChange={(e) => setSetForm((f: any) => ({ ...f, randomizeFingerprint: e.target.checked }))} /> 指纹随机化（固定真实设备池）
          </label>
          <button id="saveSettings" disabled={savingSettings} onClick={saveSettingsUi}>
            保存设置
          </button>
        </div>
        <div id="settingsResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
          {settingsResult}
        </div>
        <p className="hint">
          保存后<b>立即对后续每次抓取调用生效</b>，并持久化到 <code>data/settings.json</code>（重启保留）。调小延迟=更快但更易被封。指纹相关设置见下方「请求指纹随机化」子模块。
        </p>

        {/* 子模块 · 请求指纹随机化 */}
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--line)' }}>
          <h3 className="sub-h fp-title">请求指纹随机化</h3>
          <p className="hint fp-note">
            勾选上方「指纹随机化」后，每次抓取从<b>真实设备指纹池</b>中抽取一套完整档案（UA ↔ 操作系统 ↔ 视口 ↔ 语言 ↔ Client Hints 严格同源），并配合代理池轮换与伪造出口 IP。
            <br />
            <b>端型范围</b>决定从哪个子池抽档（基础池：混合 30 套 / 仅桌面 10 套 / 仅手机含平板 20 套）。
            <br />
            可用下方「生成并追加至指纹池」按指定数量与端型合成新档案入池（持久化到 <code>data/fingerprints-extra.json</code>，重启保留，同样受端型范围筛选）；「清空追加档案」恢复基础池。
          </p>
          <div className="controls">
            <label>
              生成数量
              <input id="fpGenCount" type="number" value={fpGenCount} min={1} max={50} style={{ width: 76 }} onChange={(e) => setFpGenCount(e.target.value)} />
            </label>
            <label>
              生成端型
              <select id="fpGenKind" value={fpGenKind} onChange={(e) => setFpGenKind(e.target.value)}>
                <option value="desktop">仅桌面</option>
                <option value="mobile">仅手机（含平板）</option>
              </select>
            </label>
            <button id="fpAppend" onClick={appendFingerprints}>
              生成并追加至指纹池
            </button>
            <button id="fpClear" className="btn-ghost" onClick={clearExtraFingerprints}>
              清空追加档案
            </button>
          </div>
          <div id="fpResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
            {fpResult}
          </div>
          <div className="controls" style={{ marginTop: 8 }}>
            <label>
              端型范围
              <select id="fpMode" value={fpMode} onChange={(e) => changeFpMode(e.target.value)}>
                <option value="mixed">混合端（桌面+手机）</option>
                <option value="desktop">仅桌面端</option>
                <option value="mobile">仅手机端（含平板）</option>
              </select>
            </label>
            <button id="fpPoolBtn" className="btn-ghost" onClick={toggleFingerprintPool}>
              {fpPoolOpen ? '收起指纹池明细' : '查看指纹池明细'}
            </button>
            <span id="fpModeStatus" className="kv">
              {fpModeStatus}
            </span>
          </div>
          <div id="fpPoolBox" className="table-wrap" style={{ marginTop: 10 }} hidden={!fpPoolOpen}>
            {fpPool?.error ? (
              <p style={{ color: '#9a3412', fontSize: 12 }}>指纹池加载失败：{fpPool.error}</p>
            ) : fpPool && !(fpPool.pool || []).length ? (
              <p className="count" style={{ margin: 0 }}>
                当前端型模式下子池为空。
              </p>
            ) : fpPool ? (
              <>
                <p className="count" style={{ margin: '0 0 6px' }}>
                  {FP_MODE_TEXT[fpPool.mode] || fpPool.mode || ''}子池（{(fpPool.pool || []).length} 套）：采集时每次请求从该子池随机抽取一套完整档案；端型范围可在上方「端型范围」切换（保存即生效）。设备名带「追加 ·」前缀的是生成追加的档案，其余为基础真实设备池（版本随主流浏览器人工更新）。
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>设备档案</th>
                      <th>平台</th>
                      <th>视口</th>
                      <th>端型</th>
                      <th>Client Hints (sec-ch-ua)</th>
                      <th>User-Agent（悬停看全文）</th>
                      <th>语言候选</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(fpPool.pool || []).map((f: any, i: number) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>
                          <b>{f.device}</b>
                        </td>
                        <td>{f.platform}</td>
                        <td>
                          {f.viewport[0]}×{f.viewport[1]}
                        </td>
                        <td>{f.mobile ? '移动' : '桌面'}</td>
                        <td>
                          {f.brand ? (
                            <span title={f.brand}>{f.brand.slice(0, 42)}…</span>
                          ) : (
                            <span className="muted">不发送</span>
                          )}
                        </td>
                        <td>
                          <span title={f.ua}>{f.ua.slice(0, 58)}…</span>
                        </td>
                        <td style={{ maxWidth: 150, whiteSpace: 'normal', fontSize: 11 }}>
                          {(f.langs || []).join(' | ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="muted">加载中…</p>
            )}
          </div>
        </div>
      </section>

      {/* ═══ 面板 2.5 · 数据抓取技术 ═══ */}
      <section className="panel">
        <h2>数据抓取技术</h2>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          本系统实际使用的抓取技术与各平台当前通道。<b>通道配置与代码实现一一对应</b>（搜索/详情直连与否由各平台适配器配置决定）；「一键测试」弹窗中每一步也会标注本步骤使用的技术通道。所有「直连接口」均为逆向网页端数据接口，<b>非官方开放 API</b>。
        </p>
        {tech?.error ? (
          <p style={{ color: '#9a3412' }}>技术矩阵加载失败：{tech.error}</p>
        ) : !tech ? (
          <p className="muted">加载中…</p>
        ) : (
          <>
            {/* 全站技术栈 */}
            <details className="diag" open style={{ marginBottom: 12 }}>
              <summary>全站技术栈（{tech.stack.length} 项，点击折叠）</summary>
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th style={{ width: 200 }}>技术</th>
                    <th>说明</th>
                    <th style={{ width: 220 }}>实现落点</th>
                  </tr>
                </thead>
                <tbody>
                  {tech.stack.map((t: any) => (
                    <tr key={t.key}>
                      <td>
                        <b>{t.name}</b>
                      </td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{t.desc}</td>
                      <td>
                        <code style={{ fontSize: 11 }}>{t.impl}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            {/* 各平台通道矩阵 */}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>平台</th>
                    <th>搜索通道</th>
                    <th>详情通道</th>
                    <th>登录要求</th>
                    <th>哪种技术效果最好</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(tech.matrix).map(([id, t]: [string, any]) => (
                    <tr key={id}>
                      <td>
                        <b>{t.name}</b>
                      </td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{t.search}</td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{t.detail}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{t.needLogin === '必需' ? <b style={{ color: '#9a3412' }}>必需</b> : t.needLogin}</td>
                      <td style={{ whiteSpace: 'normal', fontSize: 12 }}>{t.best}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">
              降级链路统一为：<b>直连接口 → 浏览器渲染（Patchright）→ fetch 直取（TLS 伪装）</b>，任一层失败自动换会话/指纹重试；详情页在直连失败时由浏览器响应捕获 + 内嵌 JSON 深搜兜底。
            </p>
          </>
        )}
      </section>

      {/* ═══ 面板 3 · 代理池 ═══ */}
      <section className="panel">
        <h2>代理池</h2>
        <div className="controls">
          <span id="proxyInfo" className="kv">
            {proxyInfo}
          </span>
          <button
            id="proxyReload"
            onClick={() =>
              api('/api/proxy/reload', { method: 'POST' })
                .then(() => loadProxy())
                .catch(() => {})
            }
          >
            重新载入代理
          </button>
          <button id="proxyTest" onClick={testProxiesUi}>
            一键测速
          </button>
        </div>
        <div className="controls" style={{ marginTop: 8 }}>
          <label>
            添加代理（VPN 本地端口 / 代理服务）
            <input
              id="proxyInput"
              type="text"
              placeholder="127.0.0.1:7890 或 http://user:pass@host:port（协议头可省略）"
              style={{ minWidth: 320 }}
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
            />
          </label>
          <button id="proxyAdd" onClick={addProxyUi}>
            添加代理
          </button>
          <span className="hint">
            VPN 客户端（Clash/V2Ray 等）通常在本地开 HTTP/SOCKS 端口，直接填 <code>127.0.0.1:端口</code> 即接入代理池。
          </span>
        </div>
        <div id="proxyList" className="result">
          {proxies.length ? (
            <table>
              <thead>
                <tr>
                  <th>代理</th>
                  <th>测速</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {proxies.map((x: any) => {
                  const t = lastTestRef.current[x.proxy];
                  let speed: any, status: any;
                  if (t) {
                    speed = t.ok ? `✅ ${t.ms}ms` : '❌ 失败';
                    status = t.ok ? (x.failures > 0 ? `成功(此前失败${x.failures}次)` : '正常') : t.error || '失败';
                  } else {
                    speed = x.lastLatencyMs != null ? x.lastLatencyMs + 'ms' : '未测速';
                    status = x.cooldownUntil > Date.now() ? '❄️冷却' : x.failures > 0 ? `失败${x.failures}次` : '正常';
                  }
                  return (
                    <tr key={x.proxy}>
                      <td>{x.proxy}</td>
                      <td>{speed}</td>
                      <td>{status}</td>
                      <td>
                        <button className="btn-danger" style={{ padding: '2px 8px' }} onClick={() => delProxyUi(x.proxy)}>
                          删除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            '代理池为空：直连本机 IP 抓取。建议添加 VPN 本地端口或代理服务，避免家庭 IP 直接暴露。'
          )}
        </div>
        <p className="hint">
          <b>代理池</b>：每次请求自动轮换（轮询挑一个不在冷却期的），失败自动冷却（5s 起指数退避，上限 60s）并换下一个；也可直接编辑 <code>data/proxies.txt</code>（每行一个）或用环境变量
          <code>CRAWL_PROXY_POOL</code>。
          <br />
          <b>登录态</b>：已由上方「平台登录状态」统一管理（查看 Cookie / 检测 / 重新登录），采集时自动注入有效 Cookie。
        </p>
        <details className="diag" id="proxyDiagram" open style={{ marginTop: 10 }}>
          <summary>代理传输原理图（请求是如何走代理的）</summary>
          <div style={{ marginTop: 8, overflowX: 'auto' }}>
            <ProxyDiagram />
          </div>
        </details>
      </section>

      {/* ═══ 面板 4 · 存储管理 ═══ */}
      <section className="panel">
        <h2>存储管理</h2>
        <div className="controls">
          <span id="backendInfo" className="kv">
            {backendInfo}
          </span>
          <button id="beSqlite" onClick={() => switchBackend('sqlite')}>
            切换到 SQLite
          </button>
          <button id="beMongo" onClick={() => switchBackend('mongodb')}>
            切换到 MongoDB
          </button>
        </div>
        <div id="storageInfo" className="result" style={{ whiteSpace: 'pre-wrap' }}>
          {storageInfo}
        </div>
        {/* 后端切换：迁移进度条 */}
        <div id="migBox" hidden={!mig.visible} style={{ marginTop: 12 }}>
          <div className="mig-bar">
            <div id="migFill" className={`mig-fill ${mig.cls}`} style={{ width: `${mig.pct}%` }}></div>
          </div>
          <p id="migText" className="hint" style={{ margin: '6px 0 0' }}>
            {mig.text}
          </p>
        </div>
        <p className="hint">
          切换需在确认弹窗中<b>校验目标库连通性</b>，确认后自动<b>迁移全部采集数据与定时任务</b>到目标库（迁移期间展示进度条，完成后弹窗提醒）。迁移为非破坏式：源库数据原样保留，可随时切回；任务运行记录随各自后端保留。数据清理入口在「数据管理」页（🗑 清理数据，弹框确认）。
        </p>
      </section>

      {/* 登录态 Cookie 内容查看弹窗 */}
      <div
        id="cookieModal"
        className="modal-mask"
        hidden={!cookieModal}
        onClick={(e) => {
          if (e.target === e.currentTarget) setCookieModal(null);
        }}
      >
        <div className="modal">
          <div className="modal-head">
            <h3>
              登录态 Cookie 内容 <span id="ckModalTitle" className="muted">{cookieModal?.title}</span>
            </h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button id="ckCopy" onClick={copyCookiesJson}>
                复制 JSON
              </button>
              <button id="ckModalClose" className="btn-danger" onClick={() => setCookieModal(null)}>
                关闭
              </button>
            </div>
          </div>
          <div id="ckModalBody" className="modal-body">
            {cookieModal?.body}
          </div>
        </div>
      </div>

      {/* 检测过程日志弹窗（单平台检测 / 全部检测共用；全部检测按发起顺序从上到下逐平台追加） */}
      <div
        id="checkLogModal"
        className="modal-mask"
        hidden={!checkLogOpen}
        onClick={(e) => {
          if (e.target === e.currentTarget) setCheckLogOpen(false);
        }}
      >
        <div className="modal" style={{ maxWidth: 760 }}>
          <div className="modal-head">
            <h3>🩺 登录态检测过程日志</h3>
            <button className="btn-danger" onClick={() => setCheckLogOpen(false)}>
              关闭
            </button>
          </div>
          <div className="modal-body" style={{ maxHeight: '62vh', overflowY: 'auto' }}>
            {!checkLogEntries.length ? (
              <p className="count">正在启动检测…</p>
            ) : (
              checkLogEntries.map((e: any) => (
                <div key={e.platform} data-checklog={e.platform} style={{ marginBottom: 14 }}>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {e.platform}
                    {e.done ? (
                      <span className="muted" style={{ marginLeft: 8 }}>
                        —— {LOGIN_STATUS_TEXT[e.status] || (e.status ? e.status : '完成')}
                        {e.detail ? ` · ${e.detail}` : ''}
                      </span>
                    ) : (
                      <span className="badge" style={{ marginLeft: 8 }}>
                        <span className="dot" style={{ background: '#b45309' }}></span>检测中…
                      </span>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: '4px 0 0',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      fontSize: 12,
                      lineHeight: 1.6,
                      background: 'var(--bg-soft, #f7f7f8)',
                      padding: '8px 10px',
                      borderRadius: 2,
                    }}
                  >
                    {e.lines && e.lines.length ? e.lines.join('\n') : '等待服务端返回…'}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 存储后端切换确认弹窗（含预检结果与迁移说明） */}
      <div
        id="beModal"
        className="modal-mask"
        hidden={!beModal}
        onClick={(e) => {
          if (e.target === e.currentTarget) setBeModal(null);
        }}
      >
        <div className="modal" style={{ maxWidth: 640 }}>
          <div className="modal-head">
            <h3>🔀 切换存储后端确认</h3>
            <button id="beModalClose" className="btn-danger" onClick={() => setBeModal(null)}>
              关闭
            </button>
          </div>
          <div className="modal-body">
            <p id="beModalDir" className="count" style={{ margin: '0 0 10px' }}>
              {beModal?.dir}
            </p>
            <div id="beModalInfo" style={{ fontSize: 13 }}>
              {beModal?.info}
            </div>
            <p className="hint" style={{ margin: '10px 0 0' }}>
              确认后自动把<b>全部采集数据与定时任务</b>迁移到目标库（进度条在存储管理面板展示，完成后弹窗提醒）。迁移为<b>非破坏式</b>：源库数据原样保留、可重复执行；任务运行记录随各自后端保留。迁移期间请勿发起采集。
            </p>
            <div className="controls" style={{ marginTop: 12 }}>
              <button id="beModalConfirm" disabled={beModal?.confirmDisabled} onClick={confirmBackendSwitch}>
                确认切换并迁移
              </button>
              <button id="beModalCancel" className="btn-ghost" onClick={() => setBeModal(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Cookie 行：值超长截断 + 悬停看全文（short=true 时截断更短，用于浏览器态弹窗）
function CookieRow(props: { c: any; short?: boolean }) {
  const c = props.c;
  let exp = '会话';
  if (c.expires != null && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
    const d = new Date(Number(c.expires) * 1000);
    exp = isNaN(d.getTime()) ? String(c.expires) : fmtTime(d.toISOString());
  }
  const max = props.short ? 26 : 70;
  const v = String(c.value || '');
  return (
    <tr>
      <td></td>
      <td>
        <code>{c.name}</code>
      </td>
      <td className="ck-val" title={v}>
        {v.length > max ? v.slice(0, max) + '…' : v}
      </td>
      <td>{c.domain || ''}</td>
      <td>{exp}</td>
    </tr>
  );
}

// 代理传输原理图（与原版一致的静态 SVG）
function ProxyDiagram() {
  const arrow = { stroke: '#1F4B63', strokeWidth: 1.5 };
  return (
    <svg viewBox="0 0 1000 350" width="100%" style={{ minWidth: 720, display: 'block' }} xmlns="http://www.w3.org/2000/svg" role="img" aria-label="代理传输原理图">
      <defs>
        <marker id="diagArw" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#1F4B63" />
        </marker>
        <marker id="diagArwG" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={7} markerHeight={7} orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="#6b7280" />
        </marker>
      </defs>
      <rect x={10} y={70} width={160} height={90} fill="#ffffff" stroke="#e2e2e2" />
      <text x={90} y={98} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1F4B63">① 采集请求</text>
      <text x={90} y={120} textAnchor="middle" fontSize={11} fill="#1f2933">服务端 Node 发起抓取</text>
      <text x={90} y={138} textAnchor="middle" fontSize={11} fill="#6b7280">fetch / Playwright</text>
      <rect x={200} y={70} width={180} height={90} fill="#ffffff" stroke="#e2e2e2" />
      <text x={290} y={98} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1F4B63">② 代理池选路</text>
      <text x={290} y={120} textAnchor="middle" fontSize={11} fill="#1f2933">pickProxy() 轮询取号</text>
      <text x={290} y={138} textAnchor="middle" fontSize={11} fill="#6b7280">自动跳过冷却中的代理</text>
      <rect x={410} y={70} width={180} height={90} fill="#ffffff" stroke="#e2e2e2" />
      <text x={500} y={98} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1F4B63">③ 协议适配 dispatcher</text>
      <text x={500} y={120} textAnchor="middle" fontSize={11} fill="#1f2933">http(s) → undici ProxyAgent</text>
      <text x={500} y={138} textAnchor="middle" fontSize={11} fill="#1f2933">socks4/5 → fetch-socks</text>
      <rect x={620} y={70} width={180} height={90} fill="#1F4B63" stroke="#1F4B63" />
      <text x={710} y={98} textAnchor="middle" fontSize={13} fontWeight={600} fill="#ffffff">④ 代理服务器</text>
      <text x={710} y={120} textAnchor="middle" fontSize={11} fill="#dbe7ee">VPN 本地端口 127.0.0.1:7890</text>
      <text x={710} y={138} textAnchor="middle" fontSize={11} fill="#dbe7ee">或 http://user:pass@host:port</text>
      <rect x={830} y={70} width={160} height={90} fill="#ffffff" stroke="#e2e2e2" />
      <text x={910} y={98} textAnchor="middle" fontSize={13} fontWeight={600} fill="#1F4B63">⑤ 目标电商站点</text>
      <text x={910} y={120} textAnchor="middle" fontSize={11} fill="#1f2933">只看到代理出口 IP</text>
      <text x={910} y={138} textAnchor="middle" fontSize={11} fill="#6b7280">（真实 IP 已隐藏）</text>
      <line x1={172} y1={115} x2={194} y2={115} {...arrow} markerEnd="url(#diagArw)" />
      <line x1={382} y1={115} x2={404} y2={115} {...arrow} markerEnd="url(#diagArw)" />
      <line x1={592} y1={115} x2={614} y2={115} {...arrow} markerEnd="url(#diagArw)" />
      <line x1={802} y1={115} x2={824} y2={115} {...arrow} markerEnd="url(#diagArw)" />
      <polyline points="910,162 910,190 90,190 90,240" fill="none" stroke="#6b7280" strokeWidth={1.2} strokeDasharray="5 4" markerEnd="url(#diagArwG)" />
      <text x={500} y={184} textAnchor="middle" fontSize={12} fill="#6b7280">响应沿原路返回（代理 → 协议适配 → 采集服务）</text>
      <rect x={10} y={245} width={250} height={66} fill="#fafafa" stroke="#e2e2e2" />
      <text x={135} y={268} textAnchor="middle" fontSize={12} fontWeight={600} fill="#1f2933">回程失败感知</text>
      <text x={135} y={288} textAnchor="middle" fontSize={11} fill="#6b7280">超时 / 连接拒绝 / 被重置</text>
      <rect x={310} y={245} width={290} height={66} fill="#fafafa" stroke="#e2e2e2" />
      <text x={455} y={268} textAnchor="middle" fontSize={12} fontWeight={600} fill="#1f2933">reportFailure：该代理进入冷却</text>
      <text x={455} y={288} textAnchor="middle" fontSize={11} fill="#6b7280">5s 起指数退避（×2），上限 60s</text>
      <rect x={650} y={245} width={340} height={66} fill="#fafafa" stroke="#e2e2e2" />
      <text x={820} y={268} textAnchor="middle" fontSize={12} fontWeight={600} fill="#1f2933">下次 pickProxy 自动跳过冷却代理</text>
      <text x={820} y={288} textAnchor="middle" fontSize={11} fill="#6b7280">成功则 reportSuccess 恢复健康度并重试换号</text>
      <line x1={262} y1={278} x2={304} y2={278} {...arrow} markerEnd="url(#diagArw)" />
      <line x1={602} y1={278} x2={644} y2={278} {...arrow} markerEnd="url(#diagArw)" />
      <text x={500} y={338} textAnchor="middle" fontSize={11} fill="#6b7280">
        {'Playwright 渲染路径：代理以 { server } 传入浏览器上下文，同样从代理池取号；与指纹随机化（UA/设备档案）叠加生效'}
      </text>
    </svg>
  );
}
