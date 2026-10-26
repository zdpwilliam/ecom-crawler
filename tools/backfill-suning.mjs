// 苏宁存量数据回填：修复历史坏数据（直连通道上线前浏览器路径采集的行）。
// 用法：node --experimental-sqlite tools/backfill-suning.mjs [--brand]
//   步骤 1（总是执行）：item_id 是占位码（0000000000 / item_N / 店铺码）的行，
//                       从 url 末段提取真实商品号回填 item_id。
//   步骤 2（总是执行）：price=0 或 shop_name 空 → 批量调 ds.suning.com 价格接口
//                       补 price / shop_name（20 个/批，匿名可调）。
//   步骤 3（--brand）：  brand 或 category 空 → 逐个调详情页 SSR 补
//                       brand/category（走 netThrottle 节流，189 条约 5~8 分钟）。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fetchSuningDsPrices, fetchSuningDetailSpuSku } from '../server/adapters/scrape/suning-api.js';

const withBrand = process.argv.includes('--brand');
const db = new DatabaseSync(fileURLToPath(new URL('../data/ecom.db', import.meta.url)));
const log = (m) => console.log(`[backfill] ${m}`);

// ── 步骤 1：修 item_id ──────────────────────────────────────────────
// 坏 id 特征：全 0 占位（URL 店铺码被当成商品号）、item_N（索引兜底）、
// 007/009 开头 10 位（店铺码形态）。真实商品号在 url 末段 /<digits>.html。
const badRows = db
  .prepare(
    `SELECT rowid, item_id, url FROM products
     WHERE platform='suning'
       AND (item_id='0000000000' OR item_id LIKE 'item[_]%' OR item_id GLOB '00[0-9]*' AND length(item_id)=10)`
  )
  .all();
let fixedId = 0;
for (const r of badRows) {
  const m = String(r.url || '').match(/\/(\d{9,})\.html/);
  if (!m) continue;
  try {
    db.prepare('UPDATE products SET item_id=? WHERE rowid=?').run(m[1], r.rowid);
    fixedId++;
  } catch (e) {
    log(`item_id 回填冲突 rowid=${r.rowid} → ${m[1]}：${String(e.message).slice(0, 60)}`);
  }
}
log(`步骤 1 完成：item_id 修复 ${fixedId}/${badRows.length} 行`);

// ── 步骤 2：补价格/店铺 ─────────────────────────────────────────────
const rows = db
  .prepare(
    `SELECT rowid, item_id, price, shop_name FROM products
     WHERE platform='suning' AND item_id GLOB '[0-9]*' AND length(item_id)>=9
       AND (price IS NULL OR price=0 OR shop_name IS NULL OR shop_name='')`
  )
  .all();
log(`步骤 2：待补价格/店铺 ${rows.length} 行`);
const ids = rows.map((r) => r.item_id);
const priceMap = await fetchSuningDsPrices(ids, log);
let filled = 0;
for (const r of rows) {
  const d = priceMap.get(String(r.item_id));
  if (!d) continue;
  const price = Number(r.price) > 0 ? r.price : d.price || 0;
  const shop = r.shop_name || d.vendorName || '';
  if (d.price > 0 || d.vendorName) {
    db.prepare('UPDATE products SET price=?, shop_name=? WHERE rowid=?').run(price, shop, r.rowid);
    filled++;
  }
}
log(`步骤 2 完成：价格/店铺回填 ${filled}/${rows.length} 行`);

// ── 步骤 3（可选）：补品牌/类目（逐个详情，慢） ──────────────────────
if (withBrand) {
  const needBrand = db
    .prepare(
      `SELECT rowid, item_id, title FROM products
       WHERE platform='suning' AND (brand IS NULL OR brand='' OR category IS NULL OR category='')`
    )
    .all();
  log(`步骤 3：待补品牌/类目 ${needBrand.length} 行（详情逐个，节流模式）`);
  let ok = 0;
  for (const [i, r] of needBrand.entries()) {
    try {
      const d = await fetchSuningDetailSpuSku({ itemId: r.item_id, log: () => {} });
      const s = d.spu || {};
      const brand = s.brandName || '';
      const category = s.categoryName || '';
      if (brand || category) {
        db.prepare("UPDATE products SET brand=COALESCE(NULLIF(?,''),brand), category=COALESCE(NULLIF(?,''),category) WHERE rowid=?").run(brand, category, r.rowid);
        ok++;
      }
    } catch (e) {
      log(`  详情失败 ${r.item_id}：${String(e.message).slice(0, 60)}`);
    }
    if ((i + 1) % 20 === 0) log(`  进度 ${i + 1}/${needBrand.length}`);
  }
  log(`步骤 3 完成：品牌/类目回填 ${ok}/${needBrand.length} 行`);
}

// ── 结果抽样 ────────────────────────────────────────────────────────
const sample = db
  .prepare(`SELECT item_id, title, price, brand, shop_name, category FROM products WHERE platform='suning' ORDER BY rowid DESC LIMIT 5`)
  .all();
console.log('\n抽样（最新 5 条）:');
for (const r of sample) {
  console.log(`  ${r.item_id} | ¥${r.price} | ${r.brand || '—'} | ${r.shop_name || '—'} | ${r.category || '—'} | ${r.title.slice(0, 30)}`);
}
const remain = db.prepare(`SELECT COUNT(*) n FROM products WHERE platform='suning' AND (item_id='0000000000' OR price=0)`).get();
log(`剩余坏行（id 占位或价格为 0）：${remain.n}`);
