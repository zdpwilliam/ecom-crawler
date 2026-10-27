import { createContext, useContext } from 'react';

// 页面名（与侧边导航 data-page、section#page-* 一一对应）
export type PageName = 'collect' | 'data' | 'jobs' | 'settings';
export const PAGES: PageName[] = ['collect', 'data', 'jobs', 'settings'];

// 全局共享上下文：页面路由 / 平台联动 / 统计 / 数据表驱动 / 各面板刷新信号。
// 字段保持宽松类型（any），与后端 JSON 结构直接对接。
export interface AppCtx {
  page: PageName;
  showPage(name: string): void;
  platforms: any[];
  platform: string;
  setPlatform(v: string): void;
  stats: any;
  refreshStats(): Promise<void>;
  // 数据管理页表格（外部动作可驱动：采集完成跳转 / 评论跳商品 / 清理后刷新 / 统计轮询）
  table: { type: string; platform: string; search: string; page: number; pageSize: number };
  setTableSearch(v: string): void;
  refreshTable(keepPage?: boolean, patch?: any): void;
  tableTick: number;
  jumpToProduct(platform: string, itemId: string): void;
  drawerOpen: boolean;
  setDrawerOpen(b: boolean): void;
  // 各面板刷新信号（编号变化即触发对应 effect 重拉）
  loginTick: number;
  bumpLogin(): void;
  platCardTick: number;
  bumpPlatCard(): void;
  storageTick: number;
  bumpStorage(): void;
  // 采集工作台 → 定时任务带入
  jobPrefill: any;
  setJobPrefill(v: any): void;
  // 数据清理弹框（App 级渲染，数据管理页触发）
  clearOpen: boolean;
  setClearOpen(b: boolean): void;
}

export const AppContext = createContext<AppCtx>(null as any);
export const useApp = () => useContext(AppContext);
