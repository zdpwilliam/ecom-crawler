// 全量冒烟测试统一入口：顺序跑全部冒烟脚本 + 单元测试，汇总结果。
// 用法：npm test（= node scripts/run-all-smoke.cjs）
// 说明：部分脚本含真实网络请求（round39 补抓/round40 采集），全量约 4~6 分钟；
//       单脚本失败不影响后续执行，最后统一汇总退出码。
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const TESTS = path.resolve(__dirname, '..', 'tests');
// 顺序即历史轮次顺序：单元测试最前（最快、无网络），冒烟按轮次，含真实网络的放最后
const SUITE = [
  'test-cookie-tool.mjs', // 单元：登录自动关闭决策（无网络，秒级）
  'test-opencli-adapter.mjs', // 单元：OpenCLI 桥接归一化（离线，秒级；末条跑真实 opencli 命令）
  'test-session-pool.mjs', // 单元：会话池三元绑定 + 封禁语义化 + 统计采样（离线，秒级）
  'test-doc-paths.mjs', // 单元：文档路径防漂移（README/COMPLIANCE 引用路径须存在、旧路径不得回流；离线，秒级）
  'smoke-new-ui.cjs',
  'smoke-round28.cjs',
  'smoke-round29.cjs',
  'smoke-round30.cjs',
  'smoke-round31.cjs',
  'smoke-round32.cjs',
  'smoke-round33.cjs',
  'smoke-round34.cjs',
  'smoke-round35.cjs',
  'smoke-round38.cjs',
  'smoke-round39.cjs', // 含真实补抓网络请求
  'smoke-round40.cjs', // 含真实无登录态采集请求
];

const summary = [];
let failed = 0;
for (const f of SUITE) {
  const run = () => spawnSync(process.execPath, [path.join(TESTS, f)], { encoding: 'utf8', timeout: 300000 });
  let r = run();
  // 含真实网络请求的脚本（得物/补抓/采集）存在偶发网络抖动：失败最多重跑 2 次，仍失败才计 FAIL
  for (let attempt = 2; attempt <= 3 && r.status !== 0; attempt++) {
    console.log(`RETRY ${f}（第 ${attempt - 1} 次失败，疑似网络抖动，重跑）`);
    r = run();
  }
  const out = (r.stdout || '') + (r.stderr || '');
  const tail = out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '(无输出)';
  const pass = r.status === 0;
  if (!pass) failed++;
  summary.push({ f, pass, tail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${f}  ｜ ${tail.slice(0, 80)}`);
}

console.log(`\n===== 全量冒烟汇总：${summary.length - failed}/${summary.length} 通过 =====`);
if (failed) {
  console.log('失败脚本：');
  summary.filter((s) => !s.pass).forEach((s) => console.log('  - ' + s.f));
  process.exit(1);
}
