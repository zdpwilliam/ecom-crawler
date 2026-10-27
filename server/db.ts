// 嵌入式数据库存储层（node:sqlite，零额外依赖，文件落盘 data/ecom.db）
// 取代旧版 JSON 存储：支持 SQL 查询 / 索引 / 定时任务与运行记录。
// 对外 API 与旧 store.js 保持兼容（addRecords / query / stats / loadStore），
// 并新增 jobs / job_runs 的增删查与导出能力。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'ecom.db');
const JSON_LEGACY = path.join(DATA_DIR, 'store.json');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  platform TEXT,
  platform_name TEXT,
  item_id TEXT,
  title TEXT,
  price REAL,
  currency TEXT,
  category TEXT,
  brand TEXT,
  shop_name TEXT,
  sales INTEGER,
  stock INTEGER,
  url TEXT,
  images TEXT,
  specs TEXT,
  description TEXT,
  collected_at TEXT
);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  platform TEXT,
  platform_name TEXT,
  item_id TEXT,
  product_title TEXT,
  rating INTEGER,
  content TEXT,
  images TEXT,
  author_masked TEXT,
  tags TEXT,
  created_at TEXT,
  collected_at TEXT
);
CREATE TABLE IF NOT EXISTS qa (
  id TEXT PRIMARY KEY,
  platform TEXT,
  platform_name TEXT,
  item_id TEXT,
  product_title TEXT,
  question TEXT,
  answer TEXT,
  asker_masked TEXT,
  answer_masked TEXT,
  created_at TEXT,
  collected_at TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  platform TEXT,
  session_id TEXT,
  role TEXT,
  redacted_text TEXT,
  timestamp TEXT,
  source TEXT,
  pii_findings TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  platform TEXT,
  data_type TEXT,
  query TEXT,
  item_id TEXT,
  limit_n INTEGER,
  every_minutes INTEGER,
  with_details INTEGER DEFAULT 0,
  detail_limit INTEGER DEFAULT 3,
  enabled INTEGER DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  platform TEXT,
  data_type TEXT,
  status TEXT,
  count INTEGER,
  message TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_products_platform ON products(platform);
CREATE INDEX IF NOT EXISTS idx_reviews_platform ON reviews(platform);
CREATE INDEX IF NOT EXISTS idx_qa_platform ON qa(platform);
CREATE INDEX IF NOT EXISTS idx_chats_platform ON chats(platform);
CREATE INDEX IF NOT EXISTS idx_jobruns_job ON job_runs(job_id);
`;

// ---------- 类型 → 列定义 ----------
const TABLES = {
  product: {
    table: 'products',
    columns: [
      'id', 'platform', 'platform_name', 'item_id', 'title', 'price', 'currency',
      'category', 'brand', 'shop_name', 'sales', 'stock', 'url', 'images', 'specs', 'description', 'collected_at',
    ],
    json: ['images', 'specs'],
  },
  review: {
    table: 'reviews',
    columns: [
      'id', 'platform', 'platform_name', 'item_id', 'product_title', 'rating', 'content',
      'images', 'author_masked', 'tags', 'created_at', 'collected_at',
    ],
    json: ['images', 'tags'],
  },
  qa: {
    table: 'qa',
    columns: [
      'id', 'platform', 'platform_name', 'item_id', 'product_title', 'question', 'answer',
      'asker_masked', 'answer_masked', 'created_at', 'collected_at',
    ],
    json: [],
  },
  chat: {
    table: 'chats',
    columns: ['id', 'platform', 'session_id', 'role', 'redacted_text', 'timestamp', 'source', 'pii_findings'],
    json: ['pii_findings'],
  },
};

// 记录(驼峰) → 行(蛇形) 的字段读取器
function rowValues(type, r) {
  const now = new Date().toISOString();
  const j = (v) => (v == null ? null : JSON.stringify(v));
  switch (type) {
    case 'product':
      return [
        r.id, r.platform, r.platformName || r.platform, r.itemId, r.title, r.price, r.currency,
        r.category, r.brand, r.shopName ?? null, r.sales, r.stock, r.url, j(r.images || []), j(r.specs || {}), r.description ?? null, r.collectedAt || now,
      ];
    case 'review':
      return [
        r.id, r.platform, r.platformName || r.platform, r.itemId, r.productTitle, r.rating, r.content,
        j(r.images || []), r.authorMasked, j(r.tags || []), r.createdAt, r.collectedAt || now,
      ];
    case 'qa':
      return [
        r.id, r.platform, r.platformName || r.platform, r.itemId, r.productTitle, r.question, r.answer,
        r.askerMasked, r.answerMasked, r.createdAt, r.collectedAt || now,
      ];
    case 'chat':
      return [
        r.id, r.platform, r.sessionId, r.role, r.redactedText, r.timestamp, r.source, j(r.piiFindings || []),
      ];
    default:
      return [];
  }
}

// 行(蛇形) → API 记录(驼峰，解析 JSON 字段)
function rowToApi(type, row) {
  const o = { ...row };
  if (type === 'product') {
    o.platformName = row.platform_name; o.itemId = row.item_id; o.collectedAt = row.collected_at;
    o.shopName = row.shop_name;
    try { o.images = JSON.parse(row.images || '[]'); } catch { o.images = []; }
    try { o.specs = JSON.parse(row.specs || '{}'); } catch { o.specs = {}; }
  } else if (type === 'review') {
    o.platformName = row.platform_name; o.itemId = row.item_id; o.productTitle = row.product_title;
    o.authorMasked = row.author_masked; o.createdAt = row.created_at; o.collectedAt = row.collected_at;
    try { o.images = JSON.parse(row.images || '[]'); } catch { o.images = []; }
    try { o.tags = JSON.parse(row.tags || '[]'); } catch { o.tags = []; }
  } else if (type === 'qa') {
    o.platformName = row.platform_name; o.itemId = row.item_id; o.productTitle = row.product_title;
    o.askerMasked = row.asker_masked; o.answerMasked = row.answer_masked;
    o.createdAt = row.created_at; o.collectedAt = row.collected_at;
  } else if (type === 'chat') {
    o.sessionId = row.session_id; o.redactedText = row.redacted_text; o.timestamp = row.timestamp;
    o.piiFindings = JSON.parse(row.pii_findings || '[]');
  }
  return o;
}

// 各类型用于 q 全文检索的文本列
const SEARCH_COLS = {
  product: ['title', 'brand', 'category', 'platform_name', 'item_id', 'url', 'shop_name', 'description'],
  review: ['content', 'product_title', 'author_masked', 'platform_name', 'item_id'],
  qa: ['question', 'answer', 'product_title', 'platform_name', 'item_id'],
  chat: ['redacted_text', 'session_id', 'platform'],
};

// ---------- 初始化 / 迁移 ----------
export function initDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec(SCHEMA);
  // 轻量迁移：老库缺 shop_name 列时补上（CREATE TABLE IF NOT EXISTS 不会改已有表）
  const hasShop = db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'shop_name');
  if (!hasShop) {
    db.exec('ALTER TABLE products ADD COLUMN shop_name TEXT');
    console.log('[db] 已迁移：products 增加 shop_name 列');
  }
  // 老库缺 description 列时补上（商品详细描述，详情采集产出）
  const hasDesc = db.prepare('PRAGMA table_info(products)').all().some((c) => c.name === 'description');
  if (!hasDesc) {
    db.exec('ALTER TABLE products ADD COLUMN description TEXT');
    console.log('[db] 已迁移：products 增加 description 列');
  }
  // 老库缺 jobs.detail_limit 列时补上（定时任务的「详情数」）
  const hasDl = db.prepare('PRAGMA table_info(jobs)').all().some((c) => c.name === 'detail_limit');
  if (!hasDl) {
    db.exec('ALTER TABLE jobs ADD COLUMN detail_limit INTEGER DEFAULT 3');
    console.log('[db] 已迁移：jobs 增加 detail_limit 列');
  }
  migrateFromJson();
  return db;
}

/** 兼容旧接口：确保数据库已初始化。 */
export function loadStore() {
  return initDb();
}

function migrateFromJson() {
  if (!fs.existsSync(JSON_LEGACY)) return;
  try {
    const have = db.prepare('SELECT count(*) c FROM products').get().c;
    if (have > 0) return; // 已迁移过
    const data = JSON.parse(fs.readFileSync(JSON_LEGACY, 'utf8'));
    let total = 0;
    for (const type of ['product', 'review', 'chat']) {
      const rows = Array.isArray(data[type]) ? data[type] : [];
      total += addRecords(type, rows);
    }
    console.log(`[db] 已从旧 store.json 迁移 ${total} 条记录到 SQLite`);
    // 迁移完成后归档旧文件，避免重复迁移
    try { fs.renameSync(JSON_LEGACY, JSON_LEGACY + '.migrated'); } catch { /* ignore */ }
  } catch (e) {
    console.error('[db] 迁移 store.json 失败：', e.message);
  }
}

// ---------- 写入 ----------
export function addRecords(type, records) {
  initDb();
  const def = TABLES[type];
  if (!def || !Array.isArray(records)) return 0;
  const cols = def.columns;
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${def.table} (${cols.join(', ')}) VALUES (${placeholders})`
  );
  let n = 0;
  for (const r of records) {
    if (!r || !r.id) continue;
    stmt.run(...rowValues(type, r));
    n++;
  }
  return n;
}

