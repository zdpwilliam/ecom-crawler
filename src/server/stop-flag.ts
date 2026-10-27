// 采集停止开关（独立小模块，避免 collectors ↔ generic 循环依赖）：
// 面板「停止采集」→ POST /api/collect/stop 置位；
// 采集流程在各检查点（策略切换 / 每次请求前 / 详情页循环）轮询此标志，尽快安全退出。
let stopped = false;

/** 置位停止标志（幂等）。 */
export function requestStop() {
  stopped = true;
}

/** 每次采集开始前复位。 */
export function resetStop() {
  stopped = false;
}

/** 是否已请求停止。 */
export function isStopped() {
  return stopped;
}
