// 请求指纹随机化引擎
// 与 proxy-pool 的代理轮换配合：每次请求使用不同的 UA / 出口 IP(伪造 X-Forwarded-For)
// / 语言 / 视口，降低被站点指纹识别与封禁的概率。
//
// 指纹来源 = 固定真实设备档案池（FINGERPRINT_POOL）+ 追加生成档案（data/fingerprints-extra.json）：
//   每套档案是「真实存在的一台设备」的完整画像 —— UA ↔ 操作系统 ↔ 视口 ↔ 语言 ↔
//   Client Hints (sec-ch-ua) 彼此一致，绝不做跨设备拼接（如 Safari UA 配 Windows 视口、
//   Edge UA 缺 sec-ch-ua 等），避免一致性校验露馅。追加生成的档案同样按此规则合成。
//   采集运行前 session-pool.renewSessionPool(n) 从池中按统计权重抽 n 套组成本次运行的会话池。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.ts';

const EXTRA_FILE = path.join(DATA_DIR, 'fingerprints-extra.json');

const rint = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ---------- 固定真实设备档案池 ----------
// 字段说明：
//   ua          完整 User-Agent（版本固定为当前真实主流版本，池子定期人工更新）
//   platform    navigator.platform（浏览器环境一致性用）
//   viewport    常见物理分辨率（桌面=宽≥1280；移动=390/414 宽，配移动 UA）
//   mobile      是否移动设备（决定 Client Hints 与视口语义）
//   brand       sec-ch-ua 品牌列表（与 UA 的浏览器/版本严格一致；Safari/Firefox 不发 CH）
//   langs       Accept-Language 候选（按设备销售区域给出，中文设备不会突然 Accept 法语）
const FINGERPRINT_POOL = [
  {
    device: 'Windows 11 · Chrome 131 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'Win32', viewport: [1536, 864], mobile: false,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8'],
  },
  {
    device: 'Windows 10 · Chrome 130 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'Win32', viewport: [1920, 1080], mobile: false,
    brand: '"Chromium";v="130", "Not_A Brand";v="24", "Google Chrome";v="130"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en-US;q=0.8'],
  },
  {
    device: 'Windows 10 · Edge 130 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    platform: 'Win32', viewport: [1366, 768], mobile: false,
    brand: '"Chromium";v="130", "Not_A Brand";v="24", "Microsoft Edge";v="130"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'macOS · Chrome 131 桌面',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'MacIntel', viewport: [1440, 900], mobile: false,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8'],
  },
  {
    device: 'macOS · Safari 17 桌面',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
    platform: 'MacIntel', viewport: [1512, 982], mobile: false,
    brand: null, // Safari 不发送 Client Hints
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Windows 10 · Firefox 132 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
    platform: 'Win32', viewport: [1280, 800], mobile: false,
    brand: null, // Firefox 不发送 Client Hints
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en-US;q=0.7'],
  },
  {
    device: 'iPhone 15 · Safari 移动',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', viewport: [393, 852], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPhone · 微信内嵌 WebView',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.49(0x18003133) NetType/WIFI Language/zh_CN',
    platform: 'iPhone', viewport: [390, 844], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'Android · Chrome 移动',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [412, 915], mobile: true,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android · 华为浏览器',
    ua: 'Mozilla/5.0 (Linux; Android 14; HRY-AL00Ta) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 HuaweiBrowser/14.0.5',
    platform: 'Linux armv8l', viewport: [360, 780], mobile: true,
    brand: '"Chromium";v="114", "Not_A Brand";v="24"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'iPad · Safari 平板',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    platform: 'MacIntel', viewport: [820, 1180], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'Windows 11 · Chrome 129 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    platform: 'Win32', viewport: [1600, 900], mobile: false,
    brand: '"Chromium";v="129", "Not_A Brand";v="24", "Google Chrome";v="129"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.7'],
  },
  // ---- 2026-10-27 基础池扩容（桌面 7→10 / 移动含平板 5→20 / 混合 30），全部真实存在的主流机型+版本组合 ----
  {
    device: 'Windows 11 · Edge 131 桌面',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    platform: 'Win32', viewport: [2560, 1440], mobile: false,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Microsoft Edge";v="131"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8'],
  },
  {
    device: 'macOS · Edge 131 桌面',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    platform: 'MacIntel', viewport: [1512, 982], mobile: false,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Microsoft Edge";v="131"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'macOS · Firefox 133 桌面',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
    platform: 'MacIntel', viewport: [1440, 900], mobile: false,
    brand: null, // Firefox 不发送 Client Hints
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en-US;q=0.7'],
  },
  {
    device: 'iPhone 15 Pro Max · Safari 移动',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', viewport: [430, 932], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPhone 14 · Safari 18 移动',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', viewport: [390, 844], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPhone 13 · 微信内嵌 WebView',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.47(0x18002f33) NetType/WIFI Language/zh_CN',
    platform: 'iPhone', viewport: [390, 844], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPhone · QQ 内嵌 WebView',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 QQ/9.0.0.640 NetType/WIFI',
    platform: 'iPhone', viewport: [390, 844], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPhone · 支付宝内嵌 WebView',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 AlipayClient/10.5.66.8000',
    platform: 'iPhone', viewport: [393, 852], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'Android 15 · Pixel 9 · Chrome 移动',
    ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [412, 915], mobile: true,
    brand: '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · 小米 14 · Chrome 移动',
    ua: 'Mozilla/5.0 (Linux; Android 14; 22127PN0CC) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [393, 873], mobile: true,
    brand: '"Chromium";v="130", "Not_A Brand";v="24", "Google Chrome";v="130"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · Redmi K60 · Chrome 移动',
    ua: 'Mozilla/5.0 (Linux; Android 14; 23013RK75C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [393, 873], mobile: true,
    brand: '"Chromium";v="129", "Not_A Brand";v="24", "Google Chrome";v="129"',
    langs: ['zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.6'],
  },
  {
    device: 'Android 13 · 三星 S23 · Samsung Internet',
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-S9110) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [360, 780], mobile: true,
    brand: '"Chromium";v="117", "Not_A Brand";v="24"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · 华为 Mate60 · 华为浏览器',
    ua: 'Mozilla/5.0 (Linux; Android 14; ALN-AL10; HMSCore 6.13.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 HuaweiBrowser/14.0.2 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [412, 915], mobile: true,
    brand: '"Chromium";v="114", "Not_A Brand";v="24"',
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 12 · 华为 P50 · 夸克浏览器',
    ua: 'Mozilla/5.0 (Linux; U; Android 12; zh-cn; ABR-AL00 Build/HUAWEIABR-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.58 Quark/6.5.5.11 Mobile Safari/537.36',
    platform: 'Linux armv8l', viewport: [393, 849], mobile: true,
    brand: null,
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · vivo X100 · vivo 浏览器',
    ua: 'Mozilla/5.0 (Linux; Android 14; V2313A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.5735.196 Mobile Safari/537.36 VivoBrowser/19.2.0.0',
    platform: 'Linux armv8l', viewport: [393, 851], mobile: true,
    brand: null,
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · OPPO Reno11 · OPPO 浏览器',
    ua: 'Mozilla/5.0 (Linux; Android 14; CPH2609) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.5563.116 Mobile Safari/537.36 HeyTapBrowser/40.7.10.1',
    platform: 'Linux armv8l', viewport: [393, 849], mobile: true,
    brand: null,
    langs: ['zh-CN,zh;q=0.9'],
  },
  {
    device: 'Android 14 · 荣耀 Magic6 · 微信内嵌 WebView',
    ua: 'Mozilla/5.0 (Linux; Android 14; PGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600(0x28003135) XWEB/1160065',
    platform: 'Linux armv8l', viewport: [412, 915], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
  {
    device: 'iPad · Chrome 平板',
    ua: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1',
    platform: 'MacIntel', viewport: [820, 1180], mobile: true,
    brand: null,
    langs: ['zh-CN,zh-Hans;q=0.9'],
  },
];

