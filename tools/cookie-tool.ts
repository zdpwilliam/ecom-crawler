// Cookie 提取小工具
// 作用：把你自己在浏览器里的登录态导出成标准 JSON，供爬取时自动注入（绕过登录墙）。
// 用法：
//   交互提取（弹出真实浏览器，登录后自动保存；档案持久化，重登免重复登录）：
//     node tools/cookie-tool.js extract --platform taobao
//   指定登录页 / 无头自动等待：
//     node tools/cookie-tool.js extract --platform jd --url https://passport.jd.com --timeout 60
//   查询持久化浏览器档案中某平台的实时登录态（headless，已登录则同步快照）：
//     node tools/cookie-tool.js probe --platform kuaishou
//   从浏览器复制的 "a=1; b=2" 或 JSON 转换：
//     node tools/cookie-tool.js convert --platform taobao --in cookies.txt
//     node tools/cookie-tool.js convert --platform taobao --cookies "cookie1=val1; cookie2=val2"
//   查看已保存的 Cookie 文件：
//     node tools/cookie-tool.js list
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = path.resolve(__dirname, '..', 'data', 'cookies');
// 持久化浏览器档案根目录：每平台一个独立档案（Cookie/localStorage 跨次保留，
// 重登时通常已带会话可秒过；probe 也从这里读取实时登录态）
const PROFILE_ROOT = path.resolve(__dirname, '..', 'data', 'chrome-profiles');
const profileDir = (platform) => path.join(PROFILE_ROOT, platform);
const LOGIN_URLS = {
  taobao: 'https://login.taobao.com/member/login.jhtml',
  jd: 'https://passport.jd.com/new/login.aspx',
  pdd: 'https://mobile.yangkeduo.com/login.html',
  amazon: 'https://www.amazon.com/ap/signin',
  vip: 'https://www.vip.com/',
  xianyu: 'https://login.goofish.com/',
  dewu: 'https://www.dewu.com/',
  suning: 'https://passport.suning.com/',
  huawei: 'https://www.vmall.com/',
  // 2026-10-26 扩展四平台（登录入口均在主站，登录后 Cookie 自动捕获）
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/login',
  kuaishou: 'https://www.kuaishou.com/',
};

function parseArgs(argv: string[]): Record<string, any> {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) a[x.slice(2)] = argv[i + 1];
    else a._.push(x);
  }
  return a;
}

function waitForEnter() {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('登录完成后按 Enter 保存 Cookie … ', () => {
      rl.close();
      resolve();
    });
  });
}

// 登录态检测：不同平台的关键 Cookie 特征（命中即认为已登录，立即保存）
export const LOGIN_MARKERS = {
  vip: (cookies) => {
    const u = cookies.find((c) => c.name === 'VipUINFO');
    if (!u) return false;
    // 未登录形态：luc:a|suc:a（URL 编码 luc%3Aa%7Csuc%3Aa）。
    // 2026-10-27 实测：持久化档案里的脏游客 Cookie 还有 luc:b|suc:b|… 变体，旧判定只排除了
    // a 变体 → 弹窗 3 秒即误判「已登录」并自动关闭浏览器。此处只排除实测到的两种游客首段
    // （字母 a/b），其余形态交给 LOGIN_CONFIRM.vip 页面级二次确认兜底（脏档案下 Cookie 判定不可靠）。
    const v = decodeURIComponent(u.value || '');
    const head = v.split('|').slice(0, 2).join('|');
    return !/^luc:[ab]\|suc:[ab]$/.test(head);
  },
  // 2026-10-26 扩展四平台：以「会话 Cookie 存在且非空」为登录信号（保守判定，宁可漏报不误报）
  xiaohongshu: (cookies) => {
    const s = cookies.find((c) => c.name === 'web_session');
    return !!s && (s.value || '').length >= 20;
  },
  douyin: (cookies) => {
    const s = cookies.find((c) => c.name === 'sessionid' || c.name === 'sessionid_ss');
    return !!s && (s.value || '').length >= 10;
  },
  tiktok: (cookies) => {
    const s = cookies.find((c) => c.name === 'sessionid' || c.name === 'sid_tt');
    return !!s && (s.value || '').length >= 10;
  },
  kuaishou: (cookies) => {
    const s = cookies.find((c) => c.name === 'passToken' || /^kuaishou\.server\.webday\d+_st$/.test(c.name));
    return !!s && (s.value || '').length >= 10;
  },
};

