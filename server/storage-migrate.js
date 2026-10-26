// 存储后端数据迁移（SQLite ↔ MongoDB）
// 原则：
//   - 非破坏式：只向目标写入，绝不删除/修改源数据；可重复执行（按 id 幂等 upsert）。
//   - 范围：四类采集数据（product/review/qa/chat）+ 定时任务（jobs，按 id upsert）。
//     任务运行记录（job_runs）为各后端本地日志，不随迁移移动（源库保留，切回即见）。
//   - 进度：单例状态对象，前端轮询 /api/storage/migration 展示进度条。

const TYPES = ['product', 'review', 'qa', 'chat'];
const TYPE_LABEL = { product: '商品', review: '评论', qa: '问答', chat: '聊天', jobs: '定时任务' };

let state = {
  running: false,
  phase: '',
  done: 0,
  total: 0,
  pct: 0,
  error: null,
  result: null,
  startedAt: null,
  finishedAt: null,
};

export function migrationState() {
  return { ...state };
}

/** 构建指定后端的直接句柄（与 storage.js 门面同一套底层模块，连接共享）。 */
async function buildBackend(name) {
  if (name === 'mongodb') {
    const mod = await import('./storage-mongo.js');
    return mod.createMongoBackend();
  }
  const db = await import('./db.js');
  return {
    loadStore: () => db.loadStore(),
    stats: () => db.stats(),
    query: (o) => db.query(o),
    addRecords: (t, r) => db.addRecords(t, r),
    listJobs: () => db.listJobs(),
    saveJob: (j) => db.saveJob(j),
  };
}

function currentBackendName() {
  return (process.env.STORE_BACKEND || 'sqlite').toLowerCase();
}

/** 清洗记录：去掉 sqlite rowToApi 带出的蛇形冗余键与 mongo 的 _id，统一驼峰文档。 */
function sanitize(r) {
  const o = {};
  for (const [k, v] of Object.entries(r || {})) {
    if (k === '_id' || k.includes('_')) continue;
    o[k] = v;
  }
  return o;
}

/** 预检：源数据统计 + 目标连通性。返回 {ok, from, to, sourceCounts, sourceJobs, targetCounts, error} */
export async function preflight(target) {
  const from = currentBackendName();
  const to = target === 'mongodb' ? 'mongodb' : 'sqlite';
  const out = { ok: false, from, to, sourceCounts: {}, sourceJobs: 0, targetCounts: {}, targetJobs: 0, error: '' };
  try {
    const src = await buildBackend(from);
    await src.loadStore();
    out.sourceCounts = await src.stats();
    out.sourceJobs = (await src.listJobs()).length;
    if (to === from) {
      out.ok = true; // 同后端：允许预检通过，前端会提示无需切换
      return out;
    }
    const dst = await buildBackend(to);
    await dst.loadStore();
    out.targetCounts = await dst.stats();
    out.targetJobs = (await dst.listJobs()).length;
    out.ok = true;
  } catch (e) {
    out.error = to === 'mongodb' ? `MongoDB 连接失败：${e.message}（请确认本地 mongod 已启动，默认 27017）` : e.message;
  }
  return out;
}

/** 执行迁移（后台任务调用）。完成后由调用方负责 setBackend 切换与持久化。 */
export async function migrateData(fromName, toName) {
  state = {
    running: true, phase: '连接数据库', done: 0, total: 0, pct: 0,
    error: null, result: null, startedAt: new Date().toISOString(), finishedAt: null,
  };
  try {
    const src = await buildBackend(fromName);
    await src.loadStore();
    const dst = await buildBackend(toName);
    await dst.loadStore();

    const srcCounts = await src.stats();
    const jobs = await src.listJobs();
    state.total = TYPES.reduce((s, t) => s + (srcCounts[t] || 0), 0) + jobs.length;
    state.phase = '统计源数据';
    if (!state.total) state.pct = 100;

    const migrated = {};
    for (const t of TYPES) {
      const n = srcCounts[t] || 0;
      migrated[t] = 0;
      if (!n) continue;
      state.phase = `迁移${TYPE_LABEL[t]}`;
      const recs = await src.query({ type: t });
      for (let i = 0; i < recs.length; i += 200) {
        const batch = recs.slice(i, i + 200).map(sanitize);
        await dst.addRecords(t, batch);
        migrated[t] += batch.length;
        state.done += batch.length;
        state.pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 100;
      }
    }

    state.phase = '迁移定时任务';
    for (const j of jobs) {
      await dst.saveJob(j);
      state.done += 1;
      state.pct = state.total ? Math.min(100, Math.round((state.done / state.total) * 100)) : 100;
    }
    migrated.jobs = jobs.length;
    state.phase = '迁移完成';
    state.result = { from: fromName, to: toName, migrated, total: state.done };
  } catch (e) {
    state.error = e.message;
    state.phase = '迁移失败';
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
  return migrationState();
}

/** 后台任务：迁移 → 成功后切换后端并持久化。 */
export async function migrateAndSwitch(target, { setBackend, saveSettings }) {
  const from = currentBackendName();
  const to = target === 'mongodb' ? 'mongodb' : 'sqlite';
  await migrateData(from, to);
  if (state.error) {
    console.error(`[storage] 迁移失败，保持后端 ${from} 不变：`, state.error);
    return migrationState();
  }
  await setBackend(to);
  await saveSettings({ storageBackend: to });
  console.log(`[storage] 迁移完成并已切换后端：${from} → ${to}`);
  return migrationState();
}
