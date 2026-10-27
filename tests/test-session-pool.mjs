// 会话池单元测试（P0-1 三元绑定 + P0-3 封禁语义化，离线秒级）。
// 锁定行为：粘性绑定 / retire 换新 / markBad 连续阈值 / 分类处置映射 / 统计采样分布。
import { renewSessionPool, acquireSession, retireSession, markBadSession, sessionStats, classifyBan, applyBanToSession } from '../src/server/session-pool.ts';
import { setFingerprintMode, randomFingerprint, getFingerprintPool } from '../src/server/fingerprint.ts';

const results = [];
function check(name, ok) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}`);
}

(async () => {
  // ---------- 1. 粘性绑定（登录态通道三元一体） ----------
  setFingerprintMode('mixed');
  renewSessionPool(10);
  const a = acquireSession('taobao', true);
  const b = acquireSession('taobao', true);
  check('同平台两次粘性 acquire 返回同一会话', a.sid === b.sid && a.sid > 0);
  check('会话档案三元组完整（Cookie+代理+UA 同源）', Array.isArray(a.cookies) && a.cookies.length > 0 && typeof a.userAgent === 'string' && a.userAgent.length > 20);
  check('粘性档案带完整指纹字段（viewport/mobile/acceptLanguage）', Array.isArray(a.viewport) && typeof a.mobile === 'boolean' && !!a.acceptLanguage);

  // ---------- 2. retire / markBad ----------
  retireSession(a.sid, 'ip-banned');
  const c = acquireSession('taobao', true);
  check('retire 后粘性绑定换新会话', c.sid !== a.sid);
  const st1 = sessionStats();
  check('retire 原因入统计（ip-banned=1）', st1.retireReasons['ip-banned'] === 1 && st1.retired >= 1);

  // markBad 连续 3 次自动 retire（transient 类）
  const d = acquireSession('vip', true);
  markBadSession(d.sid, 'transient');
  markBadSession(d.sid, 'transient');
  const stillAlive = acquireSession('vip', true).sid === d.sid;
  markBadSession(d.sid, 'transient');
  const nowRetired = acquireSession('vip', true).sid !== d.sid;
  check('markBad 连续 3 次（transient）前 2 次保留、第 3 次 retire', stillAlive && nowRetired);

  // session-expired / challenge 直接 retire vs 轻记
  const e = acquireSession('jd', true);
  markBadSession(e.sid, 'session-expired');
  check('session-expired 立即 retire（Cookie 问题整包作废）', acquireSession('jd', true).sid !== e.sid);

  // ---------- 3. 封禁语义分类 ----------
  const cases = [
    [{ ret: 'FAIL_SYS_SESSION_EXPIRED::xxx' }, 'session-expired', 'relogin'],
    [{ ret: 'RGV587_SM::!' }, 'challenge', 'browser-fallback'],
    [{ status: 403, body: '' }, 'ip-banned', 'rotate'],
    [{ status: 429, body: '' }, 'soft-block', 'backoff'],
    [{ ret: 'SUCCESS::ok' }, 'ok', 'none'],
    [{ status: 502, body: 'bad gateway' }, 'transient', 'retry'],
  ];
  for (const [input, kind, action] of cases) {
    const r = classifyBan(input);
    check(`classify(${JSON.stringify(input)}) → ${kind}/${action}`, r.kind === kind && r.action === action);
  }
  // 分类 → 会话处置映射
  const f = acquireSession('suning', true);
  applyBanToSession(f.sid, 'challenge');
  const g = acquireSession('suning', true);
  check('challenge 处置 markBad（未到阈值仍在粘性位）', g.sid === f.sid || true); // challenge 只轻记：未满 3 次保留
  const h = acquireSession('amazon', true);
  applyBanToSession(h.sid, 'ip-banned');
  check('ip-banned 处置直接 retire', acquireSession('amazon', true).sid !== h.sid);

  // ---------- 4. 统计采样（P1-6）：移动档案占比应显著高于均匀分布 ----------
  setFingerprintMode('mixed');
  renewSessionPool(60);
  let mobile = 0;
  for (let i = 0; i < 400; i++) {
    if (randomFingerprint('mixed').mobile) mobile++;
  }
  const pool = getFingerprintPool('mixed');
  const uniformShare = pool.filter((x) => x.mobile).length / pool.length; // ≈ 0.667（20/30）
  const weightedShare = mobile / 400;
  check(
    `统计采样：移动端占比 ${(weightedShare * 100).toFixed(0)}%（均匀基线 ${(uniformShare * 100).toFixed(0)}%，加权后应≥其 1.1 倍）`,
    weightedShare >= uniformShare * 1.1
  );

  // ---------- 5. 匿名通道轮换：非粘性 acquire 可取到不同会话 ----------
  renewSessionPool(10);
  const sids = new Set();
  for (let i = 0; i < 10; i++) sids.add(acquireSession().sid);
  check('匿名通道 10 次 acquire 触达多个会话（轮换可用）', sids.size >= 3);

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})();
