// 一次性数据回填：用唯品会详情接口（detail/main/v6）补全已入库商品的
// 品牌 / 类目 / 店铺 字段。list/v2 搜索接口不返回类目名与店铺名，早期浏览器路径
// 采集的行更是整片缺失——本脚本逐个 itemId 调详情接口拿权威值覆盖。
//
// 用法：node tools/backfill-fields.mjs [--platform vip]
// 可重复执行：只处理仍有缺失或品牌为 DOM 采集值的行。
import { loadStore } from '../server/db.js';
import { fetchVipDetailSpuSku } from '../server/adapters/scrape/vip-api.js';

const db = loadStore();
const log = (m) => console.log(`[backfill] ${m}`);

const platform = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : 'vip';

// 待回填：vip 且（缺类目/店铺/品牌）的行
const rows = db
  .prepare(
    `SELECT DISTINCT item_id FROM products
     WHERE platform = ? AND item_id != ''
       AND (brand IS NULL OR brand = '' OR category IS NULL OR category = '' OR shop_name IS NULL OR shop_name = '')`
  )
  .all(platform)
  .map((r) => r.item_id);

log(`平台 ${platform}：待回填 itemId 共 ${rows.length} 个`);
if (!rows.length) process.exit(0);

let ok = 0;
let fail = 0;
for (const [i, itemId] of rows.entries()) {
  try {
    const d = await fetchVipDetailSpuSku({ itemId, log: () => {} });
    const s = d.spu || {};
    const brand = s.brandName || '';
    const category = s.categoryName || '';
    const shop = s.vendorName || s.brandName || '';
    if (!brand && !category && !shop) throw new Error('详情接口未返回品牌/类目/店铺');
    const r = db
      .prepare('UPDATE products SET brand = ?, category = ?, shop_name = ? WHERE item_id = ? AND platform = ?')
      .run(brand || null, category || null, shop || null, itemId, platform);
    ok += r.changes;
    log(`[${i + 1}/${rows.length}] itemId=${itemId} → 品牌=${brand || '—'} 类目=${category || '—'} 店铺=${shop || '—'}（更新 ${r.changes} 行）`);
  } catch (e) {
    fail++;
    log(`[${i + 1}/${rows.length}] itemId=${itemId} 失败：${String(e.message).slice(0, 80)}`);
  }
  await new Promise((r) => setTimeout(r, 700)); // 控制请求密度防风控
}
log(`完成：成功更新 ${ok} 行，失败 ${fail} 个 itemId`);
