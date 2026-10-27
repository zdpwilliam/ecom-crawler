// 命令行导出：node scripts/export-data.js --type product --format csv --platform jd
// 支持类型：product / review / qa / chat；格式：json(默认) / csv
// 文件保存到 data/exports/。
import { loadStore } from '../src/server/storage.ts';
import { exportData } from '../src/server/export.ts';

await loadStore();

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const type = get('type') || 'product';
const format = (get('format') || 'json').toLowerCase();
const platform = get('platform');
const q = get('q');

const r = await exportData({ type, format, platform, q });
console.log(`已导出 ${r.count} 条 ${type} (${r.format}) → ${r.file}`);