/** 全量池 = 基础真实设备池 + 追加生成档案。mode: mixed=全部 / desktop=仅桌面 / mobile=仅手机（含平板）。 */
function allPool() {
  return FINGERPRINT_POOL.concat(_extras);
}

// ---------- 追加生成档案（「生成指纹追加至指纹池」功能） ----------
// 与基础池同一合成纪律：UA ↔ 操作系统 ↔ 视口 ↔ Client Hints 严格同源，绝不跨设备拼接。
// 持久化到 data/fingerprints-extra.json，重启保留；端型范围（mixed/desktop/mobile）同样对追加档案生效。
let _extras = [];

function loadExtras() {
  try {
    if (fs.existsSync(EXTRA_FILE)) {
      const arr = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8'));
      if (Array.isArray(arr)) _extras = arr.filter((f) => f && f.ua && typeof f.mobile === 'boolean');
    }
  } catch (e) {
    console.warn('[fingerprint] 读取 fingerprints-extra.json 失败：', e.message);
    _extras = [];
  }
  return _extras;
}

function saveExtras() {
  fs.mkdirSync(path.dirname(EXTRA_FILE), { recursive: true });
  fs.writeFileSync(EXTRA_FILE, JSON.stringify(_extras, null, 2), 'utf8');
}
loadExtras();

