// 文档路径防漂移测试（离线，秒级）。
// 背景：目录重构（server/→src/server/、tools/smoke-*→tests/）后 README/COMPLIANCE
// 残留旧路径靠人工 grep 才发现。本测试锁定两条纪律：
//   1. 文档里反引号引用的代码/文档文件路径必须真实存在；
//   2. 已废弃的旧路径模式（重构前结构）不得再出现。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `（${detail}）` : ''}`);
}

// 只扫这些文档（新增 md 后在此登记才会被检查）
const DOCS = ['README.md', 'COMPLIANCE.md', 'docs/anti-crawl-research.md', 'docs/crawler-tech-research-2026-10.md'];
// 反引号内的文件引用（ts/tsx/mjs/cjs/json/md），排除：通配符、花括号组、URL、含中文/空格的模板路径
const REF_RE = /`([a-zA-Z0-9_@.\-/]+\.(?:tsx?|mjs|cjs|json|md))`/g;

const docs = DOCS.filter((f) => fs.existsSync(path.join(ROOT, f)));
check('受检文档齐备', docs.length === DOCS.length, docs.join(', '));

// ---------- 1. 引用路径必须存在 ----------
const missing = [];
let refCount = 0;
for (const doc of docs) {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  for (const m of text.matchAll(REF_RE)) {
    const ref = m[1];
    refCount++;
    if (/[*{}]/.test(ref)) continue; // 通配/花括号模板
    if (!ref.includes('/')) continue; // 裸文件名（目录位置不明确，无法可靠判定）
    if (ref.startsWith('data/')) continue; // 运行时生成的数据文件，不要求入库常在
    if (!fs.existsSync(path.join(ROOT, ref))) missing.push(`${doc}: ${ref}`);
  }
}
check(`反引号文件引用全部存在（共 ${refCount} 处）`, missing.length === 0, missing.slice(0, 5).join(' | '));

// ---------- 2. 废弃旧路径模式不得出现（只查正文，目录树代码块除外） ----------
const legacy = [];
for (const doc of docs) {
  const text = fs.readFileSync(path.join(ROOT, doc), 'utf8');
  // 剥掉 ``` 围栏代码块（目录树里 src/ 下的 server/ 子行属正常结构）
  const prose = text.replace(/```[\s\S]*?```/g, '');
  // 先抹掉合法的 src/server/，再找裸 server/
  const stripped = prose.replaceAll('src/server/', '');
  if (/(^|[^a-zA-Z])server\//.test(stripped)) legacy.push(`${doc}: 裸 server/ 路径`);
  if (/src\/ui\//.test(prose)) legacy.push(`${doc}: src/ui/ 路径`);
  if (/tools\/(smoke|test)-/.test(prose)) legacy.push(`${doc}: tools/ 下测试脚本路径（已迁 tests/）`);
}
check('无废弃旧路径残留', legacy.length === 0, legacy.join(' | '));

// ---------- 3. package.json 元信息 ----------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
check('package.json 声明 license 字段', typeof pkg.license === 'string' && pkg.license.length > 0, String(pkg.license));
check('免责声明存在于 COMPLIANCE.md', fs.readFileSync(path.join(ROOT, 'COMPLIANCE.md'), 'utf8').includes('免责声明'));

// ---------- 汇总 ----------
const failed = results.filter((r) => !r.ok);
console.log(`\n===== 文档路径防漂移：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
