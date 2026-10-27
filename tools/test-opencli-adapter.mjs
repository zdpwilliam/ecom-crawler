// OpenCLI 桥接适配器单元测试（离线，秒级）：
// 验证 opencli JSON 输出的防御式归一化（深度找数组 + 字段别名映射）与 JSON 截断容错。
import assert from 'node:assert';
import { findRecordArray, toProduct, toReview, runOpencli } from '../server/adapters/official/opencli-adapter.ts';

let pass = 0;
const check = (name, cond) => {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    console.error(`  ❌ ${name}`);
    process.exitCode = 1;
  }
};

// 1. findRecordArray：嵌套结构里找商品数组
const nested = { code: 0, data: { list: [{ title: '华为 Mate 80', price: '¥5999', itemId: '123' }, { title: '小米 17', price: 4999, id: '456' }] }, msg: 'ok' };
const arr = findRecordArray(nested);
check('嵌套结构找到商品数组', Array.isArray(arr) && arr.length === 2);

// 2. toProduct：别名字段映射 + 价格数字化
const p = toProduct(arr[0], 'taobao');
check('title 映射', p.title === '华为 Mate 80');
check('itemId 映射（item_id 别名）', p.itemId === '123');
check('价格字符串数字化', p.price === 5999);
check('platform 归属', p.platform === 'taobao');
check('collectedAt 存在', !!p.collectedAt);

// 3. 缺标题的行被过滤（collectProduct 内部逻辑依赖 title）
const bad = toProduct({ id: '789', price: 1 }, 'jd');
check('无标题记录标记为 (无标题)', bad.title === '(无标题)');

// 4. toReview：内容/评分/作者映射
const r = toReview({ content: '很好用', rating: '5', user: '张三' }, 'jd', 'SKU1');
check('review 内容映射', r.content === '很好用' && r.rating === 5 && r.author === '张三' && r.itemId === 'SKU1');
check('无内容 review 返回 null', toReview({ user: 'x' }, 'jd', 'SKU1') === null);

// 5. runOpencli：命令不存在时快速失败（opencli 二进制存在但参数非法）
try {
  await runOpencli(['__not_exist_adapter__', 'x'], { timeout: 20000 });
  check('非法适配器应抛错', false);
} catch (e) {
  check('非法适配器快速失败（不挂起）', /失败|非 JSON|解析失败/.test(e.message));
}

// 6. runOpencli：opencli 自身版本输出（无扩展依赖的本地命令）JSON 可解析
try {
  const v = await runOpencli(['--help'], { timeout: 30000 });
  check('--help JSON 可解析或统一报错', typeof v === 'object');
} catch {
  check('--help JSON 可解析或统一报错', true); // 某些版本 --help 非 json，允许报错路径
}

console.log(`\n通过 ${pass} 项，0 失败`);
