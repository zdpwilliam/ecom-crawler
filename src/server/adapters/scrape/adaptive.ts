// 自适应解析（P1-5）：对抗「站点改版 → 选择器失明」。
// 参考 Scrapling 的 auto_save/adaptive 设计，做轻量自研版：
//   1) 成功采集时记录「卡片特征快照」（标签 + class 词元 + 样例标题）持久化到
//      data/adaptive-selectors.json —— 这是元素的"结构指纹"；
//   2) 配置选择器失配（0 命中）时，按快照相似度在页面里重定位：
//      电商列表卡片 = 「重复出现的同类容器」，统计 (标签, 首个class词元) 的重复簇，
//      与快照词元求 Jaccard 相似度打分，取最高分的簇用宽松字段抽取（链接护栏沿用 cfg）；
//   3) 重定位成功 → runLog 告警 + 更新快照（新结构入库，下次直接对齐新结构）。
// 不引入第三方依赖：与 generic.ts 的轻量 HTML 解析同一套正则路线。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../paths.ts';
import { runLog } from '../../runlog.ts';

const SNAPSHOT_FILE = path.join(DATA_DIR, 'adaptive-selectors.json');

let _store: Record<string, any> = {};
try {
  if (fs.existsSync(SNAPSHOT_FILE)) _store = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
} catch {
  _store = {};
}
function saveStore() {
  try {
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(_store, null, 2), 'utf8');
  } catch (e) {
    console.warn('[adaptive] 快照持久化失败：', e.message);
  }
}

/** 记录一次成功解析的结构快照（卡片标签 + class 词元 + 样例标题）。 */
export function recordSnapshot(platform: string, kind: string, html: string, cardOpen: RegExp) {
  try {
    // 从配置正则本身提取它锚定的标签与 class 词元（如 /<div class="product-card"/i → div + product-card）
    const src = cardOpen.source;
    const m = src.match(/<(\w+)[^>]*class="([^"]*)"/i);
    if (!m) return;
    const tag = m[1];
    const classes = m[2].trim().split(/\s+/).filter(Boolean);
    const key = `${platform}:${kind}`;
    _store[key] = {
      tag,
      classes,
      sampleTitle: (firstText(html, tag) || '').slice(0, 60),
      recordedAt: new Date().toISOString(),
    };
    saveStore();
  } catch {
    /* 快照失败不影响主流程 */
  }
}

function firstText(html: string, tag: string) {
  const m = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{10,120}?)</${tag}>`, 'i'));
  return m ? m[1].replace(/<[^>]*>/g, '').trim() : '';
}

// 从 HTML 里枚举候选卡片容器：(标签, class 全串) → 出现次数
function containerClusters(html: string) {
  const clusters = new Map<string, { tag: string; cls: string; count: number; firstIdx: number }>();
  const re = /<(div|li|section|article|ul)\b[^>]*class="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const cls = m[2].trim();
    if (!cls) continue;
    const clsKey = `${tag}|${cls}`;
    const c = clusters.get(clsKey);
    if (c) c.count++;
    else clusters.set(clsKey, { tag, cls, count: 1, firstIdx: m.index });
    if (clusters.size > 2000) break; // 防御超大页面
  }
  return clusters;
}

function jaccard(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter || 1);
}

/**
 * 自适应重定位：选择器失配时按「重复簇 + 快照相似度」找新卡片结构。
 * 安全护栏（误定位教训：得物把轮播 slide 块当商品卡，且 relocation 成功后回写快照自我强化）：
 *   1) 必须有历史快照才允许重定位（无快照的冷启动启发式关闭——没有"成功结构"参照，
 *      重复簇统计无法区分商品卡与轮播/推荐位，宁可不采也不乱采）；
 *   2) 快照被 relocation 更新过的（viaRelocation）不再作为参照源，防止错误自我强化。
 * 返回 { tag, cls, blocks, similarity, hadSnapshot } 或 null。
 */
export function locateBySnapshot(platform: string, kind: string, html: string) {
  const snap = _store[`${platform}:${kind}`];
  if (!snap || snap.viaRelocation) return null; // 护栏：无成功快照 / 快照本身来自重定位 → 不重定位
  const clusters = containerClusters(html);
  if (!clusters.size) return null;

  // 候选簇：出现 ≥3 次（列表卡片必然重复）
  type Cand = { tag: string; cls: string; count: number; score: number };
  const cands: Cand[] = [];
  for (const c of clusters.values()) {
    if (c.count < 3) continue;
    const classes = c.cls.split(/\s+/);
    // 相似度：与快照的词元 Jaccard + 标签一致加成（上限 1.2）
    const sim = jaccard(classes, snap.classes) + (snap.tag === c.tag ? 0.2 : 0);
    // 重复度得分：簇越大越像列表；相似度加权
    const rep = Math.min(1, c.count / 20);
    cands.push({ tag: c.tag, cls: c.cls, count: c.count, score: rep + sim * 2 });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0];
  if (best.score < 1.0) return null; // 与快照相似度过低宁可失败也不乱采（jaccard≥0.4 才可能达标）

  // 按该簇的 (tag, class) 截取所有块
  const blocks: string[] = [];
  const re = new RegExp(`<${best.tag}\\b[^>]*class="${best.cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'gi');
  let m;
  while ((m = re.exec(html))) {
    // 平衡截取：从开标签末尾配对到闭合
    const start = m.index;
    const gt = html.indexOf('>', start);
    if (gt === -1) break;
    let depth = 1;
    let j = gt + 1;
    while (j < html.length && depth > 0) {
      if (html.startsWith('</', j)) {
        depth--;
        j = html.indexOf('>', j) + 1;
      } else if (html[j] === '<' && html[j + 1] !== '/') {
        const ngt = html.indexOf('>', j);
        if (ngt === -1) break;
        const t = html.slice(j, ngt);
        if (!t.endsWith('/>')) depth++;
        j = ngt + 1;
      } else j++;
    }
    blocks.push(html.slice(gt + 1, j - 1));
    if (blocks.length > 120) break;
  }
  return { tag: best.tag, cls: best.cls, blocks, similarity: best.score, hadSnapshot: !!snap };
}

/** 重定位成功后更新快照（下次直接对齐新结构）。 */
export function updateSnapshot(platform: string, kind: string, tag: string, cls: string) {
  _store[`${platform}:${kind}`] = {
    tag,
    classes: cls.split(/\s+/).filter(Boolean),
    sampleTitle: '',
    recordedAt: new Date().toISOString(),
    viaRelocation: true,
  };
  saveStore();
}
