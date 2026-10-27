// 本地 MongoDB 文档数据库后端。启用方式：
//   STORE_BACKEND=mongodb  MONGODB_URI=mongodb://localhost:27017  node server/index.js
//
// 设计要点：
//   - 惰性依赖：仅在 STORE_BACKEND=mongodb 时才 import('mongodb')，SQLite 路径无需安装该包。
//   - 统一接口（与 db.js 一致，全部 async）：loadStore / addRecords / query / stats /
//     listJobs / getJob / saveJob / removeJob / logRun / getRuns / clearData / storageInfo
//   - 文档按驼峰字段原样存储，id 为主键（replaceOne upsert），与 SQLite 行结构兼容。
const DB_NAME = process.env.MONGODB_DB || 'ecom_crawler';
const URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';

const COL = { product: 'products', review: 'reviews', qa: 'qa', chat: 'chats' };
const SEARCH_FIELDS = {
  product: ['title', 'brand', 'category', 'platformName', 'itemId', 'url', 'description'],
  review: ['content', 'productTitle', 'authorMasked', 'platformName', 'itemId'],
  qa: ['question', 'answer', 'productTitle', 'platformName', 'itemId'],
  chat: ['redactedText', 'sessionId', 'platform'],
};

let client = null;
let db = null;

async function connect() {
  if (db) return db;
  const { MongoClient } = await import('mongodb');
  client = new MongoClient(URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(DB_NAME);
  return db;
}

function normalizeJob(r) {
  return {
    id: r.id,
    platform: r.platform,
    dataType: r.dataType,
    query: r.query,
    itemId: r.itemId,
    limit: r.limit,
    everyMinutes: r.everyMinutes,
    withDetails: !!r.withDetails,
    detailLimit: r.detailLimit || 3,
    enabled: !!r.enabled,
    createdAt: r.createdAt,
  };
}

export function createMongoBackend() {
  return {
    async loadStore() {
      try {
        await connect();
      } catch (e) {
        // 连接失败不阻塞进程；真正读写时会再次抛出清晰错误
        console.error('[mongo] 连接失败（采集写入将报错）：', e.message);
      }
      return true;
    },

    /** 关闭连接（切换到其他后端时调用）。 */
    async close() {
      try {
        if (client) await client.close();
      } catch {
        /* ignore */
      }
      client = null;
      db = null;
    },

    async addRecords(type, records) {
      await connect();
      const col = COL[type];
      if (!col || !Array.isArray(records)) return 0;
      let n = 0;
      for (const r of records) {
        if (!r || !r.id) continue;
        await db.collection(col).replaceOne({ id: r.id }, r, { upsert: true });
        n++;
      }
      return n;
    },

    async query(opts: { type?: string; platform?: string; q?: string; limit?: number; offset?: number } = {}) {
      const { type = 'product', platform, q, limit, offset } = opts;
      await connect();
      const col = COL[type];
      if (!col) return [];
      const filter: Record<string, unknown> = {};
      if (platform) filter.platform = platform;
      if (q) {
        const f = SEARCH_FIELDS[type] || ['platform'];
        filter.$or = f.map((fld) => ({ [fld]: { $regex: q, $options: 'i' } }));
      }
      let cursor = db.collection(col).find(filter).sort({ collectedAt: -1, id: -1 });
      if (offset) cursor = cursor.skip(Number(offset));
      if (limit) cursor = cursor.limit(Number(limit));
      return cursor.toArray();
    },

    async stats() {
      await connect();
      return {
        product: await db.collection(COL.product).countDocuments(),
        review: await db.collection(COL.review).countDocuments(),
        qa: await db.collection(COL.qa).countDocuments(),
        chat: await db.collection(COL.chat).countDocuments(),
      };
    },

    async listJobs() {
      await connect();
      const rows = await db.collection('jobs').find({}).sort({ createdAt: -1 }).toArray();
      return rows.map(normalizeJob);
    },

    async getJob(id) {
      await connect();
      const r = await db.collection('jobs').findOne({ id });
      return r ? normalizeJob(r) : null;
    },

    async saveJob(job) {
      await connect();
      const id = job.id || `job_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const now = new Date().toISOString();
      const doc = {
        id,
        platform: job.platform,
        dataType: job.dataType,
        query: job.query || null,
        itemId: job.itemId || null,
        limit: job.limit || job.limitN || 10,
        everyMinutes: job.everyMinutes || 60,
        withDetails: job.withDetails ? 1 : 0,
        detailLimit: Number(job.detailLimit) || 3,
        enabled: job.enabled === false ? 0 : 1,
        createdAt: now,
      };
      await db.collection('jobs').replaceOne({ id }, doc, { upsert: true });
      return normalizeJob(doc);
    },

    async removeJob(id) {
      await connect();
      await db.collection('jobs').deleteOne({ id });
      return true;
    },

    async logRun({ jobId, platform, dataType, status, count, message, startedAt, finishedAt }) {
      await connect();
      await db.collection('job_runs').insertOne({
        jobId,
        platform,
        dataType,
        status,
        count: count || 0,
        message: message || '',
        startedAt,
        finishedAt,
      });
    },

    async getRuns(limit = 50) {
      await connect();
      return db.collection('job_runs').find({}).sort({ _id: -1 }).limit(limit).toArray();
    },

    async clearData(opts: { types?: string[]; jobs?: boolean; platform?: string; q?: string } = {}) {
      const { types = ['product', 'review', 'qa', 'chat'], jobs = false, platform = '', q = '' } = opts;
      await connect();
      let removed = 0;
      for (const t of types) {
        if (!COL[t]) continue;
        // 与 query() 同一套过滤口径：支持按平台 / 关键字范围删除
        const filter: Record<string, unknown> = {};
        if (platform) filter.platform = platform;
        if (q) {
          const f = SEARCH_FIELDS[t] || ['platform'];
          filter.$or = f.map((fld) => ({ [fld]: { $regex: q, $options: 'i' } }));
        }
        removed += (await db.collection(COL[t]).deleteMany(filter)).deletedCount;
      }
      if (jobs) {
        removed += (await db.collection('jobs').deleteMany({})).deletedCount;
        removed += (await db.collection('job_runs').deleteMany({})).deletedCount;
      }
      return { removed, backend: 'mongodb' };
    },

    async storageInfo() {
      let connected = false;
      let uri = URI;
      try {
        await connect();
        connected = true;
      } catch (e) {
        uri = `${URI} （连接失败：${e.message}）`;
      }
      let counts = {};
      try {
        counts = await this.stats();
      } catch {
        /* ignore */
      }
      return { backend: 'mongodb', mongoUri: uri, connected, dbName: DB_NAME, counts };
    },
  };
}
