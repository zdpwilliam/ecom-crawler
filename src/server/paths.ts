// 项目路径单一来源：所有运行时目录（data/ public/）统一从这里解析。
// 放在 src/server/ 下（距项目根两层），源码目录再怎么重构也不影响 data 目录落点。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录（package.json 所在层） */
export const PROJECT_ROOT = path.resolve(here, '..', '..');
/** 运行时数据目录（gitignore：数据库/Cookie/代理/导出等） */
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
/** 平台登录 Cookie 目录 */
export const COOKIES_DIR = path.join(DATA_DIR, 'cookies');
/** 前端静态资源目录（index.html / styles.css / 构建产物 app.js） */
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
/** 导出文件目录 */
export const EXPORTS_DIR = path.join(DATA_DIR, 'exports');
