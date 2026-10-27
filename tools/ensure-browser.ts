// 自动确保 Playwright 无头浏览器已安装。
// 作为 postinstall 与 server 启动前的自检调用：缺失则自动下载，存在则跳过。
// 这样换机器只需 `npm install && npm start`，无需手动装浏览器。
import fs from 'node:fs';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';

export async function ensureBrowser() {
  try {
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) {
      console.log(`[bootstrap] 浏览器已就绪: ${exe}`);
      return true;
    }
  } catch {
    /* fallthrough */
  }
  console.log('[bootstrap] 未检测到浏览器，开始自动下载 chromium（仅此一次）...');
  try {
    execFileSync(process.execPath, [require.resolve('playwright/cli.js'), 'install', 'chromium'], {
      stdio: 'inherit',
    });
    console.log('[bootstrap] 浏览器安装完成。');
    return true;
  } catch (e) {
    console.warn('[bootstrap] 浏览器自动安装失败，请手动执行：npx playwright install chromium');
    console.warn('  原因：', e.message);
    return false;
  }
}

// 直接运行时执行
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureBrowser().then((ok) => process.exit(ok ? 0 : 1));
}
