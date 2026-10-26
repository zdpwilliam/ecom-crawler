// 兼容层：旧代码仍可能 import 自 store.js。
// 实际存储已改为统一的 storage.js 门面（SQLite / MongoDB 可切换，全部 async）。
export * from './storage.js';