// ---------- 查询 ----------
export function query(opts: { type?: string; platform?: string; q?: string; limit?: number; offset?: number } = {}) {
  const { type = 'product', platform, q, limit, offset } = opts;
  initDb();
  const def = TABLES[type];
  if (!def) return [];
  const where = [];
  const params = [];
  if (platform) { where.push('platform = ?'); params.push(platform); }
  if (q) {
    const cols = SEARCH_COLS[type] || ['platform'];
    const like = cols.map((c) => `${c} LIKE ?`).join(' OR ');
    where.push(`(${like})`);
    for (let i = 0; i < cols.length; i++) params.push(`%${q}%`);
  }
  const sql =
    `SELECT * FROM ${def.table}` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY collected_at DESC, id DESC` +
    (limit ? ` LIMIT ${Number(limit)}` : '') +
    (offset ? ` OFFSET ${Number(offset)}` : '');
  const rows = db.prepare(sql).all(...params);
  return rows.map((r) => rowToApi(type, r));
}

export function stats() {
  initDb();
  return {
    product: db.prepare('SELECT count(*) c FROM products').get().c,
    review: db.prepare('SELECT count(*) c FROM reviews').get().c,
    qa: db.prepare('SELECT count(*) c FROM qa').get().c,
    chat: db.prepare('SELECT count(*) c FROM chats').get().c,
  };
}

// ---------- 定时任务 (jobs) ----------
export function listJobs() {
  initDb();
  return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all().map(normalizeJob);
}
export function getJob(id) {
  initDb();
  const r = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return r ? normalizeJob(r) : null;
}
export function saveJob(job) {
  initDb();
  const id = job.id || `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO jobs (id, platform, data_type, query, item_id, limit_n, every_minutes, with_details, detail_limit, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM jobs WHERE id=?), ?))`
  ).run(
    id, job.platform, job.dataType, job.query || null, job.itemId || null,
    job.limit || job.limitN || 10, job.everyMinutes || 60, job.withDetails ? 1 : 0,
    Number(job.detailLimit) || 3, job.enabled === false ? 0 : 1, id, now
  );
  return getJob(id);
}
export function removeJob(id) {
  initDb();
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
  return true;
}
function normalizeJob(r) {
  return {
    id: r.id, platform: r.platform, dataType: r.data_type, query: r.query, itemId: r.item_id,
    limit: r.limit_n, everyMinutes: r.every_minutes, withDetails: !!r.with_details,
    detailLimit: r.detail_limit || 3, enabled: !!r.enabled,
    createdAt: r.created_at,
  };
}

// ---------- 任务运行记录 (job_runs) ----------
export function logRun({ jobId, platform, dataType, status, count, message, startedAt, finishedAt }) {
  initDb();
  db.prepare(
    `INSERT INTO job_runs (job_id, platform, data_type, status, count, message, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(jobId, platform, dataType, status, count || 0, message || '', startedAt, finishedAt);
}
export function getRuns(limit = 50) {
  initDb();
  return db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT ?').all(limit);
}

