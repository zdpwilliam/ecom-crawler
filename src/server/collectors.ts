// 采集编排：官方优先 → 爬取回退；可强制 mock。
import { resolveAdapters, MockAdapter } from './adapters/registry.ts';
import { addRecords } from './storage.ts';
import { DATA_TYPES } from './types.ts';
import { refreshProfilePool } from './fingerprint.ts';
import { runLog } from './runlog.ts';
import { resetStop, isStopped } from './stop-flag.ts';

/**
 * 运行一次采集。
 * @returns {Promise<import('./types.ts').CollectResult>}
 */
export async function runCollection(job: {
  platform: string;
  dataType: string;
  query?: string;
  itemId?: string;
  strategy?: string;
  limit?: number;
  fixture?: any;
  withDetails?: boolean;
  detailLimit?: number;
  detailFixture?: any;
}) {
  const { platform, dataType, query, itemId, strategy, limit, fixture, withDetails, detailLimit, detailFixture } = job;
  const opts = { limit, fixture, withDetails, detailLimit, detailFixture };

  // 新一次采集开始：复位停止标志
  resetStop();

  // 每次运行前重建请求档案池：10 组随机指纹（UA/伪造IP/语言/视口/随机Cookie），
  // 本次运行内的每个请求都从池里随机抽一组使用。
  const pool = refreshProfilePool(10);
  runLog(
    `开始采集：平台=${platform} 类型=${dataType} 查询="${query || itemId || ''}" 数量=${limit || '默认'}` +
      (withDetails ? ` 带详情×${detailLimit || 3}` : '') +
      (pool.length ? ` ｜ 已生成 ${pool.length} 组随机请求档案` : ' ｜ 指纹随机化已关闭')
  );

  // 强制 mock：无凭证验证流程
  if (strategy === 'mock') {
    runLog('策略=mock：使用离线演示适配器');
    const mock = new MockAdapter({ id: platform });
    return await _collectWith(mock, dataType, { query, itemId, opts });
  }

  // 聊天数据类型已随聊天功能移除：任何残留调用直接拒绝
  if (dataType === 'chat') {
    throw new Error('聊天功能已移除，不支持采集聊天数据。');
  }

  // 官方优先，失败/空则回退爬取
  const seq = resolveAdapters(platform, dataType);
  let lastErr;
  for (const step of seq) {
    if (isStopped()) {
      runLog('采集已手动停止（策略循环中断）');
      return { platform, dataType, strategy: 'stopped', count: 0, status: 'stopped', message: '用户手动停止采集' };
    }
    runLog(`尝试策略：${step.strategy}`);
    try {
      const adapter = step.factory();
      const res = await _collectWith(adapter, dataType, { query, itemId, opts });
      if (isStopped()) {
        runLog(`采集已手动停止（策略 ${step.strategy} 返回后中断，本轮已入库 ${res.count} 条）`);
        return { platform, dataType, strategy: step.strategy, count: res.count, status: 'stopped', message: `用户手动停止采集（停止前已入库 ${res.count} 条）` };
      }
      if (res.count > 0 || res.status === 'ok') {
        runLog(`策略 ${step.strategy} 完成：共 ${res.count} 条${res.message ? `（${res.message}）` : ''}`);
        return res;
      }
      lastErr = new Error('适配器返回为空，尝试下一策略');
      runLog(`策略 ${step.strategy} 返回为空 → 尝试下一策略`);
    } catch (e) {
      lastErr = e;
      if (isStopped()) {
        runLog('采集已手动停止（策略内部中断）');
        return { platform, dataType, strategy: step.strategy, count: 0, status: 'stopped', message: '用户手动停止采集' };
      }
      runLog(`策略 ${step.strategy} 失败：${e.message}`);
    }
  }
  runLog(`采集失败：${lastErr ? lastErr.message : '无可用适配器'}`);
  return {
    platform,
    dataType,
    strategy: 'none',
    count: 0,
    status: 'failed',
    message: lastErr ? lastErr.message : '无可用适配器',
  };
}

async function _collectWith(adapter, dataType, { query, itemId, opts }) {
  let records = [];
  let sideReviews = [];
  let sideQa = [];
  let status = 'ok';

  if (dataType === DATA_TYPES.PRODUCT) {
    const raw = await adapter.collectProduct(query, opts);
    if (Array.isArray(raw)) {
      records = raw;
    } else {
      records = raw.products || [];
      sideReviews = raw.reviews || [];
      sideQa = raw.qa || [];
    }
  } else if (dataType === DATA_TYPES.REVIEW) {
    records = await adapter.collectReviews(itemId || query, opts);
  } else if (dataType === DATA_TYPES.QA) {
    records = await adapter.collectQa(itemId || query, opts);
  }

  const count = await addRecords(dataType, records);
  if (sideReviews.length) await addRecords('review', sideReviews);
  if (sideQa.length) await addRecords('qa', sideQa);

  const total = count + sideReviews.length + sideQa.length;
  const message =
    sideReviews.length || sideQa.length
      ? `商品 ${count} 条；关联评论 ${sideReviews.length} 条；关联问答 ${sideQa.length} 条`
      : '';
  return { platform: adapter.id, dataType, strategy: adapter.strategy, count: total, status, message };
}