// 生成素材：真实存在的主流版本/机型组合（与基础池同一代际）
const GEN = {
  chromeVers: [126, 127, 128, 129, 130, 131],
  edgeVers: [126, 127, 128, 129, 130],
  firefoxVers: [128, 129, 130, 131, 132],
  safariVers: ['17.4', '17.5', '17.6'],
  iosVers: ['16_6', '17_5', '17_6'],
  androidVers: ['12', '13', '14'],
  androidDevices: [
    { model: 'Pixel 7', viewport: [384, 854] },
    { model: 'Pixel 8', viewport: [412, 915] },
    { model: 'SM-S9110', viewport: [384, 854] }, // 三星 S24 国行
    { model: 'SM-G9910', viewport: [360, 800] }, // 三星 S21
    { model: 'M2102K1AC', viewport: [393, 873] }, // 小米 11
    { model: 'V2312A', viewport: [360, 780] }, // iQOO
  ],
  iphoneViewports: [
    [375, 812], [390, 844], [393, 852], [414, 896],
  ],
  ipadViewports: [
    [768, 1024], [810, 1080], [820, 1180],
  ],
  desktopViewports: [
    [1280, 720], [1366, 768], [1440, 900], [1536, 864], [1600, 900], [1920, 1080],
  ],
  desktopLangs: [
    ['zh-CN,zh;q=0.9'], ['zh-CN,zh;q=0.9,en;q=0.8'], ['zh-CN,zh;q=0.9,en-US;q=0.8'],
  ],
  mobileLangs: [['zh-CN,zh-Hans;q=0.9'], ['zh-CN,zh;q=0.9']],
};

