// 零依赖 HTTP 服务：暴露采集 / 查询 / 导出 / 定时任务 / 代理池 / Cookie 等 API + 静态托管仪表盘。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCollection } from './collectors.ts';
import { listPlatforms } from './adapters/registry.ts';
import { query, stats, loadStore, addRecords, listJobs, saveJob, getJob, removeJob, getRuns, storageInfo, clearData, setBackend } from './storage.ts';
import { preflight, migrationState, migrateAndSwitch } from './storage-migrate.ts';
import { buildExport } from './export.ts';
import { startScheduler, runJob } from './scheduler.ts';
import { listProxies, poolSize, reloadProxies, addProxy, removeProxy, testAllProxies } from './proxy-pool.ts';
import { fingerprintEnabled, randomFingerprint, getFingerprintPool, getFingerprintMode, addFingerprints, clearFingerprints } from './fingerprint.ts';
import { acquireSession, sessionStats, renewSessionPool } from './session-pool.ts';
import { loadSettings, saveSettings, applySettings } from './settings.ts';
import { getLogs } from './runlog.ts';
import { requestStop } from './stop-flag.ts';
import { GenericScrapeAdapter, loadHtml } from './adapters/scrape/generic.ts';
import { getScrapeAdapter } from './adapters/registry.ts';
import { getStatus, checkLogin, checkLoginCached, checkAll, saveCookieFile, startLoginCheckScheduler } from './login-check.ts';
import { runTest } from './test-run.ts';
import { PROJECT_ROOT, PUBLIC_DIR as PUBLIC, DATA_DIR, COOKIES_DIR } from './paths.ts';

const PORT = process.env.PORT || 4311;

// 启动时套用持久化设置：先定存储后端，再套爬虫参数
const SETTINGS = await loadSettings();
if (SETTINGS.storageBackend) process.env.STORE_BACKEND = SETTINGS.storageBackend;
applySettings(SETTINGS);

await loadStore();

// 启动前自检：浏览器缺失则自动下载（仅一次），确保开箱即用。
(async () => {
  try {
    const { ensureBrowser } = await import('../../tools/ensure-browser.ts');
    await ensureBrowser();
  } catch {
    /* 自检失败不阻塞启动 */
  }
})();

// 启动定时采集调度器
try {
  await startScheduler();
} catch (e) {
  console.error('[scheduler] 启动失败：', e.message);
}