// 页面级二次确认：cookie marker 命中后再验证（防「游客也会种同名 Cookie」误判）。
// 返回 true=已登录 / false=未确认（继续轮询）/ 异常时由调用方按 null 处理（回退旧行为）。
// 2026-10-27 实测：小红书游客态页面 8s 内自种 38 字符 web_session（有头 Chrome；headless 不种），
// 仅靠 cookie 会「弹窗即关」。游客态右上角有 .login-btn 登录按钮，登录后消失 → 以此做确认。
export const LOGIN_CONFIRM = {
  xiaohongshu: async (page) => page.evaluate(() => !document.querySelector('.login-btn')),
  // 唯品会：游客态头部有「请登录」入口，登录后展示昵称/会员信息。
  // Cookie 判定对脏档案（旧会话 Cookie 残留）不可靠，必须页面级确认。
  vip: async (page) =>
    page.evaluate(() => {
      const head = document.querySelector('#J_header, .header, header, .topbar') || document.body;
      const t = String(head.innerText || document.body.innerText || '').slice(0, 2500);
      return !/请登录/.test(t);
    }),
};

// 登录自动关闭决策：cookie 命中 + 页面确认。pageConfirmed=null 表示平台无确认项（保持旧行为）。
export function shouldAutoClose(markerHit, pageConfirmed) {
  if (!markerHit) return false;
  if (pageConfirmed === null || pageConfirmed === undefined) return true;
  return pageConfirmed === true;
}

// 启动浏览器（持久化档案版）：返回 context（launchPersistentContext 下 context 即浏览器句柄）。
// 优先系统 Chrome；档案被占用/启动失败时退回 Playwright 内核 + 一次性临时档案。
async function launchExtractBrowser(platform: string, opts: { headless?: boolean; fresh?: boolean } = {}) {
  const { headless, fresh = false } = opts;
  const { chromium } = await import('playwright');
  const args = ['--start-maximized', '--disable-blink-features=AutomationControlled'];
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  const dir = fresh ? fs.mkdtempSync(path.join(PROFILE_ROOT, '_tmp-')) : profileDir(platform);
  try {
    const ctx = await chromium.launchPersistentContext(dir, { headless, channel: 'chrome', viewport: null, args });
    console.log(headless ? `（系统 Chrome · headless · 档案 ${dir}）` : `（系统 Chrome · 档案 ${dir}）`);
    return { ctx, dir };
  } catch (e) {
    console.log(`系统 Chrome 启动失败（${String(e.message).slice(0, 70)}），退回 Playwright 内核 + 临时档案`);
    const tmp = fs.mkdtempSync(path.join(PROFILE_ROOT, '_tmp-'));
    const ctx = await chromium.launchPersistentContext(tmp, { headless, viewport: null, args });
    return { ctx, dir: tmp };
  }
}

async function extract(platform, opts) {
  const url = opts.url || LOGIN_URLS[platform] || `https://www.${platform}.com`;
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  const { ctx } = await launchExtractBrowser(platform, { headless: !!opts.headless });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.bringToFront();
  console.log(`已打开登录页：${url}`);
  console.log('请在弹出的浏览器中完成登录（扫码 / 账号密码）。登录成功后会自动保存，无需其他操作。');
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const deadline = opts.timeout ? Date.now() + Number(opts.timeout) * 1000 : 0;
  const marker = LOGIN_MARKERS[platform];
  let lastCookies = [];
  let loggedIn = false;

  // 轮询 Cookie 快照：登录成功立即保存；窗口被关也能用最近快照兜底
  while (true) {
    try {
      lastCookies = await ctx.cookies();
      if (marker && marker(lastCookies)) {
        const confirmFn = LOGIN_CONFIRM[platform];
        let confirmed = null;
        if (confirmFn) {
          confirmed = await confirmFn(page).catch(() => null);
          if (confirmed === false) {
            // cookie 命中但页面仍是游客态（如小红书游客 web_session）——继续等，不误关
            console.log('检测到疑似登录 Cookie，但页面尚未确认登录（登录成功后自动保存，请继续操作）…');
          }
        }
        if (shouldAutoClose(true, confirmed)) {
          loggedIn = true;
          console.log('✅ 检测到登录态，立即保存…');
          break;
        }
      }
    } catch {
      if (lastCookies.length) {
        console.log('⚠️ 浏览器已关闭，用最近一次 Cookie 快照保存。');
      } else {
        console.error('提取失败：浏览器在保存前被关闭，且没有可用快照。请重跑并保持窗口打开。');
        process.exit(1);
      }
      break;
    }
    if (deadline && Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 3000));
  }

  const cookies = lastCookies;
  if (!cookies.length) {
    console.error('提取失败：未捕获到任何 Cookie。');
    await ctx.close().catch(() => {});
    process.exit(1);
  }
  const file = path.join(COOKIES_DIR, `${platform}.json`);
  fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
  console.log(`✅ 已保存 ${cookies.length} 条 Cookie → ${file}${loggedIn ? '（已确认登录态）' : '（注意：未检测到明确登录态，若采集仍被拦截请重新提取）'}`);
  console.log('采集时无需再设 CRAWL_COOKIES，系统会自动读取该文件注入登录态。');
  await ctx.close().catch(() => {});
}