/** 合成一套与基础池同源的档案。kind: desktop | mobile。 */
function genFingerprint(kind) {
  const label = `追加 · `;
  if (kind === 'desktop') {
    const roll = Math.random();
    const viewport = pick(GEN.desktopViewports);
    const langs = pick(GEN.desktopLangs);
    if (roll < 0.4) {
      // Windows · Chrome
      const v = pick(GEN.chromeVers);
      return {
        device: `${label}Windows · Chrome ${v} 桌面`,
        ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
        platform: 'Win32', viewport, mobile: false,
        brand: `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
        langs,
      };
    }
    if (roll < 0.6) {
      // Windows · Edge
      const v = pick(GEN.edgeVers);
      return {
        device: `${label}Windows · Edge ${v} 桌面`,
        ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
        platform: 'Win32', viewport, mobile: false,
        brand: `"Chromium";v="${v}", "Not_A Brand";v="24", "Microsoft Edge";v="${v}"`,
        langs,
      };
    }
    if (roll < 0.72) {
      // Windows · Firefox（不发 Client Hints）
      const v = pick(GEN.firefoxVers);
      return {
        device: `${label}Windows · Firefox ${v} 桌面`,
        ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`,
        platform: 'Win32', viewport, mobile: false,
        brand: null,
        langs,
      };
    }
    if (roll < 0.88) {
      // macOS · Chrome
      const v = pick(GEN.chromeVers);
      return {
        device: `${label}macOS · Chrome ${v} 桌面`,
        ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
        platform: 'MacIntel', viewport, mobile: false,
        brand: `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
        langs,
      };
    }
    // macOS · Safari（不发 Client Hints）
    const v = pick(GEN.safariVers);
    return {
      device: `${label}macOS · Safari ${v.split('.')[0]} 桌面`,
      ua: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v} Safari/605.1.15`,
      platform: 'MacIntel', viewport, mobile: false,
      brand: null,
      langs,
    };
  }
  // mobile（手机 + 平板）
  const roll = Math.random();
  if (roll < 0.3) {
    // iPhone · Safari
    const iv = pick(GEN.iosVers);
    const sv = iv.startsWith('16') ? pick(['16.6', '17.0']) : pick(GEN.safariVers);
    return {
      device: `${label}iPhone · Safari ${sv.split('.')[0]} 移动`,
      ua: `Mozilla/5.0 (iPhone; CPU iPhone OS ${iv} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${sv} Mobile/15E148 Safari/604.1`,
      platform: 'iPhone', viewport: pick(GEN.iphoneViewports), mobile: true,
      brand: null,
      langs: pick(GEN.mobileLangs),
    };
  }
  if (roll < 0.42) {
    // iPhone · 微信内嵌 WebView
    const iv = pick(GEN.iosVers);
    const mm = `8.0.${rint(40, 55)}`;
    return {
      device: `${label}iPhone · 微信 WebView 移动`,
      ua: `Mozilla/5.0 (iPhone; CPU iPhone OS ${iv} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/${mm}(0x18003${rint(1000, 9999)}) NetType/WIFI Language/zh_CN`,
      platform: 'iPhone', viewport: pick(GEN.iphoneViewports), mobile: true,
      brand: null,
      langs: pick(GEN.mobileLangs),
    };
  }
  if (roll < 0.52) {
    // Android · 华为浏览器（版本跟随华为内核代际）
    const av = pick(['12', '13']);
    return {
      device: `${label}Android ${av} · 华为浏览器 移动`,
      ua: `Mozilla/5.0 (Linux; Android ${av}; HRY-AL00Ta) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36 HuaweiBrowser/14.0.5`,
      platform: 'Linux armv8l', viewport: pick([[360, 780], [393, 873]]), mobile: true,
      brand: '"Chromium";v="114", "Not_A Brand";v="24"',
      langs: pick(GEN.mobileLangs),
    };
  }
  if (roll < 0.88) {
    // Android · Chrome
    const av = pick(GEN.androidVers);
    const dev = pick(GEN.androidDevices);
    const v = pick(GEN.chromeVers);
    return {
      device: `${label}Android ${av} · Chrome ${v} 移动`,
      ua: `Mozilla/5.0 (Linux; Android ${av}; ${dev.model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Mobile Safari/537.36`,
      platform: 'Linux armv8l', viewport: dev.viewport, mobile: true,
      brand: `"Chromium";v="${v}", "Not_A Brand";v="24", "Google Chrome";v="${v}"`,
      langs: pick(GEN.mobileLangs),
    };
  }
  // iPad · Safari
  const iv = pick(GEN.iosVers);
  const sv = iv.startsWith('16') ? '16.6' : pick(GEN.safariVers);
  return {
    device: `${label}iPad · Safari ${sv.split('.')[0]} 平板`,
    ua: `Mozilla/5.0 (iPad; CPU OS ${iv} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${sv} Mobile/15E148 Safari/604.1`,
    platform: 'MacIntel', viewport: pick(GEN.ipadViewports), mobile: true,
    brand: null,
    langs: pick(GEN.mobileLangs),
  };
}

/** 生成 n 套指定端型的档案并追加至指纹池（去重 + 持久化）。返回本次新增的档案。 */
export function addFingerprints(count, kind = 'mixed') {
  const n = Math.max(1, Math.min(50, Math.round(Number(count) || 1)));
  const kinds = kind === 'desktop' ? ['desktop'] : kind === 'mobile' ? ['mobile'] : ['desktop', 'mobile'];
  const exist = new Set(allPool().map((f) => `${f.ua}|${f.viewport.join('x')}`));
  const added = [];
  for (let i = 0; i < n; i++) {
    let f;
    for (let t = 0; t < 25; t++) {
      f = genFingerprint(pick(kinds));
      const key = `${f.ua}|${f.viewport.join('x')}`;
      if (!exist.has(key)) {
        exist.add(key);
        break;
      }
      f = null;
    }
    if (f) {
      _extras.push(f);
      added.push(f);
    }
  }
  if (added.length) saveExtras();
  return added.map((f) => ({ ...f }));
}

/** 清空全部追加档案（恢复基础池）。返回清空数量。 */
export function clearFingerprints() {
  const n = _extras.length;
  _extras = [];
  if (n) saveExtras();
  return n;
}

/** 固定指纹池（供面板展示与调试）。返回浅拷贝，外部改不动源池。 */
export function getFingerprintPool(mode = _fpMode) {
  return poolFor(mode).map((f) => ({ ...f }));
}

// 当前端型模式：mixed（默认）/ desktop / mobile。由 settings.js applySettings 同步。
let _fpMode = 'mixed';
export function setFingerprintMode(mode) {
  if (['mixed', 'desktop', 'mobile'].includes(mode)) _fpMode = mode;
}
export function getFingerprintMode() {
  return _fpMode;
}
function poolFor(mode = _fpMode) {
  const all = allPool();
  if (mode === 'mobile') return all.filter((f) => f.mobile);
  if (mode === 'desktop') return all.filter((f) => !f.mobile);
  return all;
}

export function randomUA() {
  return (weightedPick(allPool()) || pick(allPool())).ua;
}

// ---------- 随机出口 IP（用于 X-Forwarded-For / X-Real-IP 伪造） ----------
function isReserved([a, b]) {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私有 10.0.0.0/8
  if (a === 127) return true; // 回环
  if (a === 172 && b >= 16 && b <= 31) return true; // 私有 172.16-31
  if (a === 192 && b === 168) return true; // 私有 192.168
  if (a === 169 && b === 254) return true; // 链路本地
  if (a >= 224) return true; // 组播 / 保留
  return false;
}
export function randomIP() {
  let ip;
  do {
    ip = [rint(1, 223), rint(0, 255), rint(0, 255), rint(1, 254)];
  } while (isReserved(ip));
  return ip.join('.');
}

// ---------- 统计采样（P1-6）：按真实流量分布加权抽取，而非均匀随机 ----------
// 30 套档案是「离散的真实设备」，真实世界里它们的出现频率并不相等：
// 移动端占中国电商流量约 7 成、Chrome 系占桌面大头、华为/微信内嵌在国产生态里高频出现。
// 权重表按「设备家族」匹配（新增档案自动继承同族权重，无需逐条标注）。
const FAMILY_WEIGHTS = [
  [/iPhone/i, 24], // iPhone 全家族（Safari/微信/QQ/支付宝内嵌合计约 1/4 流量）
  [/Android.*Chrome 移动/i, 22], // Android 主力 Chrome
  [/华为|HuaweiBrowser|夸克|Quark/i, 8], // 华为浏览器 + 夸克（国产高频）
  [/vivo|OPPO|荣耀/i, 5], // 国产厂商浏览器
  [/SamsungBrowser/i, 2], // 三星国行份额小
  [/iPad/i, 3], // 平板
  [/Windows.*Chrome/i, 12], // Windows Chrome（桌面大头）
  [/Windows.*Edge/i, 7], // Windows Edge（Win11 默认浏览器）
  [/Windows.*Firefox/i, 2],
  [/macOS.*Chrome/i, 5],
  [/macOS.*Safari/i, 3],
  [/macOS.*Edge|macOS.*Firefox/i, 2],
  [/微信|MicroMessenger/i, 6], // 微信内嵌（与 iPhone 重叠时取较大者）
] as const;

function deviceWeight(f: { device?: string; mobile?: boolean }) {
  const d = String(f.device || '');
  let w = 1;
  for (const [re, weight] of FAMILY_WEIGHTS) {
    if (re.test(d)) w = Math.max(w, weight);
  }
  if (w === 1) w = f.mobile ? 4 : 3; // 未识别家族：给中性偏移权重
  return w;
}

function weightedPick(arr) {
  if (!arr.length) return undefined;
  const weights = arr.map((f) => deviceWeight(f));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < arr.length; i++) {
    r -= weights[i];
    if (r <= 0) return arr[i];
  }
  return arr[arr.length - 1];
}
const LANGS = [
  'zh-CN,zh;q=0.9', 'zh-CN,zh;q=0.9,en;q=0.8', 'zh-CN,zh;q=0.9,en-US;q=0.8',
  'zh-TW,zh;q=0.9', 'en-US,en;q=0.9',
];
export function randomAcceptLanguage() {
  return pick(LANGS);
}

