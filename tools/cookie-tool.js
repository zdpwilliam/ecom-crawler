// Cookie 提取小工具
// 作用：把你自己在浏览器里的登录态导出成标准 JSON，供爬取时自动注入（绕过登录墙）。
// 用法：
//   交互提取（弹出真实浏览器，登录后回车保存）：
//     node tools/cookie-tool.js extract --platform taobao
//   指定登录页 / 无头自动等待：
//     node tools/cookie-tool.js extract --platform jd --url https://passport.jd.com --timeout 60
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
const LOGIN_URLS = {
  taobao: 'https://login.taobao.com/member/login.jhtml',
  jd: 'https://passport.jd.com/new/login.aspx',
  pdd: 'https://mobile.yangkeduo.com/login.html',
  amazon: 'https://www.amazon.com/ap/signin',
  vip: 'https://www.vip.com/',
  xianyu: 'https://login.goofish.com/',
  dewu: 'https://www.dewu.com/',
  suning: 'https://passport.suning.com/',
  // 2026-10-26 扩展四平台（登录入口均在主站，登录后 Cookie 自动捕获）
  xiaohongshu: 'https://www.xiaohongshu.com/',
  douyin: 'https://www.douyin.com/',
  tiktok: 'https://www.tiktok.com/login',
  kuaishou: 'https://www.kuaishou.com/',
};

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x.startsWith('--')) a[x.slice(2)] = argv[i + 1];
    else a._.push(x);
  }
  return a;
}

function waitForEnter() {
  return new Promise((resolve) => {
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
    // 未登录时 VipUINFO 固定为 luc:a|suc:a，登录后包含账号名
    return !!u && !/^luc%3Aa%7Csuc%3Aa/.test(u.value || '');
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
};

// 登录自动关闭决策：cookie 命中 + 页面确认。pageConfirmed=null 表示平台无确认项（保持旧行为）。
export function shouldAutoClose(markerHit, pageConfirmed) {
  if (!markerHit) return false;
  if (pageConfirmed === null || pageConfirmed === undefined) return true;
  return pageConfirmed === true;
}

async function extract(platform, opts) {
  const { chromium } = await import('playwright');
  const url = opts.url || LOGIN_URLS[platform] || `https://www.${platform}.com`;
  fs.mkdirSync(COOKIES_DIR, { recursive: true });
  // 优先用系统安装的 Chrome（完整功能、可正常操作），不可用再退回 Playwright 内核；
  // 最大化窗口并置顶，避免「弹出了但没法操作」。
  let browser;
  try {
    browser = await chromium.launch({ headless: !!opts.headless, channel: 'chrome', args: ['--start-maximized'] });
    console.log('（使用系统 Chrome）');
  } catch {
    browser = await chromium.launch({ headless: !!opts.headless, args: ['--start-maximized'] });
  }
  const ctx = await browser.newContext({ viewport: null }); // 跟随真实窗口大小
  const page = await ctx.newPage();
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
    await browser.close().catch(() => {});
    process.exit(1);
  }
  const file = path.join(COOKIES_DIR, `${platform}.json`);
  fs.writeFileSync(file, JSON.stringify(cookies, null, 2));
  console.log(`✅ 已保存 ${cookies.length} 条 Cookie → ${file}${loggedIn ? '（已确认登录态）' : '（注意：未检测到明确登录态，若采集仍被拦截请重新提取）'}`);
  console.log('采集时无需再设 CRAWL_COOKIES，系统会自动读取该文件注入登录态。');
  await browser.close().catch(() => {});
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
  case 'convert':
    convert(args.platform || 'self', args).catch((e) => { console.error('转换失败：', e.message); process.exit(1); });
    break;
  case 'list':
    list();
    break;
  default:
    help();
}
