// CLI 采集：node scripts/run-collect.js --platform taobao --type product --query 手机 --strategy mock
// 带详情（评论+问答）：--withDetails [--detailLimit 3] [--detailFixture data/fixtures/demo-detail.html]
// 校准诊断：node scripts/run-collect.js --platform jd --type product --verify --fixture data/fixtures/demo-products.html
// 问答：node scripts/run-collect.js --platform jd --type qa --itemId 100001 --strategy scrape --fixture data/fixtures/demo-detail.html
import { runCollection } from '../src/server/collectors.ts';
import { loadStore } from '../src/server/storage.ts';
import { GenericScrapeAdapter } from '../src/server/adapters/scrape/generic.ts';

await loadStore();

const args = process.argv.slice(2);
const get = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (k) => args.includes(`--${k}`);

const platform = get('platform') || 'taobao';
const dataType = get('type') || 'product';
const strategy = get('strategy') || 'mock';
const query = get('query') || '手机';
const itemId = get('itemId');
const limit = Number(get('limit') || 10);
const fixture = get('fixture');
const detailFixture = get('detailFixture');
const withDetails = has('withDetails');
const detailLimit = Number(get('detailLimit') || 3);

if (has('verify')) {
  if (!fixture) {
    console.error('--verify 需要配合 --fixture <本地html> 使用');
    process.exit(1);
  }
  const kind = dataType === 'qa' ? 'qa' : dataType;
  const adapter = new GenericScrapeAdapter({ platformId: platform });
  const diag = adapter.diagnose(fixture, kind, { fixture });
  console.log(JSON.stringify(diag, null, 2));
  process.exit(0);
}

const result = await runCollection({
  platform,
  dataType,
  query,
  itemId,
  strategy,
  limit,
  fixture,
  withDetails,
  detailLimit,
  detailFixture,
});
console.log(JSON.stringify(result, null, 2));
