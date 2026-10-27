// 独立运行定时采集调度器（也可随服务自动启动）。
// node scripts/scheduler.js
import { loadStore, listJobs } from '../server/storage.ts';
import { startScheduler, stopScheduler, runJob } from '../server/scheduler.ts';

await loadStore();

// 若命令行带 --run <jobId>，则只立即跑一次该任务后退出。
const runId = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : null;
if (runId) {
  runJob(runId)
    .then((r) => {
      console.log('运行结果：', r);
      process.exit(0);
    })
    .catch((e) => {
      console.error('运行失败：', e.message);
      process.exit(1);
    });
} else {
  await startScheduler();
  const jobs = (await listJobs()).filter((j) => j.enabled);
  console.log(`调度器已启动，共 ${jobs.length} 个启用任务。Ctrl+C 退出。`);
  process.on('SIGINT', () => {
    stopScheduler();
    process.exit(0);
  });
}
