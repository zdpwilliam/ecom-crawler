import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';
import { useApp } from '../ctx';

// 数据清理确认弹框：展示将要删除的数据明细，二次确认（清理操作不可逆）。
// App 级渲染（Esc / 数据管理页入口均可触发），范围跟随数据管理页当前筛选。
export function ClearModal() {
  const app = useApp();
  const [scope, setScope] = useState('filter');
  const [counts, setCounts] = useState<any[]>([]);
  const [modalResult, setModalResult] = useState('');
  // 时序守卫：只接受最后一次 refreshCounts 的响应。
  // 背景（round29 事故）：过期响应在用户反勾选后返回 → setCounts 重渲染 → 若 counts 曾被清空，
  // checkbox 会重挂载并恢复 defaultChecked(勾选) → 护栏读到全勾 → 误清全量数据。此 ref 防并发竞态。
  const countSeq = useRef(0);
  const jobsRef = useRef<HTMLInputElement>(null);
  const exportsRef = useRef<HTMLInputElement>(null);
  const countsBoxRef = useRef<HTMLDivElement>(null);

  const scopeParams = () => {
    if (scope === 'filter') return { platform: app.table.platform || '', q: (app.table.search || '').trim() };
    return { platform: '', q: '' };
  };

  const scopeInfo = (() => {
    if (scope === 'all') return '范围：全部数据（忽略筛选）';
    const { platform, q } = scopeParams();
    const parts: string[] = [];
    if (platform) parts.push(`平台=${platform}`);
    if (q) parts.push(`关键字="${q}"`);
    return '范围：' + (parts.length ? parts.join(' 且 ') : '（未设筛选 = 全部数据）');
  })();

  // 弹框统计：按当前范围实时查各类型条数，勾选项 = 将删除项
  async function refreshCounts() {
    const seq = ++countSeq.current; // 递增序号，仅最后一次响应生效
    const { platform, q } = scopeParams();
    const qs = (type: string) => {
      const p = new URLSearchParams({ type, pageSize: '1' });
      if (platform) p.set('platform', platform);
      if (q) p.set('q', q);
      return `/api/data?${p}`;
    };
    const list = await Promise.all(
      [
        ['product', '商品'],
        ['review', '评论'],
        ['qa', '问答'],
      ].map(async ([t, label]) => {
        try {
          const d = await apiJson(qs(t));
          return { type: t, label, n: d.total || 0 };
        } catch {
          return { type: t, label, n: '?' };
        }
      })
    );
    if (seq !== countSeq.current) return; // 过期响应：丢弃（防陈旧勾选态被重渲染抹掉）
    setCounts(list);
  }

  // 打开时重置结果并统计。注意：不清空 counts —— 清空会让 checkbox 卸载重挂载、
  // 恢复 defaultChecked 勾选态，抹掉用户已做的反勾选（round29 误清事故根因之一）。
  useEffect(() => {
    if (app.clearOpen) {
      setModalResult('');
      refreshCounts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.clearOpen, scope]);

  async function confirmClear() {
    // 勾选状态直接读 DOM（与原版一致：弹框内复选框不受 React 受控重渲染影响）
    const types = [...(countsBoxRef.current?.querySelectorAll('[data-clrtype]:checked') || [])].map(
      (c: any) => c.getAttribute('data-clrtype')
    );
    const jobs = !!jobsRef.current?.checked;
    const exportsToo = !!exportsRef.current?.checked;
    if (!types.length && !jobs && !exportsToo) {
      setModalResult('⚠ 请至少勾选一项要删除的内容。');
      return;
    }
    const { platform, q } = scopeParams();
    setModalResult('清空中…');
    try {
      const r = await apiJson('/api/storage/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true, types, jobs, exports: exportsToo, platform, q }),
      });
      const scopeTxt = platform || q ? '（按当前筛选范围）' : '（全部）';
      setModalResult(`✅ 已清空 ${r.removed ?? r.count ?? 0} 条${scopeTxt}${r.exportsRemoved ? `，导出文件 ${r.exportsRemoved} 个` : ''}。`);
      app.bumpStorage();
      app.refreshStats();
      app.refreshTable(false);
      refreshCounts(); // 刷新弹框内计数（应归零）
    } catch (e: any) {
      setModalResult('❌ 清空失败：' + e.message);
    }
  }

  return (
    <div
      id="clearModal"
      className="modal-mask"
      hidden={!app.clearOpen}
      onClick={(e) => {
        if (e.target === e.currentTarget) app.setClearOpen(false);
      }}
    >
      <div className="modal" style={{ maxWidth: 640 }}>
        <div className="modal-head">
          <h3>🗑 数据清理确认</h3>
          <button id="clearModalClose" className="btn-danger" onClick={() => app.setClearOpen(false)}>
            关闭
          </button>
        </div>
        <div className="modal-body">
          <p className="count" style={{ margin: '0 0 10px' }}>
            清空为<b style={{ color: '#b91c1c' }}>不可逆</b>操作。请核对下方将要删除的数据，确认后执行。所有增删会记入 <code>data/audit.log</code> 审计日志。
          </p>
          <div className="controls" style={{ marginBottom: 10 }}>
            <label>
              删除范围
              <select id="clrScope" value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="filter">当前筛选（数据管理页的平台 / 关键字）</option>
                <option value="all">全部数据（忽略筛选）</option>
              </select>
            </label>
            <span id="clrScopeInfo" className="kv" style={{ fontSize: 12, color: 'var(--warn-ink)' }}>
              {scopeInfo}
            </span>
          </div>
          <div id="clrCounts" ref={countsBoxRef} style={{ fontSize: 13 }}>
            {counts.length ? (
              <table style={{ maxWidth: 420 }}>
                <thead>
                  <tr>
                    <th>数据类型</th>
                    <th>该范围内条数</th>
                    <th>是否删除</th>
                  </tr>
                </thead>
                <tbody>
                  {counts.map(({ type, label, n }) => (
                    <tr key={type}>
                      <td>{label}</td>
                      <td>
                        <b>{n}</b> 条
                      </td>
                      <td>
                        <label className="check" style={{ display: 'flex' }}>
                          <input type="checkbox" data-clrtype={type} defaultChecked /> 删除
                        </label>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              '统计中…'
            )}
          </div>
          <div className="controls" style={{ marginTop: 10 }}>
            <label className="check">
              <input type="checkbox" id="clrJobs2" ref={jobsRef} /> 同时清空定时任务（含运行记录）
            </label>
            <label className="check">
              <input type="checkbox" id="clrExports2" ref={exportsRef} /> 同时清空导出文件
            </label>
          </div>
          <p className="hint">定时任务与导出文件不受「删除范围」筛选影响（任务本身无平台归属）。</p>
          <div className="controls" style={{ marginTop: 14 }}>
            <button id="clrConfirm" className="btn-danger" onClick={confirmClear}>
              确认清空所选数据
            </button>
            <span id="clrModalResult" className="kv" style={{ fontSize: 12 }}>
              {modalResult}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