// 启动登录态定时检测调度器（间隔由 settings.loginCheckMin 控制，0=关闭）
try {
  startLoginCheckScheduler();
} catch (e) {
  console.error('[login-check] 调度器启动失败：', e.message);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function send(res, code, body, type = 'application/json', headers = {}) {
  const data = type === 'application/json' ? JSON.stringify(body) : body;
  res.writeHead(code, { 'Content-Type': `${type}; charset=utf-8`, ...headers });
  res.end(data);
}

function readBody(req): Promise<any> {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      try {
        resolve(d ? JSON.parse(d) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  // 审计日志：所有非 GET 请求落 data/audit.log（ Method 路径 时间），便于追溯误操作
  if (req.method !== 'GET') {
    try {
      fs.appendFileSync(path.join(DATA_DIR, 'audit.log'), `${new Date().toISOString()} ${req.method} ${p}\n`);
    } catch {
      /* ignore */
    }
  }
  try {
    if (p === '/api/platforms') return send(res, 200, listPlatforms());
    if (p === '/api/stats') return send(res, 200, await stats());

    // 数据抓取技术矩阵：全站技术栈 + 各平台当前通道（设置页「抓取技术」面板用）
    if (p === '/api/tech-matrix') {
      const { TECH_STACK, TECH_MATRIX } = await import('./adapters/scrape/tech-matrix.ts');
      return send(res, 200, { stack: TECH_STACK, matrix: TECH_MATRIX });
    }

    // 平台通道诊断：按技术通道独立试跑搜索链路（直连接口 / 浏览器渲染 / fetch 直取），
    // 通道间不回退，产出可横向对比结果与最优通道结论（数据抓取技术面板「平台通道诊断」）。
    // 真实网络请求，浏览器通道可能需要 30~90 秒。
    if (p === '/api/tech-diagnose' && req.method === 'POST') {
      const b = await readBody(req);
      const platform = String(b.platform || '').trim();
      const query = String(b.query || '').trim() || '手机';
      const adapter = getScrapeAdapter(platform);
      if (!adapter || typeof (adapter as any).diagnoseChannels !== 'function') {
        return send(res, 400, { error: `平台 ${platform || '(空)'} 不支持通道诊断` });
      }
      try {
        const r = await (adapter as any).diagnoseChannels(query);
        return send(res, 200, r);
      } catch (e: any) {
        return send(res, 500, { error: `通道诊断失败：${e.message}` });
      }
    }

    // 运行日志（前端「采集中」模块轮询增量，滚动展示采集过程）
    if (p === '/api/logs') {
      const since = Number(url.searchParams.get('since'));
      return send(res, 200, getLogs(Number.isFinite(since) ? since : -1));
    }

    if (p === '/api/data') {
      const type = url.searchParams.get('type') || 'product';
      const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const pageSize = Math.min(100, Math.max(5, Number(url.searchParams.get('pageSize')) || 20));
      const platform = url.searchParams.get('platform');
      const q = url.searchParams.get('q');
      const all = await query({ type, platform, q, limit: 1000000 });
      const total = all.length;
      const rows = all.slice((page - 1) * pageSize, page * pageSize);
      return send(res, 200, { type, total, page, pageSize, rows });
    }

    if (p === '/api/collect' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await runCollection({
        ...b,
        withDetails: b.withDetails,
        detailLimit: b.detailLimit,
        detailFixture: b.detailFixture,
      });
      return send(res, 200, r);
    }

    // 手动停止采集：置位停止标志，采集流程在下一个检查点安全退出
    // （当前网络请求完成后不再继续，已入库的数据保留）
    if (p === '/api/collect/stop' && req.method === 'POST') {
      requestStop();
      return send(res, 200, { status: 'ok', message: '停止指令已发出：当前网络请求完成后不再继续采集' });
    }

    // 导出：CSV / JSON 下载（保存到本地）
    if (p === '/api/export' && req.method === 'GET') {
      const type = url.searchParams.get('type') || 'product';
      const format = (url.searchParams.get('format') || 'json').toLowerCase();
      const out = await buildExport({
        type,
        format,
        platform: url.searchParams.get('platform') || undefined,
        q: url.searchParams.get('q') || undefined,
      });
      res.writeHead(200, {
        'Content-Type': out.mime,
        'Content-Disposition': `attachment; filename="${out.filename}"`,
      });
      return res.end(out.content);
    }

    // 定时任务
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, await listJobs());
    if (p === '/api/jobs/runs' && req.method === 'GET') return send(res, 200, await getRuns(50));
    if (p === '/api/jobs' && req.method === 'POST') {
      const b = await readBody(req);
      const job = await saveJob(b);
      return send(res, 200, job);
    }
    if (p === '/api/jobs/run' && req.method === 'POST') {
      const b = await readBody(req);
      const r = await runJob(b.id);
      return send(res, 200, r || { error: '任务不存在或已禁用' });
    }
    if (p === '/api/jobs' && req.method === 'DELETE') {
      const id = url.searchParams.get('id');
      if (!id) return send(res, 400, { error: '需提供 id' });
      await removeJob(id);
      return send(res, 200, { status: 'ok' });
    }

    // 代理池
    if (p === '/api/proxy' && req.method === 'GET') {
      return send(res, 200, { poolSize: poolSize(), proxies: listProxies() });
    }
    if (p === '/api/proxy/reload' && req.method === 'POST') {
      const list = reloadProxies();
      return send(res, 200, { poolSize: list.length, proxies: listProxies() });
    }
    if (p === '/api/proxy/add' && req.method === 'POST') {
      const b = await readBody(req);
      try {
        const r = addProxy(b.proxy);
        return send(res, 200, { status: 'ok', ...r, poolSize: poolSize() });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    if (p === '/api/proxy/test' && req.method === 'POST') {
      const results = await testAllProxies();
      return send(res, 200, { status: 'ok', results, proxies: listProxies() });
    }
    if (p === '/api/proxy' && req.method === 'DELETE') {
      const proxy = url.searchParams.get('proxy');
      if (!proxy) return send(res, 400, { error: '需提供 proxy 参数' });
      const r = removeProxy(proxy);
      return send(res, 200, { status: 'ok', ...r, poolSize: poolSize() });
    }

    // 爬虫运行时设置（每次调用生效，持久化）
    if (p === '/api/settings' && req.method === 'GET') {
      return send(res, 200, await loadSettings());
    }
    if (p === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      const s = await saveSettings(b);
      return send(res, 200, s);
    }

    // 淘宝开放平台官方 API 连通性测试（用设置页当前凭证发一次轻量调用）
    if (p === '/api/top/test' && req.method === 'POST') {
      const { TaobaoTopAdapter } = await import('./adapters/official/taobao-top.ts');
      const ad = new TaobaoTopAdapter();
      if (!ad.hasCreds()) return send(res, 200, { ok: false, error: '未配置 AppKey/AppSecret（系统设置 → 淘宝开放平台）' });
      try {
        const j = await ad.call('taobao.items.onsale.get', { page_no: 1, page_size: 1, fields: 'num_iid,title' });
        const n = j?.items_onsale_get_response?.total_results;
        return send(res, 200, { ok: true, method: 'taobao.items.onsale.get', detail: `签名验证通过，卖家在售商品共 ${n ?? '?'} 件` });
      } catch (e) {
        return send(res, 200, { ok: false, error: e.message });
      }
    }

    // 平台登录状态：面板展示 / 手动检测 / 全量检测 / 手动保存登录信息
    if (p === '/api/login/status' && req.method === 'GET') {
      const s = await loadSettings();
      const status = getStatus({ fillMissing: true });
      return send(res, 200, { ...status, intervalMin: Number(s.loginCheckMin) || 0 });
    }
    if (p === '/api/login/check' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.platform) return send(res, 400, { error: '需提供 platform' });
      // 检测结果回写缓存：否则面板下次读取又拿回旧值（检测等于白测）
      const r = await checkLoginCached(b.platform);
      return send(res, 200, r);
    }
    if (p === '/api/login/check-all' && req.method === 'POST') {
      const cache = await checkAll();
      return send(res, 200, cache);
    }
    if (p === '/api/login/save-cookie' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.platform) return send(res, 400, { error: '需提供 platform' });
      try {
        const r = saveCookieFile(b.platform, b.cookies);
        // 保存后立即对该平台做一次真实检测，面板即刻展示有效性
        const { logs: _omit, ...checked } = await checkLogin(b.platform);
        const cache = getStatus();
        cache.results[b.platform] = checked;
        return send(res, 200, { status: 'ok', ...r, login: checked });
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }

    // 浏览器态登录检测：读取「提取登录态」所用持久化浏览器档案中该平台的实时登录状态。
    // 与「检测」（读已保存 Cookie 文件）互补：浏览器态反映档案里最新 Cookie（含未同步到快照的），
    // 若判定已登录会顺带把最新 Cookie 同步为采集用快照。headless 运行约 10~40 秒。
    if (p === '/api/login/check-browser' && req.method === 'POST') {
      const b = await readBody(req);
      const platform = String(b.platform || '').trim();
      if (!/^[a-z0-9_-]{1,20}$/i.test(platform)) return send(res, 400, { error: '需提供合法 platform' });
      try {
        const r: any = await new Promise<any>((resolve) => {
          const child = spawn(process.execPath, ['tools/cookie-tool.ts', 'probe', '--platform', platform], {
            cwd: PROJECT_ROOT,
            timeout: 90000,
          });
          let out = '';
          child.stdout.on('data', (c) => { out += c; });
          child.stderr.on('data', (c) => { out += c; });
          child.on('error', (e) => resolve({ status: 'error', detail: `probe 进程启动失败：${e.message}` }));
          child.on('close', (code) => {
            // 约定：stdout 最后一行 JSON 为结果
            const lines = out.trim().split(/\r?\n/);
            for (let i = lines.length - 1; i >= 0; i--) {
              if (lines[i].startsWith('{')) {
                try { return resolve(JSON.parse(lines[i])); } catch {}
              }
            }
            resolve({ status: 'error', detail: `probe 退出码 ${code}，无 JSON 结果：${out.trim().slice(-160)}` });
          });
        });
        return send(res, 200, { platform, ...r });
      } catch (e) {
        return send(res, 500, { platform, status: 'error', detail: e.message });
      }
    }

    // 一键测试（采集前体检）：按工作台配置发真实请求，逐步返回 链接/状态/响应/提取数据（不落库）
    if (p === '/api/test-run' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.platform) return send(res, 400, { error: '需提供 platform' });
      try {
        const r = await runTest({
          platform: b.platform,
          dataType: b.dataType || 'product',
          query: b.query || '手机',
          itemId: b.itemId || '',
        });
        return send(res, 200, r);
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }

    // 补抓单个商品的详情（SPU/SKU/评论/问答）：数据管理页抽屉「补抓详情」用。
    // 对已入库商品发一次真实详情请求，把 SPU/SKU 合入 specs 并回填缺失字段，更新原记录。
    if (p === '/api/detail-refetch' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id) return send(res, 400, { error: '需提供商品记录 id' });
      const rows = await query({ type: 'product', limit: 1000000 });
      const p0 = rows.find((r) => r.id === b.id);
      if (!p0) return send(res, 404, { error: '商品记录不存在（可能已被清空）' });
      const adapter = getScrapeAdapter(p0.platform);
      if (!adapter) return send(res, 400, { error: `未知平台：${p0.platform}` });
      const cfgUrl = p0.url || '';
      if (!/^https?:\/\//.test(cfgUrl) && !p0.itemId) {
        return send(res, 400, { error: '该记录既无商品链接也无 itemId，无法定位详情页' });
      }
      try {
        const d = await adapter.collectDetail(/^https?:\/\//.test(cfgUrl) ? cfgUrl : p0.itemId, {});
        const skuCount = (d.skus || []).length;
        const descLen = (d.description || '').length;
        const imgCount = (d.images || []).length;
        const propCount = d.props ? Object.keys(d.props).length : 0;
        if (!d.spu && !skuCount && !descLen && !imgCount && !propCount) {
          return send(res, 200, { status: 'empty', message: '详情页未暴露 SPU/SKU/描述/图片数据（可能需登录态或接口未返回）' });
        }
        const specs = { ...(p0.specs || {}) };
        if (d.spu) specs.spu = { spuId: p0.itemId, title: p0.title, brand: p0.brand, category: p0.category, ...d.spu };
        if (skuCount) specs.skus = d.skus;
        if (propCount) specs.props = d.props;
        const s = d.spu || {};
        // 详情页图片并入（去重，上限 30）；描述只在原记录为空时回填（保留首次采集的原文）
        const images = [...(p0.images || [])];
        for (const im of d.images || []) if (!images.includes(im)) images.push(im);
        const updated = {
          ...p0,
          specs,
          images: images.slice(0, 30),
          description: p0.description || d.description || '',
          brand: p0.brand || s.brandName || s.brand || '',
          category: p0.category || s.categoryName || s.category || '',
          shopName: p0.shopName || s.vendorName || s.shopName || '',
          price: p0.price && Number(p0.price) > 0 ? p0.price : Number(s.price) || p0.price,
          collectedAt: new Date().toISOString(),
        };
        // 顺带把详情页带出的评论/问答落库（自动关联 itemId/商品标题）
        let sideReview = 0, sideQa = 0;
        if (b.withExtras !== false) {
          const rv = (d.reviews || []).map((r) => ({ ...r, itemId: r.itemId || p0.itemId, productTitle: r.productTitle || p0.title }));
          const qa = (d.qa || []).map((q) => ({ ...q, itemId: q.itemId || p0.itemId, productTitle: q.productTitle || p0.title }));
          sideReview = await addRecords('review', rv);
          sideQa = await addRecords('qa', qa);
        }
        await addRecords('product', [updated]);
        return send(res, 200, {
          status: 'ok',
          spu: !!d.spu,
          skuCount,
          descLen,
          imgCount: images.length,
          propCount,
          sideReview,
          sideQa,
          message:
            `已更新：SPU ${d.spu ? '✓' : '✗'}，SKU ${skuCount} 条` +
            (descLen ? `，描述 ${descLen} 字` : '') +
            (images.length ? `，图片 ${images.length} 张` : '') +
            (propCount ? `，规格参数 ${propCount} 项` : '') +
            (sideReview ? `，新入库评论 ${sideReview} 条` : '') +
            (sideQa ? `，问答 ${sideQa} 条` : ''),
        });
      } catch (e) {
        return send(res, 502, { error: `详情补抓失败：${e.message}` });
      }
    }

    // 存储后端运行时切换（页面内一键切 SQLite / MongoDB）
    if (p === '/api/storage/backend' && req.method === 'GET') {
      const info = await storageInfo();
      return send(res, 200, {
        backend: info.backend,
        connected: info.connected !== undefined ? info.connected : true,
        mongoUri: info.mongoUri,
        dbFile: info.dbFile,
      });
    }
    // 预检：源数据统计 + 目标连通性（确认弹窗展示用）
    if (p === '/api/storage/preflight' && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const target = u.searchParams.get('backend') === 'mongodb' ? 'mongodb' : 'sqlite';
      const pf = await preflight(target);
      return send(res, pf.ok ? 200 : 503, pf);
    }
    // 切换后端：migrate=true 时先自动迁移数据再切换（后台执行，进度轮询 /api/storage/migration）
    if (p === '/api/storage/backend' && req.method === 'POST') {
      const b = await readBody(req);
      const target = b.backend === 'mongodb' ? 'mongodb' : 'sqlite';
      if (b.migrate) {
        if (migrationState().running) return send(res, 409, { error: '已有迁移任务在进行中，请等待完成。' });
        const pf = await preflight(target);
        if (!pf.ok) return send(res, 400, { error: pf.error });
        if (pf.from === pf.to) return send(res, 400, { error: `当前已是 ${pf.to} 后端，无需切换。` });
        // 后台执行：迁移 → 成功后 setBackend + saveSettings；立即返回供前端轮询进度
        migrateAndSwitch(target, { setBackend, saveSettings }).catch((e) =>
          console.error('[storage] 迁移任务异常：', e)
        );
        return send(res, 200, { status: 'started', from: pf.from, to: target });
      }
      const which = await setBackend(b.backend);
      await saveSettings({ storageBackend: which });
      const info = await storageInfo();
      return send(res, 200, {
        status: 'ok',
        backend: which,
        connected: info.connected !== undefined ? info.connected : true,
        mongoUri: info.mongoUri,
      });
    }
    // 迁移进度（前端进度条轮询）
    if (p === '/api/storage/migration' && req.method === 'GET') {
      return send(res, 200, migrationState());
    }

    // 字段提取诊断：校准「采集时」的选择器抽取。支持两种来源：
    //   ① 在线 URL —— 走完整爬取引擎（代理池 + 随机指纹 + 浏览器渲染 + 懒加载滚动）
    //   ② 本地 HTML 文件 —— 把目标页另存后离线诊断
    if (p === '/api/diagnose' && req.method === 'POST') {
      const b = await readBody(req);
      const adapter = new GenericScrapeAdapter({ platformId: b.platform || 'jd' });
      const kind = b.kind || 'product';
      if (b.htmlContent) {
        // 浏览器端选文件直接上传内容（用户无需知道服务器路径）；url 仅作展示标签
        return send(res, 200, adapter.diagnose(null, kind, { html: String(b.htmlContent), url: b.url || '本地上传的 HTML 文件' }));
      }
      if (b.url) {
        if (!/^https?:\/\//i.test(b.url)) return send(res, 400, { error: 'URL 需以 http:// 或 https:// 开头' });
        try {
          const html = await loadHtml(b.url, b.platform || 'jd');
          return send(res, 200, adapter.diagnose(null, kind, { html, url: b.url }));
        } catch (e) {
          return send(res, 502, { error: `抓取页面失败：${e.message}（可检查代理池/Cookie，或把页面另存为 HTML 用「本地文件」模式诊断）` });
        }
      }
      if (b.fixturePath) {
        if (!fs.existsSync(b.fixturePath)) return send(res, 400, { error: `文件不存在：${b.fixturePath}` });
        return send(res, 200, adapter.diagnose(b.fixturePath, kind, {}));
      }
      return send(res, 400, { error: '需提供 url（在线诊断）、htmlContent（上传的 HTML 内容）或 fixturePath（服务器本地路径）' });
    }

    // Cookie 文件列表
    if (p === '/api/cookies' && req.method === 'GET') {
      let files = [];
      const fingerprint = {}; // name -> "条数:mtime秒"：前端轮询据此感知「同名文件被重新保存」
      if (fs.existsSync(COOKIES_DIR)) {
        for (const f of fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith('.json'))) {
          files.push(f);
          try {
            const st = fs.statSync(path.join(COOKIES_DIR, f));
            let count = 0;
            try {
              const arr = JSON.parse(fs.readFileSync(path.join(COOKIES_DIR, f), 'utf8'));
              count = Array.isArray(arr) ? arr.length : 0;
            } catch {}
            fingerprint[f] = `${count}:${Math.floor(st.mtimeMs / 1000)}`;
          } catch {}
        }
      }
      return send(res, 200, { cookiesDir: COOKIES_DIR, files, fingerprint });
    }

    // 一键提取登录态：弹出系统 Chrome 让用户登录，cookie-tool 检测到登录成功自动保存。
    // detached 子进程独立存活（不受本请求/服务重启影响），日志写 data/cookie-extract-<平台>.log
    const cookieExtracts = new Map(); // platform -> { startedAt, pid }
    if (p === '/api/cookies/extract' && req.method === 'POST') {
      const b = await readBody(req);
      const platform = String(b.platform || '').trim();
      if (!/^[a-z0-9_-]{1,20}$/i.test(platform)) {
        return send(res, 400, { error: '需提供 platform（如 vip / taobao / jd）' });
      }
      const prev = cookieExtracts.get(platform);
      if (prev && Date.now() - prev.startedAt < 590000) {
        return send(res, 200, { started: true, alreadyRunning: true, platform });
      }
      const logFile = path.resolve(DATA_DIR, `cookie-extract-${platform}.log`);
      const out = fs.openSync(logFile, 'a');
      const child = spawn(process.execPath, ['tools/cookie-tool.ts', 'extract', '--platform', platform, '--timeout', '600'], {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', out, out],
        detached: true,
      });
      child.unref();
      cookieExtracts.set(platform, { startedAt: Date.now(), pid: child.pid });
      child.on('exit', () => {
        try { fs.closeSync(out); } catch {}
        setTimeout(() => cookieExtracts.delete(platform), 1500);
      });
      return send(res, 200, {
        started: true,
        platform,
        hint: '浏览器已弹出：请在窗口内登录该平台，登录成功后自动保存（10 分钟超时）。保存后采集自动注入。',
      });
    }
    if (p === '/api/cookies/extract/status' && req.method === 'GET') {
      const running = [...cookieExtracts.entries()].map(([platform, v]) => ({
        platform,
        startedAt: new Date(v.startedAt).toISOString(),
        seconds: Math.round((Date.now() - v.startedAt) / 1000),
      }));
      return send(res, 200, { running });
    }

    // 查看某平台已保存的登录态 Cookie 内容（面板弹窗展示）
    if (p === '/api/cookies/view' && req.method === 'GET') {
      const platform = url.searchParams.get('platform') || '';
      if (!/^[a-z0-9_-]{1,20}$/i.test(platform)) {
        return send(res, 400, { error: '需提供合法 platform 参数（如 vip）' });
      }
      const fp = path.join(COOKIES_DIR, `${platform}.json`);
      if (!fs.existsSync(fp)) {
        return send(res, 404, { error: `该平台暂无已保存的登录态：data/cookies/${platform}.json 不存在` });
      }
      let cookies = [];
      try {
        cookies = JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (e) {
        return send(res, 500, { error: `Cookie 文件解析失败：${e.message}` });
      }
      if (!Array.isArray(cookies)) cookies = [cookies];
      return send(res, 200, {
        platform,
        file: fp,
        count: cookies.length,
        cookies: cookies.map((c) => ({
          name: c.name || '',
          value: c.value || '',
          domain: c.domain || '',
          path: c.path || '',
          expires: c.expires ?? null,
        })),
      });
    }

    // 存储管理：查看存储位置 / 各目录大小 / 记录数
    if (p === '/api/storage' && req.method === 'GET') {
      return send(res, 200, await storageInfo());
    }
    // 存储管理：清空数据（需 confirm=true 且显式给出 types，绝不默认清空全部）
    if (p === '/api/storage/clear' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.confirm !== true) return send(res, 400, { error: '清空需显式确认：请求体加 { "confirm": true }' });
      if (!Array.isArray(b.types) || (!b.types.length && !b.jobs && !b.exports)) {
        return send(res, 400, {
          error: '需显式提供要清空的 types 数组（如 ["product","review"]）。不接受「默认清空全部」——这是防止误删的安全护栏。',
        });
      }
      console.warn(`[storage] 清空操作：types=${JSON.stringify(b.types)} jobs=${!!b.jobs} exports=${!!b.exports} platform=${b.platform || '(全部)'} q=${b.q ? '(有关键字)' : '(无)'}`);
      const res2 = await clearData({
        types: b.types,
        jobs: !!b.jobs,
        exports: !!b.exports,
        platform: String(b.platform || '').trim(),
        q: String(b.q || '').trim(),
      });
      return send(res, 200, { status: 'ok', ...res2 });
    }

    // 请求指纹随机化：预览一次随机生成的指纹（从会话池抽一个虚拟用户：Cookie+代理+指纹绑定）
    if (p === '/api/fingerprint/spawn' && req.method === 'GET') {
      const st = sessionStats();
      if (!st.total) renewSessionPool(10); // 服务启动后首次预览：自动建池（正常采集运行时会被 renew 覆盖）
      const profile = acquireSession();
      return send(res, 200, {
        enabled: fingerprintEnabled(),
        mode: getFingerprintMode(),
        poolSize: getFingerprintPool().length,
        randomFingerprint: randomFingerprint(),
        sessions: sessionStats(),
        profile: {
          proxy: profile.proxy, userAgent: profile.userAgent, ip: profile.ip,
          acceptLanguage: profile.acceptLanguage, viewport: profile.viewport,
          device: profile.device, secChUa: profile.secChUa, mobile: profile.mobile,
          sid: profile.sid,
        },
      });
    }
    // 指纹池明细：按当前端型模式返回对应子池（可用 ?mode= 临时查另一模式的池）
    if (p === '/api/fingerprint/pool' && req.method === 'GET') {
      const u = new URL(req.url, 'http://x');
      const qm = u.searchParams.get('mode');
      const mode = ['mixed', 'desktop', 'mobile'].includes(qm) ? qm : getFingerprintMode();
      return send(res, 200, { enabled: fingerprintEnabled(), mode, pool: getFingerprintPool(mode) });
    }

    // 追加生成指纹：生成 count 套指定端型（desktop/mobile/mixed）档案并入池（持久化，重启保留）
    if (p === '/api/fingerprint/append' && req.method === 'POST') {
      const b = await readBody(req);
      const kind = ['desktop', 'mobile', 'mixed'].includes(b.kind) ? b.kind : 'mixed';
      if (kind === 'mixed') return send(res, 400, { error: '请指定端型：desktop（仅桌面）或 mobile（仅手机）' });
      const added = addFingerprints(b.count, kind);
      if (!added.length) return send(res, 400, { error: '未能生成新档案（组合已穷尽，请换个端型或减少数量）' });
      return send(res, 200, {
        added: added.length,
        kind,
        poolSize: getFingerprintPool().length,
        samples: added.slice(0, 5).map((f) => ({ device: f.device, ua: f.ua, viewport: f.viewport })),
      });
    }
    // 清空追加档案：恢复到 30 套基础真实设备池（桌面 10 + 移动含平板 20）
    if (p === '/api/fingerprint/extra' && req.method === 'DELETE') {
      const removed = clearFingerprints();
      return send(res, 200, { removed, poolSize: getFingerprintPool().length });
    }

    if (p === '/' || p === '/index.html') {
      const fp = path.join(PUBLIC, 'index.html');
      return send(res, 200, fs.readFileSync(fp), MIME['.html'], { 'Cache-Control': 'no-store' });
    }
    if (p.startsWith('/')) {
      const fp = path.join(PUBLIC, p);
      if (fp.startsWith(PUBLIC) && fs.existsSync(fp)) {
        // 静态资源禁缓存：避免浏览器拿旧版 app.js/index.html 调不存在的接口
        return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp)] || 'text/plain', { 'Cache-Control': 'no-store' });
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  const backend = (process.env.STORE_BACKEND || 'sqlite').toLowerCase();
  console.log(`电商数据采集平台已启动 → http://localhost:${PORT}`);
  console.log(`存储后端：${backend === 'mongodb' ? 'MongoDB (' + (process.env.MONGODB_URI || 'mongodb://localhost:27017') + ')' : 'SQLite (data/ecom.db)'} ｜ 爬取默认开启 ｜ 定时采集已就绪`);
});
