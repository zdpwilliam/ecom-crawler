import { useCallback, useEffect, useRef, useState } from 'react';
import { AppContext, PAGES, PageName } from './ctx';
import { apiJson } from './api';
import { Sidebar } from './components/Sidebar';
import { CollectPage } from './pages/CollectPage';
import { DataPage } from './pages/DataPage';
import { JobsPage } from './pages/JobsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ClearModal } from './components/ClearModal';

const hashPage = (): string => (location.hash || '').replace('#/', '');

export function App() {
  const [page, setPage] = useState<PageName>(
    (PAGES as string[]).includes(hashPage()) ? (hashPage() as PageName) : 'collect'
  );
  const [platforms, setPlatforms] = useState<any[]>([]);
  const [platform, setPlatform] = useState('');
  const [stats, setStats] = useState<any>(null);
  // 数据管理页表格状态（App 级持有，供采集完成跳转 / 评论跳商品 / 清理弹框 / 统计轮询联动）
  const [table, setTable] = useState({ type: 'product', platform: '', search: '', page: 1, pageSize: 20 });
  const [tableTick, setTableTick] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [loginTick, setLoginTick] = useState(0);
  const [platCardTick, setPlatCardTick] = useState(0);
  const [storageTick, setStorageTick] = useState(0);
  const [jobPrefill, setJobPrefill] = useState<any>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const lastStatsKey = useRef<string | null>(null);
  const drawerRef = useRef(false);
  drawerRef.current = drawerOpen;

  const showPage = useCallback((name: string) => {
    if (!(PAGES as string[]).includes(name)) name = 'collect';
    setPage(name as PageName);
    if (location.hash !== `#/${name}`) history.replaceState(null, '', `#/${name}`);
  }, []);

  const refreshStats = useCallback(async () => {
    try {
      setStats(await apiJson('/api/stats'));
    } catch {}
  }, []);

  // 对齐原 renderTable(type, keepPage) 语义：不保页则回第 1 页。
  // 注意 patch.page 必须最后生效（显式翻页优先于保页/重置逻辑）——
  // 过去 page 覆盖写在 patch 展开之后，下一页/上一页/跳转的页码被静默丢弃（点按钮无响应）
  const refreshTable = useCallback((keepPage = false, patch: any = {}) => {
    setTable((t) => {
      const next = { ...t, ...patch };
      if (patch.page === undefined && !keepPage) next.page = 1;
      return next;
    });
    setTableTick((x) => x + 1);
  }, []);

  // 评论/问答「商品」列 → 跳回商品页签并按 itemId 检索（数据关联）
  const jumpToProduct = useCallback(
    (plat: string, itemId: string) => {
      if (!itemId) return;
      refreshTable(false, { type: 'product', platform: plat, search: itemId });
    },
    [refreshTable]
  );

  const setTableSearch = useCallback((v: string) => setTable((t) => ({ ...t, search: v })), []);

  // 数据变化自动感知：轮询统计数，只要库里有增删（面板采集/命令行/定时任务/外部触发），
  // 就自动刷新顶部统计与数据表格，页面无需手动刷新。抽屉打开时不打断阅读。
  const pollStats = useCallback(async () => {
    try {
      const s = await apiJson('/api/stats');
      const key = JSON.stringify(s);
      if (lastStatsKey.current !== null && key !== lastStatsKey.current) {
        setStats(s);
        if (!drawerRef.current) refreshTable(true);
      }
      lastStatsKey.current = key;
    } catch {}
  }, [refreshTable]);

  // 初始化：平台清单 → 默认选中第一个平台 → 恢复 hash 路由 → 首次拉统计/表格/信息卡
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const list = await apiJson('/api/platforms');
        if (dead) return;
        setPlatforms(list);
        if (list.length) setPlatform(list[0].id);
      } catch {}
      if (dead) return;
      showPage(hashPage());
      refreshStats();
      setTableTick((x) => x + 1);
      setPlatCardTick((x) => x + 1);
    })();
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pollStats();
    const t = setInterval(pollStats, 5000);
    return () => clearInterval(t);
  }, [pollStats]);

  // hash 路由（侧边导航 + 浏览器前进后退）
  useEffect(() => {
    const onHash = () => showPage(hashPage());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [showPage]);

  // Esc 关闭数据清理弹框（抽屉/测试弹框/后端切换弹框各自有监听）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setClearOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const ctx: any = {
    page,
    showPage,
    platforms,
    platform,
    setPlatform,
    stats,
    refreshStats,
    table,
    setTableSearch,
    refreshTable,
    tableTick,
    jumpToProduct,
    drawerOpen,
    setDrawerOpen,
    loginTick,
    bumpLogin: () => setLoginTick((x) => x + 1),
    platCardTick,
    bumpPlatCard: () => setPlatCardTick((x) => x + 1),
    storageTick,
    bumpStorage: () => setStorageTick((x) => x + 1),
    jobPrefill,
    setJobPrefill,
    clearOpen,
    setClearOpen,
  };

  return (
    <AppContext.Provider value={ctx}>
      <div className="layout">
        <Sidebar />
        <main className="main">
          <CollectPage />
          <DataPage />
          <JobsPage />
          <SettingsPage />
        </main>
      </div>
      <ClearModal />
    </AppContext.Provider>
  );
}
