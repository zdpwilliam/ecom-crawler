// 前端统一 API 访问与格式化工具
export async function api(path: string, opts: RequestInit = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    // 优先展示服务器返回的真实错误信息（而非干巴巴的状态码）
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
      else if (j && j.reason) msg = j.reason;
    } catch {}
    if (res.status === 404 && !msg.includes('VPN')) {
      msg += ' —— 接口不存在。若反复出现：可能是 VPN/系统代理拦截了 localhost 请求，请改用 http://127.0.0.1:4311 访问，或在 VPN 里把 localhost/127.0.0.1 加入直连白名单后按 Ctrl+F5 刷新页面。';
    }
    throw new Error(msg);
  }
  return res;
}

export const apiJson = async (path: string, opts: RequestInit = {}) => api(path, opts).then((r) => r.json());

// 全站时间统一北京时间、精确到分钟。时间戳是 UTC ISO（带 Z），new Date 会自动转浏览器本地时区；
// 中国用户本地即北京时间，不能再加 8h（否则国内机器上会多加 8 小时——历史 bug）。
export function fmtTime(iso: any) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtBytes(n: any) {
  if (!n && n !== 0) return '-';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}
