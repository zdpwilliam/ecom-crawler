import { useApp } from '../ctx';

const NAV: Array<[string, string]> = [
  ['collect', '采集工作台'],
  ['data', '数据管理'],
  ['jobs', '定时任务'],
  ['settings', '系统设置'],
];

export function Sidebar() {
  const app = useApp();
  const s = app.stats;
  return (
    <aside className="sidebar">
      <div className="brand">
        <h1>电商数据采集</h1>
        <p className="sub">官方 API 优先 · 爬虫回退 · 定时采集</p>
      </div>
      <nav className="nav">
        {NAV.map(([id, label]) => (
          <button key={id} className={`nav-item${app.page === id ? ' active' : ''}`} data-page={id} onClick={() => app.showPage(id)}>
            {label}
          </button>
        ))}
      </nav>
      <div className="side-stats" id="stats">
        {s && (
          <>
            <span>
              商品 <b>{s.product}</b>
            </span>
            <span>
              评论 <b>{s.review}</b>
            </span>
            <span>
              问答 <b>{s.qa}</b>
            </span>
          </>
        )}
      </div>
      <p className="side-hint">运行提示：默认启用指纹随机化 + 代理轮换；首次使用建议先到「系统设置」配置代理与平台登录状态。</p>
    </aside>
  );
}
