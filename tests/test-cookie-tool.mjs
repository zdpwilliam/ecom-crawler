// cookie-tool 登录自动关闭决策的回归测试（Round 41 bug：小红书游客态也种 web_session → 弹窗即误判关闭）
// 运行：node tools/test-cookie-tool.mjs
// 决策矩阵：cookie marker 命中 + 页面级二次确认（游客态 .login-btn 存在 → 不自动关）
import { shouldAutoClose, LOGIN_MARKERS, LOGIN_CONFIRM } from '../tools/cookie-tool.ts';

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

// 真实游客态 Cookie 快照（2026-10-27 有头 Chrome 8s 实测，页面自种 38 字符 web_session）
const GUEST_XHS = [
  { name: 'acw_tc', value: 'x'.repeat(62) },
  { name: 'a1', value: 'x'.repeat(52) },
  { name: 'webId', value: 'x'.repeat(32) },
  { name: 'web_session', value: 'x'.repeat(38) }, // 游客态也有！
];
const DOUYIN_NO_LOGIN = [
  { name: 'ttwid', value: 'x'.repeat(40) },
  { name: 'msToken', value: 'x'.repeat(100) },
];
const DOUYIN_LOGGED = [
  { name: 'sessionid', value: 'x'.repeat(32) },
];

// 1. 决策矩阵
check('cookie 未命中 → 永不自动关', shouldAutoClose(false, true) === false && shouldAutoClose(false, false) === false && shouldAutoClose(false, null) === false);
check('cookie 命中 + 页面确认登录 → 自动关', shouldAutoClose(true, true) === true);
check('cookie 命中 + 页面判定游客 → 不自动关（小红书弹窗即关 bug 的核心回归）', shouldAutoClose(true, false) === false);
check('cookie 命中 + 无页面确认项平台 → 保持旧行为（自动关）', shouldAutoClose(true, null) === true);

// 2. marker 必要条件行为（游客 web_session 仍须命中 marker——由页面确认层过滤，而非 marker 层）
check('小红书 marker：游客 web_session 38 字符命中（必要条件）', LOGIN_MARKERS.xiaohongshu(GUEST_XHS) === true);
check('抖音 marker：无 sessionid 不命中', LOGIN_MARKERS.douyin(DOUYIN_NO_LOGIN) === false);
check('抖音 marker：sessionid 命中', LOGIN_MARKERS.douyin(DOUYIN_LOGGED) === true);

// 3. 小红书必须有页面级二次确认（防误判复发的结构保证）
check('LOGIN_CONFIRM.xiaohongshu 已定义', typeof LOGIN_CONFIRM.xiaohongshu === 'function');

// 4. VIP marker（Round 43 bug：脏游客档案 VipUINFO=luc:b|suc:b 被旧判定误判已登录 → 弹窗 3 秒即自动关闭）
const VIP_GUEST_A = [{ name: 'VipUINFO', value: 'luc%3Aa%7Csuc%3Aa' }];
const VIP_GUEST_B = [{ name: 'VipUINFO', value: 'luc%3Ab%7Csuc%3Ab%7Cbct%3Ac_new%7Cul%3A3105' }]; // 脏档案实测值
const VIP_LOGGED = [{ name: 'VipUINFO', value: 'luc%3A2%7Csuc%3A1%7Cnick%3Atester' }];
const VIP_LOGGED_LONG = [{ name: 'VipUINFO', value: 'luc%3A9f8e7d%7Csuc%3A1%7Cul%3A5' }];
check('VIP marker：游客 a 变体不命中', LOGIN_MARKERS.vip(VIP_GUEST_A) === false);
check('VIP marker：游客 b 变体（脏档案实测值）不命中', LOGIN_MARKERS.vip(VIP_GUEST_B) === false);
check('VIP marker：无 VipUINFO 不命中', LOGIN_MARKERS.vip([{ name: 'mars_cid', value: 'x' }]) === false);
check('VIP marker：非游客形态命中（短值数字头）', LOGIN_MARKERS.vip(VIP_LOGGED) === true);
check('VIP marker：非游客形态命中（长 id 头）', LOGIN_MARKERS.vip(VIP_LOGGED_LONG) === true);
check('LOGIN_CONFIRM.vip 已定义（页面级二次确认）', typeof LOGIN_CONFIRM.vip === 'function');

const pass = results.filter((r) => r.ok).length;
console.log(`\n通过 ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