// 浏览器态登录检测：headless 打开该平台的持久化浏览器档案，读取其中实时 Cookie 判定登录态。
// 判定已登录时顺带把档案内最新 Cookie 同步为采集用快照（cookies/<platform>.json）。
// 输出：stdout 最后一行 JSON：{ platform, status: logged-in|guest|uncertain|no-profile|unsupported|error, ... }
async function probe(platform, opts) {
  const marker = LOGIN_MARKERS[platform];
  if (!marker) {
    console.log(JSON.stringify({ platform, status: 'unsupported', detail: '该平台暂无浏览器态登录判定标记（LOGIN_MARKERS 未收录）' }));
    return;
  }
  if (!fs.existsSync(profileDir(platform))) {
    console.log(JSON.stringify({ platform, status: 'no-profile', detail: '该平台尚无持久化浏览器档案，请先点「🔑登录」提取一次登录态' }));
    return;
  }
  const url = opts.url || LOGIN_URLS[platform] || `https://www.${platform}.com`;
  let ctx;
  try {
    ({ ctx } = await launchExtractBrowser(platform, { headless: true }));
  } catch (e) {
    console.log(JSON.stringify({ platform, status: 'error', detail: `档案浏览器启动失败（可能被其他提取进程占用）：${String(e.message).slice(0, 80)}` }));
    return;
  }
  try {
    const cookies = await ctx.cookies();
    const markerHit = marker(cookies);
    const confirmFn = LOGIN_CONFIRM[platform];
    let pageConfirmed = null;
    if (markerHit && confirmFn) {
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(5000);
      pageConfirmed = await confirmFn(page).catch(() => null);
    }
    const base = { platform, cookieCount: cookies.length, markerHit, pageConfirmed, cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, expires: c.expires })) };
    if (shouldAutoClose(markerHit, pageConfirmed)) {
      fs.mkdirSync(COOKIES_DIR, { recursive: true });
      fs.writeFileSync(path.join(COOKIES_DIR, `${platform}.json`), JSON.stringify(cookies, null, 2));
      console.log(JSON.stringify({ ...base, status: 'logged-in', saved: true, detail: `浏览器档案内检测到登录态（${cookies.length} 条 Cookie），已同步为采集用快照` }));
    } else if (!markerHit) {
      console.log(JSON.stringify({ ...base, status: 'guest', detail: '浏览器档案内未检测到登录 Cookie（游客态）' }));
    } else {
      console.log(JSON.stringify({ ...base, status: 'uncertain', detail: '检测到疑似登录 Cookie 但页面未确认登录（可能为游客种下的同名 Cookie）' }));
    }
  } catch (e) {
    console.log(JSON.stringify({ platform, status: 'error', detail: `探测异常：${String(e.message).slice(0, 100)}` }));
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function convert(platform, opts) {
  if (!opts.in && !opts.cookies) {
    console.error('convert 需要 --in <文件> 或 --cookies "a=1; b=2"');
    process.exit(1);
  }
  const raw = opts.in ? fs.readFileSync(opts.in, 'utf8') : opts.cookies;
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch {
    arr = raw
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const i = pair.indexOf('=');
        return { name: pair.slice(0, i), value: pair.slice(i + 1) };
      });
  }
  if (!Array.isArray(arr)) arr = [arr];
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  const file = path.join(COOKIES_DIR, `${platform}.json`);
  fs.writeFileSync(file, JSON.stringify(arr, null, 2));
  console.log(`✅ 已转换并保存 ${arr.length} 条 → ${file}`);
}

function list() {
  if (!fs.existsSync(COOKIES_DIR)) {
    console.log('尚无已保存的 Cookie 文件。');
    return;
  }
  const files = fs.readdirSync(COOKIES_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) return console.log('尚无已保存的 Cookie 文件。');
  for (const f of files) {
    const arr = JSON.parse(fs.readFileSync(path.join(COOKIES_DIR, f), 'utf8'));
    console.log(`  ${f}  (${arr.length} 条)`);
  }
}

function help() {
  console.log(`Cookie 提取工具

extract  --platform <id> [--url <登录页>] [--timeout <秒>] [--headless]
probe    --platform <id>   # headless 读取持久化浏览器档案的实时登录态，已登录则同步快照
convert  --platform <id> --in <文件> | --cookies "a=1; b=2"
list
`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

switch (cmd) {
  case 'extract':
    if (!args.platform) { console.error('需 --platform <id>'); process.exit(1); }
    extract(args.platform, args).catch((e) => { console.error('提取失败：', e.message); process.exit(1); });
    break;
  case 'probe':
    if (!args.platform) { console.error('需 --platform <id>'); process.exit(1); }
    probe(args.platform, args).catch((e) => { console.log(JSON.stringify({ platform: args.platform, status: 'error', detail: e.message })); process.exit(1); });
    break;
  case 'convert':
    convert(args.platform || 'self', args).catch((e) => { console.error('转换失败：', e.message); process.exit(1); });
    break;
  case 'list':
    list();
    break;
  default:
    help();
}