export function randomViewport() {
  return (weightedPick(allPool()) || pick(allPool())).viewport;
}

// 从固定池抽一套完整设备档案（UA/平台/视口/Client Hints 严格同源），伪造 IP 现场生成。
// 按当前端型模式（mixed/desktop/mobile）在对应子池内抽取；统计加权（P1-6）：
// 抽中频率与真实流量分布对齐（移动端/Chrome 系/国产浏览器高频），而非 30 套均匀随机。
export function randomFingerprint(mode = _fpMode) {
  const f = weightedPick(poolFor(mode)) || pick(poolFor(mode));
  const acceptLanguage = pick(f.langs);
  return {
    userAgent: f.ua,
    device: f.device,
    platform: f.platform,
    mobile: f.mobile,
    secChUa: f.brand || undefined, // Safari/Firefox 不发 Client Hints，undefined = 不附带
    ip: randomIP(),
    acceptLanguage,
    locale: acceptLanguage.split(',')[0],
    viewport: f.viewport,
  };
}

// 是否启用随机化（可用 RANDOMIZE_FINGERPRINT=false 关闭，回到固定 UA + 不伪造 IP）
export function fingerprintEnabled() {
  return process.env.RANDOMIZE_FINGERPRINT !== 'false';
}

// ---------- 随机 Cookie（与指纹配套，模拟「不同访客」的本地痕迹） ----------
const hex = (n) => [...Array(n)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

export function randomCookies() {
  const now = Date.now();
  return [
    { name: 'uuid', value: `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}` },
    { name: 't', value: String(now - rint(60000, 86400000)) },
    { name: 'cna', value: hex(16) },
    { name: 'trackId', value: hex(12) },
    { name: 'v', value: String(rint(1, 9)) },
  ];
}

// ---------- 请求档案池：已升级为会话池（session-pool.ts） ----------
// 旧「每次运行抽 N 组档案、逐请求随机」模型升级为「虚拟用户」模型：
// Cookie + 代理 + 指纹三元绑定成一个会话整体轮换（Crawlee SessionPool 范式），
// 登录态通道按平台粘性固定会话。档案生成入口见 session-pool.ts 的
// renewSessionPool / refreshProfilePool / acquireSession（避免静态循环依赖，此处不再转发）。