// ---------- 清空数据 ----------
// opts: { types?: string[], jobs?: boolean }
//   types 默认清空 product/review/qa/chat 四类采集数据；jobs=true 同时清空定时任务与运行记录。
export function clearData({ types = ['product', 'review', 'qa', 'chat'], jobs = false, platform = '', q = '' } = {}) {
  initDb();
  let removed = 0;
  for (const t of types) {
    const def = TABLES[t];
    if (!def) continue;
    // 与 query() 同一套过滤口径：支持按平台 / 关键字范围删除（数据管理页「清理数据」用）
    const where = [];
    const params = [];
    if (platform) { where.push('platform = ?'); params.push(platform); }
    if (q) {
      const cols = SEARCH_COLS[t] || ['platform'];
      where.push(`(${cols.map((c) => `${c} LIKE ?`).join(' OR ')})`);
      for (let i = 0; i < cols.length; i++) params.push(`%${q}%`);
    }
    const sql = `DELETE FROM ${def.table}` + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
    removed += db.prepare(sql).run(...params).changes;
  }
  if (jobs) {
    removed += db.prepare('DELETE FROM jobs').run().changes;
    removed += db.prepare('DELETE FROM job_runs').run().changes;
  }
  return { removed, backend: 'sqlite' };
}

// ---------- 存储信息（供「存储管理」面板展示） ----------
function sizeOf(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}
export function storageInfo() {
  initDb();
  const exportsDir = path.resolve(DATA_DIR, 'exports');
  let exportsSize = 0;
  let exportFiles = 0;
  if (fs.existsSync(exportsDir)) {
    for (const f of fs.readdirSync(exportsDir)) {
      const fp = path.join(exportsDir, f);
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
  const cookiesDir = path.resolve(DATA_DIR, 'cookies');
  let cookieFiles = [];
  if (fs.existsSync(cookiesDir)) cookieFiles = fs.readdirSync(cookiesDir).filter((f) => f.endsWith('.json'));
  const proxiesFile = path.resolve(DATA_DIR, 'proxies.txt');
  const legacy = JSON_LEGACY + '.migrated';
  return {
    backend: 'sqlite',
    dataDir: DATA_DIR,
    dbFile: DB_FILE,
    dbSize: sizeOf(DB_FILE),
    exportsDir,
    exportsSize,
    exportFiles,
    cookiesDir,
    cookieFiles,
    proxiesFile,
    proxiesExists: fs.existsSync(proxiesFile),
    migratedFromJson: fs.existsSync(legacy),
    counts: stats(),
  };
}
