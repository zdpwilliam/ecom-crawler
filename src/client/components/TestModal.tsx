import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';

// 一键测试（采集前体检）：按当前工作台配置发真实请求，逐步展示
// 最终链接 → 运行状态 → 响应内容 → 提取后的数据，并支持逐步「字段诊断」。
function stepIcon(s: any) {
  return s.ok ? '✅' : (s.detail || '').startsWith('跳过') || (s.detail || '').startsWith('该平台暂不') ? '⏭' : '❌';
}

export function TestModal(props: { open: boolean; meta: string; cfg: any; onClose: () => void }) {
  const [meta, setMeta] = useState('');
  const [body, setBody] = useState<any>(null);
  const runningRef = useRef(false);

  async function runTest(cfg: any) {
    if (!cfg || runningRef.current) return;
    runningRef.current = true;
    setMeta(`（${cfg.platform} · ${cfg.dataType} · ${String(cfg.query).slice(0, 24)}）`);
    setBody(
      <p className="count">测试中…（每步走完整引擎：代理池 + 指纹 + 浏览器渲染；商品类型走 列表→详情→评价→问答 全链路，约需 10~120 秒）</p>
    );
    try {
      const r = await apiJson('/api/test-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const pass = r.steps.filter((s: any) => s.ok).length;
      const savedNote = (r.savedTotal || 0) > 0 ? `通过步骤的数据已自动入库 ${r.savedTotal} 条（按链接去重）` : '本次测试无入库数据（未通过或为空结果）';
      setBody(
        <>
          <p className="count" style={{ margin: '0 0 8px' }}>
            测试目标：{r.target || '—'} ｜ 通过 {pass}/{r.steps.length} 项 ｜ {savedNote}
          </p>
          {r.tech?.best ? (
            <p className="count" style={{ margin: '0 0 8px', padding: '6px 10px', background: 'var(--bg-soft, #f7f7f8)', borderLeft: '3px solid var(--accent)' }}>
              🎯 该平台最佳技术：<b>{r.tech.best}</b>
            </p>
          ) : null}
          {r.steps.map((s: any) => (
            <TestStep key={s.key} s={s} platform={cfg.platform} />
          ))}
        </>
      );
    } catch (e: any) {
      setBody(<p style={{ color: '#9a3412' }}>测试失败：{e.message}</p>);
    } finally {
      runningRef.current = false;
    }
  }

  useEffect(() => {
    if (props.open) runTest(props.cfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.cfg]);

  // Esc 关闭（测试进行中不允许误关）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && props.open && !runningRef.current) props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  return (
    <div
      id="testModal"
      className="modal-mask"
      hidden={!props.open}
      onClick={(e) => {
        if (e.target === e.currentTarget && !runningRef.current) props.onClose();
      }}
    >
      <div className="modal modal--wide">
        <div className="modal-head">
          <h3>
            ⚡ 一键测试（采集前体检） <span id="testModalMeta" className="muted">{meta || props.meta}</span>
          </h3>
          <div style={{ display: 'flex', gap: 8 }}>
            <button id="testModalRerun" onClick={() => runTest(props.cfg)}>
              重新测试
            </button>
            <button id="testModalClose" className="btn-danger" onClick={props.onClose}>
              关闭
            </button>
          </div>
        </div>
        <div id="testModalBody" className="modal-body">
          {body}
        </div>
      </div>
    </div>
  );
}

function TestStep(props: { s: any; platform: string }) {
  const { s, platform } = props;
  const [diagContent, setDiagContent] = useState<any>(null);

  async function runDiagnose() {
    setDiagContent('字段诊断中…（拉取页面并核对每个字段的选择器命中）');
    try {
      const r = await apiJson('/api/diagnose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform, url: s.url, kind: 'product' }),
      });
      if (!r.ok) {
        setDiagContent('诊断失败：' + (r.reason || r.error || '未知原因'));
        return;
      }
      setDiagContent(
        <>
          <p style={{ margin: '0 0 6px' }}>
            页面 {(r.htmlSize / 1024).toFixed(0)}KB ｜ 可用策略：{r.strategy} ｜ 建议：{r.advice}
          </p>
          <table>
            <thead>
              <tr>
                <th>字段</th>
                <th>选择器</th>
                <th>命中</th>
                <th>样例</th>
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
                  <td>{(f.sample || []).join(' ｜ ').slice(0, 60) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      );
    } catch (e: any) {
      setDiagContent('诊断失败：' + e.message);
    }
  }

  return (
    <div className="test-step" data-key={s.key}>
      <p className="test-step-head">
        <b>
          {stepIcon(s)} {s.label}
        </b>
        <span className={`badge ${s.ok ? 'ok' : 'off'}`}>{s.ok ? '通过' : '未通过'}</span>
        {s.count ? <span className="badge">{s.count} 条</span> : null}
        {s.saved ? (
          <span className="badge ok">入库 {s.saved}</span>
        ) : null}
        {s.ms ? <span className="badge">{(s.ms / 1000).toFixed(1)}s</span> : null}
        {s.tech ? (
          <span className="badge" title={`本步骤使用的技术通道：${s.tech}`}>
            ⚙ {s.tech.length > 22 ? s.tech.slice(0, 22) + '…' : s.tech}
          </span>
        ) : null}
        <button className="btn-ghost" data-diag={s.key} data-url={s.url || ''} style={{ padding: '2px 10px', marginLeft: 'auto' }} onClick={runDiagnose}>
          🔬 字段诊断
        </button>
      </p>
      {s.url ? (
        <p className="test-step-url">
          最终链接：
          <a href={s.url.startsWith('http') ? s.url : 'https://' + s.url} target="_blank" rel="noopener">
            {String(s.url).slice(0, 110)}
          </a>
        </p>
      ) : null}
      <p className="test-detail">{s.detail || ''}</p>
      {s.responseText ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent)' }}>展开响应内容</summary>
          <pre className="test-pre">{s.responseText}</pre>
        </details>
      ) : null}
      {s.dataText && s.dataText !== s.responseText ? (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--accent)' }}>展开提取后的数据</summary>
          <pre className="test-pre">{s.dataText}</pre>
        </details>
      ) : null}
      <pre className="test-pre diag-result" hidden={!diagContent}>
        {diagContent}
      </pre>
    </div>
  );
}
