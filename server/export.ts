// 数据导出：所有数据类型支持 CSV / JSON 两种格式落盘到 data/exports/。
// 同时供 HTTP 接口（下载）与 CLI 脚本复用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './storage.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_DIR = path.resolve(__dirname, '..', 'data', 'exports');

// 各类型导出列（驼峰，与 API 一致）
const COLUMNS = {
  product: ['platform', 'platformName', 'itemId', 'title', 'price', 'currency', 'category', 'brand', 'shopName', 'sales', 'stock', 'url', 'images', 'specs', 'collectedAt'],
  review: ['platform', 'platformName', 'itemId', 'productTitle', 'rating', 'content', 'authorMasked', 'tags', 'createdAt', 'collectedAt'],
  qa: ['platform', 'platformName', 'itemId', 'productTitle', 'question', 'answer', 'askerMasked', 'answerMasked', 'createdAt', 'collectedAt'],
  chat: ['platform', 'sessionId', 'role', 'redactedText', 'piiFindings', 'timestamp', 'source'],
};

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = columns.join(',');
  const body = rows.map((r) => columns.map((c) => esc(r[c])).join(',')).join('\r\n');
  return head + '\r\n' + body;
}

// 执行导出并落盘。返回 { file, count, format }。
export async function exportData(opts: { type?: string; format?: string; platform?: string; q?: string; limit?: number } = {}) {
  const { type = 'product', format = 'json', platform, q, limit } = opts;
  const rows = await query({ type, platform, q, limit: limit || 1000000 });
  const cols = COLUMNS[type] || (rows[0] ? Object.keys(rows[0]) : []);
  let content, ext;
  if (format === 'csv') {
    content = toCsv(rows, cols);
    ext = 'csv';
  } else {
    content = JSON.stringify(rows, null, 2);
    ext = 'json';
  }
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(EXPORT_DIR, `${type}_${stamp}.${ext}`);
  fs.writeFileSync(file, content, 'utf8');
  return { file, count: rows.length, format };
}

// 构建导出内容（不落盘）：供 HTTP 下载接口复用。返回 { content, filename, mime, count }。
export async function buildExport(opts: { type?: string; format?: string; platform?: string; q?: string; limit?: number } = {}) {
  const { type = 'product', format = 'json', platform, q, limit } = opts;
  const rows = await query({ type, platform, q, limit: limit || 1000000 });
  const cols = COLUMNS[type] || (rows[0] ? Object.keys(rows[0]) : []);
  let content, ext, mime;
  if (format === 'csv') {
    content = toCsv(rows, cols);
    ext = 'csv';
    mime = 'text/csv';
  } else {
    content = JSON.stringify(rows, null, 2);
    ext = 'json';
    mime = 'application/json';
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return { content, filename: `${type}_${stamp}.${ext}`, mime: `${mime}; charset=utf-8`, count: rows.length };
}
