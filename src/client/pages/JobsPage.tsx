import { useCallback, useEffect, useState } from 'react';
import { api, apiJson, fmtTime } from '../api';
import { useApp } from '../ctx';

const TYPES: Array<[string, string]> = [
  ['product', '商品'],
  ['review', '评论'],
  ['qa', '问答'],
];

export function JobsPage() {
  const app = useApp();
  const [jobs, setJobs] = useState<any[]>([]);
  const [runs, setRuns] = useState<any[]>([]);
  const [jobResult, setJobResult] = useState('');
  const [form, setForm] = useState({
    platform: '',
    dataType: 'product',
    query: '手机',
    everyMinutes: '60',
    limit: '20',
    withDetails: true,
    detailLimit: '3',
    enabled: true,
  });
  const setF = (patch: any) => setForm((f) => ({ ...f, ...patch }));

  const load = useCallback(async () => {
    try {
      setJobs(await apiJson('/api/jobs'));
    } catch {}
    try {
      setRuns(await apiJson('/api/jobs/runs'));
    } catch {}
  }, []);

  useEffect(() => {
    load();
  }, [app.page, load]);

  // 平台下拉：进入页面时若无选中值则取第一个平台
  useEffect(() => {
    if (!form.platform && app.platforms.length) setF({ platform: app.platforms[0].id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.platforms]);

  // 「存为定时任务」从采集工作台带入
  useEffect(() => {
    const pf = app.jobPrefill;
    if (pf && app.page === 'jobs') {
      setForm((f) => ({
        ...f,
        platform: pf.platform,
        dataType: pf.dataType,
        query: pf.query,
        limit: String(pf.limit),
        withDetails: !!pf.withDetails,
        detailLimit: String(pf.detailLimit || 3),
      }));
      setJobResult(pf.msg || '');
      app.setJobPrefill(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.jobPrefill, app.page]);

  const showDetailLimit = form.dataType === 'product' && form.withDetails;

  async function addJob() {
    const body = {
      platform: form.platform,
      dataType: form.dataType,
      query: form.query,
      everyMinutes: Number(form.everyMinutes),
      limit: Number(form.limit),
      withDetails: form.withDetails,
      detailLimit: Number(form.detailLimit) || 3,
      enabled: form.enabled,
    };
    setJobResult('添加中…');
    try {
      const r = await apiJson('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setJobResult('已添加：' + JSON.stringify(r));
      await load();
    } catch (e: any) {
      setJobResult('错误：' + e.message);
    }
  }

  async function runJob(id: string) {
    try {
      const r = await apiJson('/api/jobs/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setJobResult('运行结果：' + JSON.stringify(r));
      await load();
      await app.refreshStats();
    } catch (e: any) {
      setJobResult('错误：' + e.message);
    }
  }

  async function delJob(id: string) {
    try {
      await api(`/api/jobs?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      await load();
    } catch (e: any) {
      setJobResult('错误：' + e.message);
    }
  }

  return (
    <section className={`page${app.page === 'jobs' ? ' active' : ''}`} id="page-jobs">
      <section className="panel">
        <h2>定时采集任务</h2>
        <p className="hint" style={{ margin: '0 0 10px' }}>
          表单可从「采集工作台 → 存为定时任务」一键带入当前配置。
        </p>
        <div className="controls">
          <label>
            平台
            <select id="jobPlatform" value={form.platform} onChange={(e) => setF({ platform: e.target.value })}>
              {app.platforms.map((p: any) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            数据类型
            <select id="jobType" value={form.dataType} onChange={(e) => setF({ dataType: e.target.value })}>
              {TYPES.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            查询词
            <input id="jobQuery" type="text" placeholder="手机" value={form.query} onChange={(e) => setF({ query: e.target.value })} />
          </label>
          <label>
            周期(分钟)
            <input id="jobEvery" type="number" value={form.everyMinutes} min={1} onChange={(e) => setF({ everyMinutes: e.target.value })} />
          </label>
          <label>
            数量
            <input id="jobLimit" type="number" value={form.limit} min={1} onChange={(e) => setF({ limit: e.target.value })} />
          </label>
          <label className="check">
            <input id="jobDetails" type="checkbox" checked={form.withDetails} onChange={(e) => setF({ withDetails: e.target.checked })} /> 带详情(评论+问答+SPU/SKU)
          </label>
          <label id="jobDetailLimitWrap" hidden={!showDetailLimit}>
            详情数
            <input id="jobDetailLimit" type="number" value={form.detailLimit} min={1} max={20} onChange={(e) => setF({ detailLimit: e.target.value })} />
          </label>
          <label className="check">
            <input id="jobEnabled" type="checkbox" checked={form.enabled} onChange={(e) => setF({ enabled: e.target.checked })} /> 启用
          </label>
          <button id="addJobBtn" style={{ marginLeft: 'auto' }} onClick={addJob}>
            添加任务
          </button>
        </div>
        <div id="jobResult" className="result" style={{ whiteSpace: 'pre-wrap' }}>
          {jobResult}
        </div>
        <table id="jobTable" className="mini">
          <thead>
            <tr>
              <th>ID</th>
              <th>平台</th>
              <th>类型</th>
              <th>查询</th>
              <th>周期(分)</th>
              <th>带详情</th>
              <th>启用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length ? (
              jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.id}</td>
                  <td>{j.platform}</td>
                  <td>{j.dataType}</td>
                  <td>{j.query || ''}</td>
                  <td>{j.everyMinutes}</td>
                  <td>{j.withDetails ? `是（评论+问答+SPU/SKU，详情前 ${j.detailLimit || 3} 个）` : '否'}</td>
                  <td>{j.enabled ? '✅' : '⛔'}</td>
                  <td>
                    <button data-run={j.id} onClick={() => runJob(j.id)}>
                      运行
                    </button>
                    <button data-del={j.id} onClick={() => delJob(j.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>暂无任务</td>
              </tr>
            )}
          </tbody>
        </table>
        <h3 className="sub-h">运行记录</h3>
        <table id="runTable" className="mini">
          <thead>
            <tr>
              <th>任务</th>
              <th>平台</th>
              <th>类型</th>
              <th>状态</th>
              <th>条数</th>
              <th>信息</th>
              <th>完成时间</th>
            </tr>
          </thead>
          <tbody>
            {runs.length ? (
              runs.map((r, i) => (
                <tr key={i}>
                  <td>{r.job_id}</td>
                  <td>{r.platform}</td>
                  <td>{r.data_type}</td>
                  <td>{r.status}</td>
                  <td>{r.count}</td>
                  <td>{String(r.message || '').slice(0, 40)}</td>
                  <td>{fmtTime(r.finished_at)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7}>暂无运行记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </section>
  );
}
