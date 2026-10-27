// 定时采集引擎：从数据库 jobs 表读取任务，按 everyMinutes 周期运行。
// 每个任务调用 runCollection 执行一次采集，结果写入 job_runs 表。
// 服务启动即自动拉起（见 index.js）；也可独立运行 scripts/scheduler.js。
import { listJobs, getJob, saveJob, logRun } from './storage.ts';
import { runCollection } from './collectors.ts';

let timers = [];
let started = false;

/** 立即执行某个任务并记录结果。 */
export async function runJob(jobId) {
  // getJob 走异步存储后端，必须 await（否则 job 是 Promise，job.enabled 恒 undefined → 任务静默失效）
  const job = await getJob(jobId);
  if (!job || !job.enabled) return null;
  const startedAt = new Date().toISOString();
  let status = 'ok';
  let count = 0;
  let message = '';
  try {
    const r = await runCollection({
      platform: job.platform,
      dataType: job.dataType,
      query: job.query,
      itemId: job.itemId,
      limit: job.limit,
      withDetails: job.withDetails,
      detailLimit: job.detailLimit,
    });
    status = r.status;
    count = r.count || 0;
    message = r.message || '';
  } catch (e) {
    status = 'failed';
    message = e.message;
  }
  const finishedAt = new Date().toISOString();
  logRun({ jobId, platform: job.platform, dataType: job.dataType, status, count, message, startedAt, finishedAt });
  return { jobId, status, count, message };
}

/** 启动调度器：为每个启用的任务注册定时器。 */
export async function startScheduler() {
  if (started) return;
  started = true;
  // 首次启动若无任何任务，种入一个「已禁用」的示例任务作为模板
  if ((await listJobs()).length === 0) {
    await saveJob({
      id: 'sample-suning-product',
      platform: 'suning',
      dataType: 'product',
      query: '手机',
      limit: 20,
      everyMinutes: 60,
      withDetails: true,
      enabled: false,
    });
    console.log('[scheduler] 已种入示例任务 sample-suning-product（默认禁用，可在仪表盘启用）');
  }
  const jobs = (await listJobs()).filter((j) => j.enabled);
  for (const job of jobs) {
    const ms = Math.max(60000, job.everyMinutes * 60000);
    const t = setInterval(() => {
      runJob(job.id).catch((e) => console.error(`[scheduler] job ${job.id} 运行异常:`, e.message));
    }, ms);
    timers.push(t);
    console.log(`[scheduler] 已注册定时任务 ${job.id} → ${job.platform}/${job.dataType}，每 ${job.everyMinutes} 分钟`);
  }
  if (!jobs.length) console.log('[scheduler] 当前无启用的定时任务（可在仪表盘 /api/jobs 添加）');
}

/** 停止所有定时器（进程退出前用）。 */
export function stopScheduler() {
  for (const t of timers) clearInterval(t);
  timers = [];
  started = false;
}
