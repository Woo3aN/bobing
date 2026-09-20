/* 房间服务协议测试（Node ws 客户端）
   用法：
     node test-room.js                                  # 本地 wrangler dev（默认 ws://127.0.0.1:8788/ws）
     WS_URL=wss://woo3an.top/ws node test-room.js        # 线上
   ⚠️ 断言一律用「等条件成立」（waitFor），不要睡固定时间 —— 真实网络多端广播需要更多毫秒，
      固定 sleep 会产生假失败（踩过）。 */
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:8788/ws';
const { WebSocket } = require('C:/Users/24431/.workbuddy/binaries/node/workspace/node_modules/ws');
const httpMod = WS_URL.indexOf('wss') === 0 ? require('https') : require('http');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  [' + detail + ']' : '')); }
  else { fail++; console.log('  ✗ ' + name + '  [' + detail + ']'); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const lim = ms || 8000, t0 = Date.now();
  while (Date.now() - t0 < lim) { if (fn()) return true; await sleep(150); }
  return fn();
}
/* 非 WS 查询口（加入失败诊断 / 房间状态） */
function httpGet(pathname) {
  return new Promise((resolve, reject) => {
    const base = WS_URL.replace(/^ws/, 'http');   /* 保留 /ws 路径，别丢 */
    const u = new URL(base + pathname);
    httpMod.get({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d), headers: r.headers }); } catch (e) { resolve({ status: r.statusCode, json: null, headers: r.headers }); } });
    }).on('error', reject);
  });
}

function connect(code, op, name, pid) {
  return new Promise((resolve, reject) => {
    const url = WS_URL + '?code=' + code + '&op=' + op + '&name=' + encodeURIComponent(name) + '&pid=' + pid;
    const ws = new WebSocket(url);
    const msgs = [];
    let settled = false;
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('连接超时')); } }, 10000);
    ws.on('message', d => {
      const m = JSON.parse(d.toString());
      msgs.push(m);
      if (m.t === 'room' && !settled) { settled = true; clearTimeout(to); resolve({ ws, msgs }); }
    });
    ws.on('error', e => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('连接错误: ' + e.message)); } });
    ws.on('unexpected-response', (req, res) => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('HTTP ' + res.statusCode)); } });
    ws.on('close', () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('连接被关闭（可能 HTTP 4xx）')); } });
  });
}
const lastRoom = c => { for (let i = c.msgs.length - 1; i >= 0; i--) if (c.msgs[i].t === 'room') return c.msgs[i].r; return null; };
const send = (c, o) => c.ws.send(JSON.stringify(o));

