import { useCallback, useEffect, useRef, useState } from 'react';
import { apiJson, fmtTime } from '../api';
import { useApp } from '../ctx';
import { Drawer } from '../components/Drawer';

// 单元格：超长截断 + 悬停看全文（与原版一致）
function Cell(props: { v: any; max?: number }) {
  const s = String(props.v ?? '');
  const max = props.max ?? 40;
  if (!s) return <span className="muted">—</span>;
  const shown = s.length > max ? s.slice(0, max) + '…' : s;
  return (
    <span title={s}>{shown}</span>
  );
}

function LinkCell(props: { url: any }) {
  const url = props.url;
  if (!url) return <span className="muted">—</span>;
  const href = url.startsWith('//') ? 'https:' + url : url;
  if (!/^https?:\/\//.test(href)) return <Cell v={url} max={24} />;
  return (
    <a href={href} target="_blank" rel="noopener">
      打开
    </a>
  );
}

export function DataPage() {
  const app = useApp();
  const table = app.table;
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [pgJumpVal, setPgJumpVal] = useState('');
  const [drawerRow, setDrawerRow] = useState<any>(null);
  const seqRef = useRef(0);
  const tableRef = useRef(table);
  tableRef.current = table;

  // 渲染序号令牌：筛选快速切换 / 轮询并发时，旧响应后到会覆盖新结果（表现为「筛选不生效」），
  // 只有最新一次请求允许写表格。
  const load = useCallback(async () => {
    const t = tableRef.current;
    const seq = ++seqRef.current;
    const q = new URLSearchParams({ type: t.type, page: String(t.page), pageSize: String(t.pageSize) });
    if (t.platform) q.set('platform', t.platform);
    if (t.search) q.set('q', t.search);
    try {
      const d = await apiJson(`/api/data?${q}`);
      if (seq !== seqRef.current) return;
      setRows(d.rows || []);
      setTotal(d.total || 0);
      setLoadError('');
    } catch (e: any) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setTotal(0);
      // 请求失败必须可见：过去静默吞掉错误，表格纹丝不动，看起来就像「筛选没联动」
      setLoadError('数据加载失败：' + e.message);
    }
  }, []);

  // 表格刷新信号 / 类型 / 分页 / 平台筛选：立即刷新
  useEffect(() => {
    load();
  }, [app.tableTick, table.type, table.page, table.pageSize, table.platform, load]);
  // 关键字：400ms 防抖（边输入边查）
  useEffect(() => {
    const id = setTimeout(load, 400);
    return () => clearTimeout(id);
  }, [table.search, load]);
  // 每次进入数据页都刷新（数据可能被采集/清空过）
  useEffect(() => {
    if (app.page === 'data') load();
  }, [app.page, load]);
  // 抽屉开合信号上报（统计轮询需要避开打断阅读）
  useEffect(() => {
    app.setDrawerOpen(!!drawerRow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawerRow]);

  const totalPages = Math.max(1, Math.ceil(total / table.pageSize));

  function downloadExport(format: string) {
    const a = document.createElement('a');
    // 导出跟随数据管理页当前筛选（平台/关键字），后端接口同样支持这两个参数
    let url = `/api/export?type=${table.type}&format=${format}`;
    if (table.platform) url += `&platform=${encodeURIComponent(table.platform)}`;
    if (table.search.trim()) url += `&q=${encodeURIComponent(table.search.trim())}`;
    a.href = url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  let tableHtml: any = '';
  if (table.type === 'product') {
    tableHtml = (
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>平台</th>
            <th>标题</th>
            <th>价格</th>
            <th>类目</th>
            <th>品牌</th>
            <th>销量</th>
            <th>店铺</th>
            <th>ItemId</th>
            <th>链接</th>
            <th>采集时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              <td>{(table.page - 1) * table.pageSize + i + 1}</td>
              <td>{r.platform}</td>
              <td>
                <Cell v={r.title} max={46} />
              </td>
              <td>¥{r.price}</td>
              <td>
                <Cell v={r.category} max={14} />
              </td>
              <td>
                <Cell v={r.brand} max={12} />
              </td>
              <td>{r.sales > 0 ? r.sales : <span className="muted">—</span>}</td>
              <td>
                <Cell v={r.shopName} max={16} />
              </td>
              <td>
                <Cell v={r.itemId} max={14} />
              </td>
              <td>
                <LinkCell url={r.url} />
              </td>
              <td>{fmtTime(r.collectedAt)}</td>
              <td>
                <button data-detail={i} style={{ padding: '2px 10px' }} onClick={() => setDrawerRow(r)}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (table.type === 'review') {
    tableHtml = (
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>平台</th>
            <th>商品</th>
            <th>评分</th>
            <th>内容</th>
            <th>作者</th>
            <th>标签</th>
            <th>评价时间</th>
            <th>采集时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              <td>{(table.page - 1) * table.pageSize + i + 1}</td>
              <td>{r.platform}</td>
              <td>
                <button
                  className="btn-ghost"
                  data-jumpprod={r.itemId || ''}
                  data-plat={r.platform}
                  style={{ padding: '1px 6px', fontSize: 12 }}
                  disabled={!r.itemId}
                  title="点击查看该商品"
                  onClick={() => app.jumpToProduct(r.platform, r.itemId)}
                >
                  {String(r.productTitle || '—').slice(0, 24)}
                </button>
              </td>
              <td>{r.rating}★</td>
              <td>
                <Cell v={r.content} max={60} />
              </td>
              <td>{r.authorMasked}</td>
              <td>
                <Cell v={(r.tags || []).join(',')} max={10} />
              </td>
              <td>{fmtTime(r.createdAt)}</td>
              <td>{fmtTime(r.collectedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else if (table.type === 'qa') {
    tableHtml = (
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>平台</th>
            <th>商品</th>
            <th>问题</th>
            <th>回答</th>
            <th>提问人</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              <td>{(table.page - 1) * table.pageSize + i + 1}</td>
              <td>{r.platform}</td>
              <td>
                <button
                  className="btn-ghost"
                  data-jumpprod={r.itemId || ''}
                  data-plat={r.platform}
                  style={{ padding: '1px 6px', fontSize: 12 }}
                  disabled={!r.itemId}
                  onClick={() => app.jumpToProduct(r.platform, r.itemId)}
                >
                  {String(r.productTitle || '—').slice(0, 24)}
                </button>
              </td>
              <td>
                <Cell v={r.question} max={40} />
              </td>
              <td>
                <Cell v={r.answer} max={40} />
              </td>
              <td>{r.askerMasked}</td>
              <td>{fmtTime(r.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <section className={`page${app.page === 'data' ? ' active' : ''}`} id="page-data">
      <section className="panel">
        <h2>数据管理</h2>
        <div className="controls filter-bar">
          <label>
            平台筛选
            <select id="dataPlatform" value={table.platform} onChange={(e) => app.refreshTable(false, { platform: e.target.value })}>
              <option value="">全部平台</option>
              {app.platforms.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            关键字搜索
            <input
              id="dataSearch"
              type="text"
              placeholder="标题 / 品牌 / 店铺 / itemId…"
              style={{ width: 220 }}
              value={table.search}
              onChange={(e) => app.setTableSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') app.refreshTable(false);
              }}
            />
          </label>
          <button id="dataSearchBtn" onClick={() => app.refreshTable(false)}>
            搜索
          </button>
          <button id="dataReset" className="btn-ghost" onClick={() => app.refreshTable(false, { platform: '', search: '' })}>
            重置筛选
          </button>
        </div>
        <div className="tabs">
          {[
            ['product', '商品'],
            ['review', '评论'],
            ['qa', '问答'],
          ].map(([t, label]) => (
            <button key={t} className={`tab${table.type === t ? ' active' : ''}`} data-type={t} onClick={() => app.refreshTable(false, { type: t })}>
              {label}
            </button>
          ))}
        </div>
        <div className="controls export-bar">
          <button id="expCsv" onClick={() => downloadExport('csv')}>
            导出当前类型 CSV
          </button>
          <button id="expJson" onClick={() => downloadExport('json')}>
            导出当前类型 JSON
          </button>
          <button id="dataClearBtn" className="btn-danger" style={{ marginLeft: 'auto' }} onClick={() => app.setClearOpen(true)}>
            🗑 清理数据…
          </button>
          <span className="hint">导出为当前筛选下的全量数据（不受分页影响），CSV / JSON 直接下载。</span>
        </div>
        <div id="tableWrap" className="table-wrap">
          {loadError ? <p style={{ color: '#9a3412' }}>{loadError}</p> : (
            <>
              {!rows.length && <p>暂无数据</p>}
              {tableHtml}
            </>
          )}
        </div>
        <div className="pager-bar">
          <label>
            每页
            <select
              id="pageSize"
              value={String(table.pageSize)}
              onChange={(e) => app.refreshTable(true, { pageSize: Number(e.target.value) })}
            >
              <option value="20">20 条</option>
              <option value="50">50 条</option>
              <option value="100">100 条</option>
            </select>
          </label>
          <button
            id="pgPrev"
            disabled={table.page <= 1}
            onClick={() => {
              if (table.page > 1) app.refreshTable(true, { page: table.page - 1 });
            }}
          >
            上一页
          </button>
          <span id="pgInfo" className="kv">
            共 {total} 条 ｜ 第 {table.page} / {totalPages} 页
          </span>
          <button
            id="pgNext"
            disabled={table.page >= totalPages}
            onClick={() => {
              if (table.page < totalPages) app.refreshTable(true, { page: table.page + 1 });
            }}
          >
            下一页
          </button>
          <label>
            跳转
            <input id="pgJump" type="number" min={1} style={{ width: 64 }} value={pgJumpVal} onChange={(e) => setPgJumpVal(e.target.value)} />
          </label>
          <button
            id="pgGo"
            onClick={() => {
              const n = Math.min(totalPages, Math.max(1, Number(pgJumpVal) || 1));
              app.refreshTable(true, { page: n });
            }}
          >
            跳转
          </button>
        </div>
        <p className="hint">
          点商品行的「详情」打开右侧抽屉：完整记录 + SPU / SKU 规格拆解 + 关联评论/问答；抽屉内可对缺详情的商品<b>补抓 SPU/SKU</b>。评论/问答的「商品」列可点击跳回对应商品。单元格悬停可看全文。
        </p>
      </section>

      <Drawer row={drawerRow} onClose={() => setDrawerRow(null)} onFresh={(fresh) => setDrawerRow(fresh)} />
    </section>
  );
}
