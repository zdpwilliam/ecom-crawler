// 存储门面（Storage Facade）
// 根据环境变量 STORE_BACKEND 选择后端：
//   - sqlite（默认）：嵌入式文件数据库，零额外依赖（见 db.js，node:sqlite）
//   - mongodb：本地 MongoDB 文档数据库（见 storage-mongo.js，惰性 import 'mongodb'）
//
// 统一对外接口（全部 async，便于 MongoDB 这种纯异步后端）：
//   loadStore / addRecords / query / stats / listJobs / getJob / saveJob /
//   removeJob / logRun / getRuns / clearData / storageInfo
//
// 调用方（index / collectors / export / scheduler / 各脚本）统一从本模块导入，
// 不再直接依赖 db.js，从而在不改动业务代码的前提下切换后端。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.resolve(__dirname, '..', 'data');
export const EXPORT_DIR = path.resolve(DATA_DIR, 'exports');
export const COOKIES_DIR = path.resolve(DATA_DIR, 'cookies');
export const PROXIES_FILE = path.resolve(DATA_DIR, 'proxies.txt');

let backend = null;
let backendName = null;

async function getBackend() {
  if (backend) return backend;
  const which = (process.env.STORE_BACKEND || 'sqlite').toLowerCase();
  if (which === 'mongodb') {
    const mod = await import('./storage-mongo.ts');
    backend = mod.createMongoBackend();
    backendName = 'mongodb';
  } else {
    const db = await import('./db.ts');
    // SQLite 同步实现 → 包成 async 以统一接口
    backend = {
      loadStore: () => db.loadStore(),
      addRecords: (t, r) => db.addRecords(t, r),
      query: (o) => db.query(o),
      stats: () => db.stats(),
      listJobs: () => db.listJobs(),
      getJob: (id) => db.getJob(id),
      saveJob: (j) => db.saveJob(j),
      removeJob: (id) => db.removeJob(id),
      logRun: (o) => db.logRun(o),
      getRuns: (l) => db.getRuns(l),
      clearData: (o) => db.clearData(o),
      storageInfo: () => db.storageInfo(),
    };
    backendName = 'sqlite';
  }
  await backend.loadStore();
  return backend;
}

// 与后端无关的通用路径信息（导出目录 / Cookie 目录 / 代理文件）
function commonPaths() {
  let exportsSize = 0;
  let exportFiles = 0;
  if (fs.existsSync(EXPORT_DIR)) {
    for (const f of fs.readdirSync(EXPORT_DIR)) {
      const fp = path.join(EXPORT_DIR, f);
      try {
        const st = fs.statSync(fp);
        if (st.isFile()) {
          exportsSize += st.size;
          exportFiles++;
        }
      } catch {
        /* ignore */
      }
    }
  }
  let cookieFiles = [];
  if (fs.existsSync(COOKIES_DIR)) cookieFiles = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith('.json'));
  return {
    dataDir: DATA_DIR,
    exportsDir: EXPORT_DIR,
    exportsSize,
    exportFiles,
    cookiesDir: COOKIES_DIR,
    cookieFiles,
    proxiesFile: PROXIES_FILE,
    proxiesExists: fs.existsSync(PROXIES_FILE),
  };
}

// ---------- 统一导出 ----------
export async function loadStore() {
  return (await getBackend()).loadStore();
}
export async function addRecords(type, records) {
  return (await getBackend()).addRecords(type, records);
}
export async function query(o = {}) {
  return (await getBackend()).query(o);
}
export async function stats() {
  return (await getBackend()).stats();
}
export async function listJobs() {
  return (await getBackend()).listJobs();
}
export async function getJob(id) {
  return (await getBackend()).getJob(id);
}
export async function saveJob(job) {
  return (await getBackend()).saveJob(job);
}
export async function removeJob(id) {
  return (await getBackend()).removeJob(id);
}
export async function logRun(o) {
  return (await getBackend()).logRun(o);
}
export async function getRuns(limit = 50) {
  return (await getBackend()).getRuns(limit);
}

// 存储信息：合并通用路径 + 后端专属信息
export async function storageInfo() {
  const b = await getBackend();
  const info = await b.storageInfo();
  return { ...commonPaths(), ...info };
}

// 清空数据：按类型 / 任务 / 导出文件清理。exports=true 时一并删除本地导出文件。
export async function clearData(opts: Record<string, any> = {}) {
  const b = await getBackend();
  const res = await b.clearData(opts);
  if (opts.exports) {
    let exportsRemoved = 0;
    if (fs.existsSync(EXPORT_DIR)) {
      for (const f of fs.readdirSync(EXPORT_DIR)) {
        try {
          fs.unlinkSync(path.join(EXPORT_DIR, f));
          exportsRemoved++;
        } catch {
          /* ignore */
        }
      }
    }
    res.exportsRemoved = exportsRemoved;
  }
  return res;
}

export function currentBackend() {
  return backendName || (process.env.STORE_BACKEND || 'sqlite').toLowerCase();
}

/** 运行时切换存储后端（无需重启）。切换后持久化由调用方负责（settings.json）。 */
export async function setBackend(name) {
  const which = name === 'mongodb' ? 'mongodb' : 'sqlite';
  if (backend && backendName === which) return which;
  // 关闭旧后端（Mongo 需要断开连接释放资源）
  if (backend && backendName === 'mongodb' && typeof backend.close === 'function') {
    try {
      await backend.close();
    } catch {
      /* ignore */
    }
  }
  backend = null;
  backendName = null;
  process.env.STORE_BACKEND = which;
  await getBackend();
  console.log(`[storage] 存储后端已切换为 ${which}`);
  return which;
}
