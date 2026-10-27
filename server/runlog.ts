// 运行日志环形缓冲：采集过程中的每一步（引擎选择 / 代理 / 重试 / 详情页）
// 都推到这里，前端「采集中」模块轮询 /api/logs 滚动展示。
const MAX = 800;
const lines = [];
let seq = 0;

/** 当前时间的北京时间 HH:mm:ss 文本（全站时间统一北京时间）。 */
export function bjNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 平移到北京时区后按 UTC 字段取值
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 记录一条运行日志（同时镜像到控制台）。 */
export function runLog(msg) {
  const entry = { i: seq++, t: bjNow(), msg: String(msg) };
  lines.push(entry);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
  console.log(`[run] ${entry.t} ${entry.msg}`);
  return entry.i;
}

/** 取 since 之后的新日志（前端轮询增量）。无新日志时返回空数组，绝不全量重发。 */
export function getLogs(since = -1) {
  const from = lines.findIndex((l) => l.i > since);
  if (from === -1) return { last: seq - 1, lines: [] };
  return { last: lines[lines.length - 1].i, lines: lines.slice(from) };
}
