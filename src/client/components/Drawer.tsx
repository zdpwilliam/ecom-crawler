import { useEffect, useState } from 'react';
import { apiJson, fmtTime } from '../api';

function Cell(props: { v: any; max?: number }) {
  const s = String(props.v ?? '');
  const max = props.max ?? 40;
  if (!s) return <span className="muted">—</span>;
  return (
    <span title={s}>
      {s.length > max ? s.slice(0, max) + '…' : s}
    </span>
  );
}

// SPU/SKU 规格拆解：spu/skus 翻译成维度×价格表；specs 其它字段（促销/市场价等）一并列出
function renderSpecs(specs: any): any {
  if (!specs || typeof specs !== 'object') return null;
  const spu = specs.spu || {};
  const skus = specs.skus || [];
  const label: any = {
    marketPrice: '市场价',
    discount: '促销',
    skuCode: 'SKU编码',
    skuCount: 'SKU数',
    tags: '标签',
    inStock: '有货',
    goodRate: '好评率',
    currency: '币种',
    stock: '库存',
    color: '颜色',
    version: '版本',
  };
  const propTable = specs.props && typeof specs.props === 'object' ? Object.entries(specs.props) : null;
  const extra = Object.entries(specs).filter(
    ([k]) => !['spu', 'skus', 'propGroups', 'props'].includes(k) && specs[k] !== '' && specs[k] != null
  );
  const nodes: any[] = [<h4 key="h-spu">SPU 商品信息</h4>];
  const spuFields = [
    ['标题', spu.title],
    ['品牌', spu.brandName || spu.brand],
    ['店铺', spu.shopName || spu.vendorName],
    ['类目', spu.categoryName],
    ['价格', spu.price ? '¥' + spu.price : ''],
    ['SPU', spu.spuId || spu.prodSpuId],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (spuFields.length) {
    nodes.push(
      <table key="t-spu">
        <tbody>
          {spuFields.map(([k, v]) => (
            <tr key={k as string}>
              <th style={{ width: 70 }}>{k}</th>
              <td>
                <Cell v={v} max={60} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  } else {
    nodes.push(
      <p key="p-spu" className="muted" style={{ fontSize: 12, margin: 0 }}>
        无结构化 SPU 字段（带详情采集后会出现）
      </p>
    );
  }
  if (extra.length) {
    nodes.push(
      <h4 key="h-extra">商品附加字段</h4>,
      <table key="t-extra">
        <tbody>
          {extra.map(([k, v]) => (
            <tr key={k}>
              <th style={{ width: 70 }}>{label[k] || k}</th>
              <td>
                <Cell v={typeof v === 'object' ? JSON.stringify(v) : v} max={60} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (propTable && propTable.length) {
    nodes.push(
      <h4 key="h-props">规格参数（{propTable.length} 项）</h4>,
      <table key="t-props">
        <tbody>
          {propTable.map(([k, v]) => (
            <tr key={k as string}>
              <th style={{ width: 110 }}>{k}</th>
              <td>
                <Cell v={String(v)} max={80} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  nodes.push(<h4 key="h-sku">SKU 明细（{skus.length} 条）</h4>);
  if (skus.length) {
    nodes.push(
      <table key="t-sku">
        <thead>
          <tr>
            <th>#</th>
            <th>SKU</th>
            <th>规格</th>
            <th>价格</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {skus.slice(0, 60).map((s: any, i: number) => {
            const name = s.name || s.skuName || s.title || s.skuId || `#${i + 1}`;
            const props = [s.props, s.spec, s.value, s.color, s.version].filter(Boolean).join(' / ');
            const price = s.price != null && s.price !== '' && Number(s.price) > 0 ? '¥' + s.price : '—';
            const status = s.stock === false || s.offline ? '下架' : s.stock === true ? '有货' : s.status || '—';
            return (
              <tr key={i}>
                <td>{i + 1}</td>
                <td>
                  <Cell v={s.skuId || ''} max={14} />
                </td>
                <td>
                  {String(name).slice(0, 40)}
                  {props ? (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {' '}
                      {String(props).slice(0, 40)}
                    </span>
                  ) : null}
                </td>
                <td>{price}</td>
                <td>{String(status).slice(0, 12)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
    if (skus.length > 60) {
      nodes.push(
        <p key="p-sku" className="hint">
          仅展示前 60 条，完整数据见下方 JSON。
        </p>
      );
    }
  } else {
    nodes.push(
      <p key="p-sku" className="muted" style={{ fontSize: 12, margin: 0 }}>
        该记录无 SKU 明细（可能未开启带详情采集）
      </p>
    );
  }
  return nodes;
}

export function Drawer(props: { row: any; onClose: () => void; onFresh?: (row: any) => void }) {
  const row = props.row;
  const [refetchText, setRefetchText] = useState('');
  const [refetchBusy, setRefetchBusy] = useState(false);
  const [related, setRelated] = useState<any>(null);

  // 商品抽屉「关联评论/问答」：按 itemId 精确过滤该商品的评论与问答（前 6 条）
  useEffect(() => {
    if (!row) return;
    setRefetchText('');
    (async () => {
      if (!row.itemId) {
        setRelated(
          <>
            <h4>关联评论 / 问答</h4>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>
              该记录无 itemId，无法关联
            </p>
          </>
        );
        return;
      }
      setRelated(
        <>
          <h4>关联评论 / 问答</h4>
          <p className="muted" style={{ fontSize: 12, margin: 0 }}>
            检索中…
          </p>
        </>
      );
      try {
        const [rv, qa] = await Promise.all([
          apiJson(`/api/data?type=review&platform=${encodeURIComponent(row.platform)}&q=${encodeURIComponent(row.itemId)}&pageSize=50`),
          apiJson(`/api/data?type=qa&platform=${encodeURIComponent(row.platform)}&q=${encodeURIComponent(row.itemId)}&pageSize=50`),
        ]);
        const rvRows = (rv.rows || []).filter((r: any) => r.itemId === row.itemId);
        const qaRows = (qa.rows || []).filter((r: any) => r.itemId === row.itemId);
        const node: any[] = [
          <h4 key="h">
            关联评论（{rvRows.length}）/ 问答（{qaRows.length}）
          </h4>,
        ];
        if (!rvRows.length && !qaRows.length) {
          node.push(
            <p key="empty" className="muted" style={{ fontSize: 12, margin: 0 }}>
              该商品暂无关联评论/问答。可勾选「带详情」采集，或点「补抓详情」一并购入。
            </p>
          );
        } else {
          if (rvRows.length) {
            node.push(
              <table key="rv">
                <thead>
                  <tr>
                    <th>评分</th>
                    <th>内容</th>
                    <th>作者</th>
                    <th>时间</th>
                  </tr>
                </thead>
                <tbody>
                  {rvRows.slice(0, 6).map((r: any, i: number) => (
                    <tr key={i}>
                      <td>{r.rating}★</td>
                      <td>
                        <Cell v={r.content} max={50} />
                      </td>
                      <td>{r.authorMasked || ''}</td>
                      <td>{fmtTime(r.createdAt || r.collectedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
          if (qaRows.length) {
            node.push(
              <table key="qa" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>问题</th>
                    <th>回答</th>
                  </tr>
                </thead>
                <tbody>
                  {qaRows.slice(0, 6).map((q: any, i: number) => (
                    <tr key={i}>
                      <td>
                        <Cell v={q.question} max={40} />
                      </td>
                      <td>
                        <Cell v={q.answer} max={40} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          }
        }
        setRelated(node);
      } catch (e: any) {
        setRelated(
          <>
            <h4>关联评论 / 问答</h4>
            <p style={{ color: '#9a3412', fontSize: 12 }}>
              检索失败：{e.message}
            </p>
          </>
        );
      }
    })();
  }, [row]);

  // Esc 关闭抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && row) props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row]);

  // 商品抽屉「补抓详情」：对该商品发一次真实详情请求，回填 SPU/SKU 到记录并刷新抽屉
  async function refetchDetail(p: any) {
    setRefetchBusy(true);
    setRefetchText('补抓中…（对该商品发一次真实详情请求，约需 5~60 秒）');
    try {
      const r = await apiJson('/api/detail-refetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: p.id }),
      });
      if (r.status === 'empty') {
        setRefetchText('⚠ ' + (r.message || '详情页未暴露 SPU/SKU 数据'));
      } else {
        setRefetchText('✅ ' + (r.message || '已更新'));
        // 拉回更新后的记录重开抽屉
        const d = await apiJson(`/api/data?type=product&platform=${encodeURIComponent(p.platform)}&q=${encodeURIComponent(p.itemId || p.title)}&pageSize=20`);
        const fresh = (d.rows || []).find((x: any) => x.id === p.id);
        if (fresh && props.onFresh) props.onFresh(fresh);
      }
    } catch (e: any) {
      setRefetchText('❌ ' + e.message);
    } finally {
      setRefetchBusy(false);
    }
  }

  if (!row) return null;

  const p = row;
  const specs = typeof p.specs === 'string' ? (() => { try { return JSON.parse(p.specs); } catch { return null; } })() : p.specs;
  const meta: Array<[string, any]> = [
    ['平台', p.platform],
    ['价格', p.price != null ? '¥' + p.price : '—'],
    ['品牌', p.brand || '—'],
    ['店铺', p.shopName || '—'],
    ['类目', p.category || '—'],
    ['销量', p.sales > 0 ? p.sales : '—'],
    ['ItemId', p.itemId],
    ['采集时间', fmtTime(p.collectedAt)],
  ];
  const hasDetail = !!(specs && (specs.spu || (specs.skus || []).length || specs.props));
  const imgs: string[] = Array.isArray(p.images)
    ? p.images
    : typeof p.images === 'string'
      ? (() => { try { return JSON.parse(p.images); } catch { return []; } })()
      : [];
  const absImg = (u: any) => (typeof u === 'string' && u ? (u.startsWith('//') ? 'https:' + u : u) : '');

  return (
    <div
      id="drawerMask"
      className="drawer-mask"
      hidden={!p}
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="drawer">
        <div className="drawer-head">
          <h3 id="drawerTitle">{p.title || `itemId=${p.itemId}`}</h3>
          <button id="drawerClose" className="btn-danger" onClick={props.onClose}>
            关闭
          </button>
        </div>
        <div id="drawerBody" className="drawer-body">
          <table>
            <tbody>
              {meta.map(([k, v]) => (
                <tr key={k}>
                  <th style={{ width: 76 }}>{k}</th>
                  <td>{String(v ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {p.url ? (
            <>
              <h4>商品链接</h4>
              <p style={{ margin: 0, fontSize: 13 }}>
                <a href={p.url.startsWith('//') ? 'https:' + p.url : p.url} target="_blank" rel="noopener">
                  {String(p.url).slice(0, 90)}
                </a>
              </p>
            </>
          ) : null}
          {imgs.length ? (
            <>
              <h4>商品图片（{imgs.length}）</h4>
              <div className="drawer-imgs">
                {imgs.slice(0, 12).map((u, i) => {
                  const a = absImg(u);
                  return a ? (
                    <a key={i} href={a} target="_blank" rel="noopener" title="点击查看原图">
                      <img src={a} loading="lazy" referrerPolicy="no-referrer" alt="" />
                    </a>
                  ) : null;
                })}
                {imgs.length > 12 ? (
                  <span className="hint" style={{ alignSelf: 'center' }}>
                    共 {imgs.length} 张，其余见 JSON
                  </span>
                ) : null}
              </div>
            </>
          ) : null}
          {p.description ? (
            <>
              <h4>商品描述</h4>
              <p
                className="drawer-desc"
                title="点击复制全文"
                style={{ cursor: 'pointer' }}
                onClick={() => navigator.clipboard.writeText(p.description || '')}
              >
                {String(p.description).slice(0, 600)}
                {p.description.length > 600 ? `…（共 ${p.description.length} 字，点击复制全文）` : ''}
              </p>
            </>
          ) : null}
          {renderSpecs(specs)}
          <div className="controls" style={{ margin: '12px 0 4px', paddingTop: 10, borderTop: '1px dashed var(--line)' }}>
            <button id="refetchBtn" className="btn-ghost" disabled={refetchBusy} onClick={() => refetchDetail(p)}>
              🔄 补抓详情（描述/图片/SPU/SKU）
            </button>
            <span id="refetchResult" className="hint" style={{ flex: 1 }}>
              {refetchText || (hasDetail ? '已有详情数据，可重新补抓刷新。' : '该商品缺详情数据，点按钮补抓（需真实访问详情页）。')}
            </span>
          </div>
          <div id="drawerRelated">{related}</div>
          <h4>完整记录（JSON）</h4>
          <pre className="drawer-json">{JSON.stringify(p, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}