(async () => {
  const code = String(1000 + Math.floor(Math.random() * 9000));
  console.log('房间号 ' + code + ' @ ' + WS_URL + '\n');

  /* ===== 基础流程 ===== */
  const host = await connect(code, 'create', '房主', 'pHost');
  ok('建房：收到首帧房间记录', !!lastRoom(host) && lastRoom(host).code === code,
    'roster=' + lastRoom(host).roster.map(x => x.name).join(','));
  ok('建房：房主标记正确', lastRoom(host).host === 'pHost');
  ok('建房：初始未开局', lastRoom(host).started === false);
  ok('建房：在线标记 off 全 false（自己在线）', lastRoom(host).off && lastRoom(host).off[0] === false,
    JSON.stringify(lastRoom(host).off));

  const guest = await connect(code, 'join', '客人甲', 'pGuest');
  ok('加入：客人拿到房间记录', lastRoom(guest).roster.length === 2,
    'roster=' + lastRoom(guest).roster.map(x => x.name).join(','));
  ok('加入：房主收到名单广播（推送，无轮询）', await waitFor(() => lastRoom(host).roster.length === 2));

  const third = await connect(code, 'join', '客人乙', 'pThird');
  ok('第三人加入：三人名单同步给所有人',
    await waitFor(() => lastRoom(host).roster.length === 3 && lastRoom(guest).roster.length === 3),
    'host=' + lastRoom(host).roster.length + ' guest=' + lastRoom(guest).roster.length);

  send(guest, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6] });
  await sleep(300);
  ok('未开局时掷骰被忽略', lastRoom(host).events.length === 0);

  send(guest, { t: 'start' });
  await sleep(300);
  ok('非房主开局被拒绝', lastRoom(host).started === false);

  send(host, { t: 'start' });
  ok('房主开局：三方都收到 started=true',
    await waitFor(() => lastRoom(host).started && lastRoom(guest).started && lastRoom(third).started),
    'host=' + lastRoom(host).started + ' guest=' + lastRoom(guest).started + ' third=' + lastRoom(third).started);

  send(guest, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6] });
  await sleep(250);
  send(host, { t: 'roll', s: 0, d: [6, 5, 4, 3, 2, 1] });
  ok('掷骰事件推送给所有人（含发送者自己）',
    await waitFor(() => lastRoom(host).events.length === 2 && lastRoom(guest).events.length === 2 && lastRoom(third).events.length === 2),
    'host=' + lastRoom(host).events.length + ' guest=' + lastRoom(guest).events.length + ' third=' + lastRoom(third).events.length);
  ok('事件内容与顺序正确（座次+点数）',
    lastRoom(host).events[0].s === 1 && lastRoom(host).events[0].d[0] === 1 &&
    lastRoom(host).events[1].s === 0 && lastRoom(host).events[1].d[0] === 6);

  /* 防冒名：客人（seat 1）替房主（seat 0）掷 —— 必须被拒（否则任何人都能污染事件序列） */
  const rcBefore = lastRoom(host).events.length;
  send(guest, { t: 'roll', s: 0, d: [2, 2, 2, 2, 2, 2] });
  await sleep(600);
  ok('防冒名：替别人的座次掷骰被拒绝', lastRoom(host).events.length === rcBefore,
    'events=' + lastRoom(host).events.length);

  send(host, { t: 'roll', s: 0, d: [7, 7, 7, 7, 7, 7] });
  send(host, { t: 'roll', s: 9, d: [1, 2, 3, 4, 5, 6] });
  send(host, { t: 'roll', s: 0, d: [1, 2, 3] });
  await sleep(400);
  ok('非法点数/座次/长度被服务端丢弃', lastRoom(host).events.length === 2, 'events=' + lastRoom(host).events.length);

  /* ===== 断线 / 重连（不掉房） ===== */
  third.ws.terminate();
  ok('掉线：房间不散，该座次标记为离线',
    await waitFor(() => lastRoom(host).off && lastRoom(host).off[2] === true && !lastRoom(host).closed),
    'off=' + JSON.stringify(lastRoom(host).off) + ' closed=' + lastRoom(host).closed);
  const re = await connect(code, 'join', '客人乙', 'pThird');
  ok('掉线重连：能重新加入且拿到完整快照', lastRoom(re).events.length === 2 && lastRoom(re).started === true);
  ok('回线：离线标记自动清除', await waitFor(() => lastRoom(host).off[2] === false), 'off=' + JSON.stringify(lastRoom(host).off));

  /* ===== 身份丢失按名字认领（iOS/安卓杀页面后 sessionStorage 连 PEER 一起丢，2026-09-18） ===== */
  re.ws.terminate();
  await waitFor(() => lastRoom(host).off[2] === true);
  let claimErr = null, claimed = null;
  try { claimed = await connect(code, 'join', '客人乙', 'pClaim'); } catch (e) { claimErr = e.message; }
  ok('认领：同名 + 原座次离线 → 新 pid 被接受（不再 403）', !!claimed, claimErr || '');
  ok('认领：座次不变（顶替 pid，名单不增长）',
    !!claimed && lastRoom(claimed).roster.length === 3 && lastRoom(claimed).roster[2].id === 'pClaim',
    JSON.stringify(claimed && lastRoom(claimed).roster.map(p => p.id)));
  ok('认领：离线标记自动清除', await waitFor(() => lastRoom(host).off[2] === false),
    'off=' + JSON.stringify(lastRoom(host).off));
  let denyErr = null;
  try { await connect(code, 'join', '路人丙', 'pStranger'); } catch (e) { denyErr = e.message; }
  ok('防冒名：不同名的陌生人仍被拒（403）', /403/.test(denyErr || ''), denyErr || '');
  let denyErr2 = null;
  try { await connect(code, 'join', '客人乙', 'pCopycat'); } catch (e) { denyErr2 = e.message; }
  ok('防冒名：同名但座次在线 → 拒绝（不顶掉正在玩的人）', /403/.test(denyErr2 || ''), denyErr2 || '');

  /* ===== 代博 / 自动跳过 / 彻底断线（2026-09-18：15 秒判定 → 代博 5 把 → 2 分钟没回移出） =====
     mock 用 OFFLINE_MS=2000 启动（真实部署是 120000），2.5 秒即触发"彻底断线"。 */
  send(host, { t: 'skip', s: 0 });
  await sleep(400);
  ok('跳过在线玩家被拒绝（防抢回合）', lastRoom(host).events.length === 2, 'events=' + lastRoom(host).events.length);
  claimed.ws.terminate();
  await waitFor(() => lastRoom(host).off[2] === true);
  /* 客户端全自动代博：轮到掉线座次 → 任一在线端发 a 标记的 roll（真实骰子）。
     真实轮次：代博乙(s2) → 房主(s0) → 客人(s1) → 又轮到乙 → 代博……事件不连续同座次。 */
  send(guest, { t: 'roll', s: 2, d: [1, 2, 3, 4, 5, 6], a: 1 });
  if (!await waitFor(() => lastRoom(guest).events.length === 3, 5000)) {
    /* 线上偶发（首字节/广播延迟）：重发一次。服务端幂等会拦真正的重复，安全。
       之前这里直接往下走 → events[2] undefined → 整个测试脚本崩（2026-09-20 定位）。 */
    send(guest, { t: 'roll', s: 2, d: [1, 2, 3, 4, 5, 6], a: 1 });
    await waitFor(() => lastRoom(guest).events.length === 3, 6000);
  }
  send(host, { t: 'roll', s: 0, d: [2, 3, 4, 5, 6, 6] });
  await waitFor(() => lastRoom(guest).events.length === 4);
  send(guest, { t: 'roll', s: 1, d: [3, 4, 5, 6, 6, 6] });
  await waitFor(() => lastRoom(guest).events.length === 5);
  {
    const ev3 = lastRoom(host).events;
    ok('代博：替掉线座次掷骰被接受（a 标记）',
      ev3.length >= 4 && !!ev3[2] && ev3[2].a === 1 && ev3[3] && ev3[3].a === undefined,
      'events=' + ev3.length + ' e2=' + JSON.stringify(ev3[2]));
  }
  /* 并发去重：两个端同时触发代博 → 两条同座次事件紧挨着 → 只有第一条被接受 */
  send(guest, { t: 'roll', s: 2, d: [6, 6, 6, 6, 6, 6], a: 1 });
  send(host, { t: 'roll', s: 2, d: [5, 5, 5, 5, 5, 5], a: 1 });
  await waitFor(() => lastRoom(guest).events.length === 6);
  await sleep(500);
  ok('代博并发去重：同座次连续事件被幂等丢弃',
    lastRoom(host).events.length === 6,   /* 并发两条谁先到不确定（真实网络），只断言没有双收 */
    'events=' + lastRoom(host).events.length);
  /* 彻底断线（开始代博起 2 分钟没回来 → 跳过点名 kicked + 无法重连）。
     ⚠️ 这几条只在 mock（OFFLINE_MS=2000 启动）验证：线上是真实 120 秒，无法快速等待。 */
  const IS_MOCK = /127\.0\.0\.1|localhost/.test(WS_URL);
  if (IS_MOCK) await sleep(3000);   /* 确保 autoAt[2] 距今超过 mock 的 2 秒阈值 */
  send(host, { t: 'skip', s: 2 });
  await waitFor(() => lastRoom(guest).events.length === 7);
  if (IS_MOCK) {
    ok('彻底断线：超时后跳过并点名（left 带 kicked）',
      lastRoom(host).left && lastRoom(host).left.kicked === true && lastRoom(host).left.name === '客人乙',
      JSON.stringify(lastRoom(host).left));
    /* 被移出者的重连/认领行为在**独立房间**里验证（见下方 code7）——
       这里不测：本房间前面已经做过"认领 + 重连"，pid 与托管状态都被改过，会互相污染。 */

  /* ===== 满 5 把但 2 分钟内回来 → 重连成功（2026-09-19 用户核心关切）=====
     独立 2 人房间：10 条事件连发（s1 代博 / s0 正常交替）压进 mock 的 2 秒窗口内。 */
  const code2 = String(1000 + Math.floor(Math.random() * 9000));
  const h2 = await connect(code2, 'create', '房主', 'qH');
  const g2c = await connect(code2, 'join', '丙', 'qG');
  await sleep(300);
  send(h2, { t: 'start' });
  await sleep(400);
  g2c.ws.terminate();   /* 丙掉线 */
  await waitFor(() => lastRoom(h2).off[1] === true);
  for (let i = 0; i < 5; i++) {
    send(h2, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });
    send(h2, { t: 'roll', s: 0, d: [2, 3, 4, 5, 6, 6] });
  }
  await waitFor(() => lastRoom(h2).events.length === 10);
  ok('〔2 分钟内〕代博满 5 把（事件交替不触发幂等）', lastRoom(h2).events.length === 10, 'events=' + lastRoom(h2).events.length);
  let okErr = null, backIn = null;
  try { backIn = await connect(code2, 'join', '丙', 'qG'); } catch (e) { okErr = e.message; }
  ok('〔2 分钟内〕满 5 把但未超时 → 重连成功', !!backIn, okErr || '');
  await sleep(2500);
  let lateErr = null, lateSpec = null;
  try { lateSpec = await connect(code2, 'join', '丙', 'qG2'); } catch (e) { lateErr = e.message; }
  /* 本房间前面"满 5 未超时重连"已经把丙的 pid 换成了 qG2 且回线清过托管状态，
     所以这里不再断言被移出行为（改在独立房间 code7 里测，避免状态互相污染）。 */
  if (lateSpec) lateSpec.ws.terminate();
  /* ===== 假死场景（socket 在线、人不动）跳过不能被 lastAct 卡住 =====
     用户 2026-09-19 实测 bug：代博期间每次掷骰刷新了 lastAct → 满 5 把要跳过时
     服务端按"15 秒内动过"拒跳 → 永久卡在「已请求跳过」。修法：代博不刷 lastAct
     + 满 5 把直接可跳（cnt>=5）。这里用真实 15 秒等待复现"无操作"条件。 */
  const code3 = String(1000 + Math.floor(Math.random() * 9000));
  const h3 = await connect(code3, 'create', '房主', 'rH');
  const g3c = await connect(code3, 'join', '丁', 'rG');   /* 丁在线但一直不动 */
  await sleep(300);
  send(h3, { t: 'start' });
  await sleep(400);
  /* 丁的 lastAct 停在 start 时刻；等过 15 秒判定窗口 */
  await sleep(15500);
  for (let i = 0; i < 5; i++) {
    send(h3, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });
    send(h3, { t: 'roll', s: 0, d: [2, 3, 4, 5, 6, 6] });
  }
  await waitFor(() => lastRoom(h3).events.length === 10);
  ok('假死代博：座次在线也能替其代博 5 把',
    lastRoom(h3).events.length === 10 && lastRoom(h3).auto && lastRoom(h3).auto[1] && lastRoom(h3).auto[1].cnt === 5,
    'events=' + lastRoom(h3).events.length + ' auto=' + JSON.stringify(lastRoom(h3).auto));
  send(h3, { t: 'skip', s: 1 });
  const skipOK = await waitFor(() => lastRoom(h3).events.length === 11, 5000);
  ok('假死代博满 5 把后跳过被接受（不被 lastAct 卡死）', skipOK, 'events=' + lastRoom(h3).events.length);
  /* 已彻底断线（mock OFFLINE_MS=2000）→ 本人点「取消托管」也必须无效：
     否则"人还在页面但超时"的玩家一点取消就复活（2026-09-19 用户实测发现）。
     先等过 2 秒窗口（距首届代博起算），再试取消。 */
  await sleep(2500);
  send(g3c, { t: 'cancel', s: 1 });   /* 注意：g3c 的连接还活着（假死场景） */
  await sleep(500);
  ok('被移出后取消托管无效（auto 不删，人不能复活）',
    !!(lastRoom(h3).auto && lastRoom(h3).auto[1]), 'auto=' + JSON.stringify(lastRoom(h3).auto));
  g3c.ws.terminate();

  /* ===== 全员托管超时 → 房间直接解散（用户 2026-09-19 定）=====
     3 人局：乙丙掉线、甲替他们代博；甲自己也被托管 → 全员 auto.at 过期 →
     alarm 兜底检查（mock OFFLINE_MS=2000 + 2s）→ closed=true。 */
  const code4 = String(1000 + Math.floor(Math.random() * 9000));
  const h4 = await connect(code4, 'create', '甲', 'sA');
  const g4b = await connect(code4, 'join', '乙', 'sB');
  const g4c = await connect(code4, 'join', '丙', 'sC');
  await sleep(300);
  send(h4, { t: 'start' });
  await sleep(400);
  g4b.ws.terminate(); g4c.ws.terminate();
  await waitFor(() => lastRoom(h4).off[1] === true && lastRoom(h4).off[2] === true);
  /* 三个座次各建立一次托管（交替座次避免幂等）：s1 代博乙 → s0 甲自己 → s2 代博丙 */
  send(h4, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });
  send(h4, { t: 'roll', s: 0, d: [2, 3, 4, 5, 6, 6], a: 1 });
  send(h4, { t: 'roll', s: 2, d: [3, 4, 5, 6, 6, 6], a: 1 });
  await waitFor(() => lastRoom(h4).events.length === 3);
  await sleep(1000);
  ok('全员托管已建立（三个座次 auto.at 齐全）',
    Object.keys(lastRoom(h4).auto || {}).length === 3, JSON.stringify(lastRoom(h4).auto));
  const gone = await waitFor(() => lastRoom(h4).closed === true, 12000);
  ok('全员超时未回 → 房间自动解散', gone, 'closed=' + lastRoom(h4).closed);

  /* ===== 真机 bug 回归（2026-09-19）：同座次「跳过 → 重新代博」不能被幂等拦掉 =====
     取消托管/跳过都不产生"新座次"的事件，于是重新代博时上一条事件仍是自己
     （s=1 的 skip）→ 旧判据"同座次连续即丢"会静默拦掉 → 真机上表现为
     "取消后发呆、按钮停在轮到你了、整局卡住"。 */
  const code5 = String(1000 + Math.floor(Math.random() * 9000));
  const h5 = await connect(code5, 'create', '甲', 'tA');
  const g5 = await connect(code5, 'join', '乙', 'tB');
  await sleep(300);
  send(h5, { t: 'start' });
  await sleep(400);
  g5.ws.terminate();
  await waitFor(() => lastRoom(h5).off[1] === true);
  send(h5, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });     /* 代博第一把 */
  await waitFor(() => lastRoom(h5).events.length === 1);
  send(h5, { t: 'skip', s: 1 });                                  /* 跳过他这一把（掉线可跳） */
  await waitFor(() => lastRoom(h5).events.length === 2);
  send(h5, { t: 'roll', s: 1, d: [6, 6, 6, 6, 6, 6], a: 1 });     /* 上一条是自己的 skip → 必须放行 */
  const back2 = await waitFor(() => lastRoom(h5).events.length === 3, 4000);
  ok('跳过后同座次重新代博不被幂等拦掉（旧判据会卡死整局）', back2, 'events=' + lastRoom(h5).events.length);

  /* ===== 全员都没有自由玩家（最后一人也掉线）→ 服务端把托管计数补到 5（跳过阶段）=====
     没人能发信号时局面不能"卡在代博中（1/5）"，应标记为停止推进，等 2 分钟解散。
     服务端不造事件（不知道轮次），只改状态。用查询口读结果（host 已断线收不到广播）。 */
  const code6 = String(1000 + Math.floor(Math.random() * 9000));
  const h6 = await connect(code6, 'create', '甲', 'uA');
  const g6b = await connect(code6, 'join', '乙', 'uB');
  const g6c = await connect(code6, 'join', '丙', 'uC');
  await sleep(300);
  send(h6, { t: 'start' });
  await sleep(400);
  g6b.ws.terminate(); g6c.ws.terminate();
  await waitFor(() => lastRoom(h6).off[1] === true && lastRoom(h6).off[2] === true);
  send(h6, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });   /* 三人各建立一次托管 */
  send(h6, { t: 'roll', s: 0, d: [2, 3, 4, 5, 6, 6], a: 1 });
  send(h6, { t: 'roll', s: 2, d: [3, 4, 5, 6, 6, 6], a: 1 });
  await waitFor(() => lastRoom(h6).events.length === 3);
  await sleep(600);
  h6.ws.terminate();                                            /* 最后一人也掉线 */
  await sleep(1200);
  const q6 = await fetch(WS_URL.replace(/^ws/, 'http') + '?code=' + code6).then(r => r.json()).catch(() => null);
  const cnts = q6 && q6.auto ? Object.keys(q6.auto).map(k => q6.auto[k].cnt) : [];
  ok('全员无自由玩家 → 托管计数补到 5（标记停止推进，不再卡在代博中）',
    cnts.length === 3 && cnts.every(c => c >= 5), JSON.stringify(q6 && q6.auto));

  /* ===== 观战模式（用户 2026-09-19 要求）：被移出者重连 → 放进来观战，只读 =====
     独立房间，避免与前面"认领/重连"用例的状态互相污染。 */
  const code7 = String(1000 + Math.floor(Math.random() * 9000));
  const h7 = await connect(code7, 'create', '甲', 'vA');
  const g7 = await connect(code7, 'join', '乙', 'vB');
  await sleep(300);
  send(h7, { t: 'start' });
  await sleep(400);
  g7.ws.terminate();
  await waitFor(() => lastRoom(h7).off[1] === true);
  send(h7, { t: 'roll', s: 1, d: [1, 2, 3, 4, 5, 6], a: 1 });     /* 首届代博 = 2 分钟倒计时起点 */
  await waitFor(() => lastRoom(h7).events.length === 1);
  await sleep(2500);                                              /* 过 mock 的 2 秒阈值 → 彻底断线 */
  /* ① 原 pid 重连 → 放行（观战），不再 403 */
  let spec7 = null, specErr7 = null;
  try { spec7 = await connect(code7, 'join', '乙', 'vB'); } catch (e) { specErr7 = e.message; }
  ok('被移出后原 pid 重连 → 放行观战（不再 403）', !specErr7 && !!lastRoom(spec7), specErr7 || 'connected');
  if (spec7) {
    /* ② 观战者写操作一律被丢弃 */
    const ev0 = lastRoom(spec7).events.length;
    send(spec7, { t: 'roll', s: 1, d: [6, 6, 6, 6, 6, 6] });
    send(spec7, { t: 'skip', s: 1 });
    send(spec7, { t: 'cancel', s: 1 });
    await sleep(600);
    ok('观战者只读：掷骰/跳过/取消都被丢弃（事件数不变）',
      lastRoom(spec7).events.length === ev0,
      'events=' + lastRoom(spec7).events.length + ' (expected ' + ev0 + ')');
    spec7.ws.terminate();
  }
  /* ③ 页面被杀后身份丢失（iOS 常态）→ 新 pid 用同名认领**已移出**的座次：
     必须放行（接管进来观战），否则用户被挡在门外（2026-09-20 用户真机反馈） */
  let claim7 = null, claimErr7 = null;
  try { claim7 = await connect(code7, 'join', '乙', 'vX'); } catch (e) { claimErr7 = e.message; }
  ok('同名认领已移出座次 → 放行观战（页面被杀后仍能回来看）',
    !claimErr7 && !!lastRoom(claim7), claimErr7 || 'connected');
  if (claim7) {
    const ev1 = lastRoom(claim7).events.length;
    send(claim7, { t: 'roll', s: 1, d: [6, 6, 6, 6, 6, 6] });
    await sleep(500);
    ok('（认领进来的）观战者同样只读', lastRoom(claim7).events.length === ev1,
      'events=' + lastRoom(claim7).events.length + ' (expected ' + ev1 + ')');
    claim7.ws.terminate();
  }
  /* ④ 不同名的新玩家仍被拒（房间已开局，防陌生人乱入） */
  let strangerErr7 = null;
  try { await connect(code7, 'join', '路人', 'vY'); } catch (e) { strangerErr7 = e.message; }
  ok('不同名的新面孔仍被拒（防陌生人乱入）', /403/.test(strangerErr7 || ''), strangerErr7 || '');
  } else {
    console.log('  - 跳过「彻底断线点名/移出重连」断言（线上 OFFLINE_MS=120s 无法快速验证，mock 已覆盖）');
  }
  /* ⚠️ 两个人同时点「跳过这一把」是完全正常的时序：重复事件会让所有人回放到"座次对不上"
     → 整局被判失步 → 一个人的手快把整局搞死。服务端必须幂等。 */
  send(guest, { t: 'skip', s: 2 });
  await sleep(600);
  ok('重复跳过同一座次被去重（幂等）', lastRoom(host).events.length === 7, 'events=' + lastRoom(host).events.length);

  /* ===== 再来一局（reset） ===== */
  send(guest, { t: 'reset' });
  await sleep(400);
  ok('非房主 reset 被拒绝', lastRoom(host).events.length === 7 && lastRoom(host).started === true);
  send(host, { t: 'reset' });
  ok('房主再来一局：清空事件回大厅，名单保留',
    await waitFor(() => lastRoom(host).events.length === 0 && lastRoom(host).started === false),
    'roster=' + lastRoom(host).roster.length + ' events=' + lastRoom(host).events.length + ' started=' + lastRoom(host).started);
  ok('再来一局后原班人马（3 人）', lastRoom(host).roster.length === 3, 'roster=' + lastRoom(host).roster.map(p => p.name).join(','));

  /* ===== 本局打完后退出：只摘掉自己，不连累还在看结算的人 ===== */
  send(guest, { t: 'bye', done: true });
  ok('打完后退出带 done：只把自己摘出名单，房间保留',
    await waitFor(() => lastRoom(host).roster.length === 2 && lastRoom(host).closed === false),
    'roster=' + lastRoom(host).roster.length + ' closed=' + lastRoom(host).closed);
  ok('退出要带上「谁走了」（否则其他人完全看不出人少了）',
    lastRoom(host).left && lastRoom(host).left.name === '客人甲' && lastRoom(host).left.done === true,
    JSON.stringify(lastRoom(host).left));

  /* ===== 已开局后主动退出 = 解散 =====
     （乙已被移出、甲已退名单；用房主 pid 再开一条连接模拟"在线成员重连后退出"） */
  send(host, { t: 'start' });
  await waitFor(() => lastRoom(host).started === true);
  const late = await connect(code, 'join', '房主', 'pHost');
  send(late, { t: 'bye' });
  ok('开局后任何人主动退出 → 本局解散（避免全场干等）',
    await waitFor(() => lastRoom(host).closed === true), 'closed=' + lastRoom(host).closed);
  ok('中途退出同样带「谁走了」（解散提示里要点名）',
    lastRoom(host).left && lastRoom(host).left.name === '房主' && lastRoom(host).left.done === false,
    JSON.stringify(lastRoom(host).left));

  /* ===== 加入失败原因可诊断 ===== */
  const q1 = await httpGet('?code=' + code);
  ok('查询口：已解散房间返回 closed=true', q1.json && q1.json.exists === true && q1.json.closed === true, JSON.stringify(q1.json));
  ok('查询口带 CORS 头（GitHub Pages 跨站才读得到失败原因）',
    q1.headers && q1.headers['access-control-allow-origin'] === '*',
    'acao=' + (q1.headers && q1.headers['access-control-allow-origin']));
  const q2 = await httpGet('?code=0000');
  ok('查询口：不存在的房间返回 exists=false', q2.json && q2.json.exists === false, JSON.stringify(q2.json));
  let blocked = false;
  try { await connect(code, 'join', '陌生人', 'pStranger'); } catch (e) { blocked = true; }
  ok('已解散房间不可加入', blocked);

  /* ===== 大厅里房主退出 → 房主顺位 ===== */
  const code3 = String(1000 + Math.floor(Math.random() * 9000));
  const h3 = await connect(code3, 'create', '房主丙', 'pHost3');
  const g3 = await connect(code3, 'join', '客人丙', 'pGuest3');
  await waitFor(() => lastRoom(g3).roster.length === 2);
  send(h3, { t: 'bye' });
  ok('大厅里房主退出：房间保留，房主顺位给剩下的人（否则剩下的人点「开始」会被服务端拒绝）',
    await waitFor(() => lastRoom(g3).roster.length === 1 && lastRoom(g3).host === 'pGuest3' && lastRoom(g3).closed === false),
    'roster=' + lastRoom(g3).roster.length + ' host=' + lastRoom(g3).host + ' closed=' + lastRoom(g3).closed);
  ok('大厅里退出也点名（房主退了大厅也要让剩下的人知道）',
    lastRoom(g3).left && lastRoom(g3).left.name === '房主丙', JSON.stringify(lastRoom(g3).left));
  const g4 = await connect(code3, 'join', '客人丁', 'pGuest4');
  await waitFor(() => lastRoom(g3).roster.length === 2);
  send(g3, { t: 'start' });
  ok('顺位后的新房主能正常开局', await waitFor(() => lastRoom(g3).started === true), 'started=' + lastRoom(g3).started);
  send(g3, { t: 'bye' });
  ok('顺位房主中途退出仍能解散本局', await waitFor(() => lastRoom(g4).closed === true), 'closed=' + lastRoom(g4).closed);

  /* ===== 房间隔离 ===== */
  const code2 = String(1000 + Math.floor(Math.random() * 9000));
  const host2 = await connect(code2, 'create', '别的房主', 'pHost2');
  ok('不同房间号互相隔离', lastRoom(host2).roster.length === 1 && lastRoom(host2).code === code2);

  /* ===== 空房间清理 ===== */
  const q3 = await httpGet('?code=' + code2);
  ok('未开局房间：查询口给 started=false/count=1', q3.json && q3.json.started === false && q3.json.count === 1, JSON.stringify(q3.json));
  send(host2, { t: 'bye' });
  await sleep(800);
  const q4 = await httpGet('?code=' + code2);
  ok('最后一人退出后房间记录被清理（不留垃圾）', q4.json && q4.json.exists === false, JSON.stringify(q4.json));

  console.log('\n=== ' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常: ' + e.message); process.exit(1); });
