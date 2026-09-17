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
      r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: r.statusCode, json: null }); } });
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

  /* ===== 掉线跳过 ===== */
  send(host, { t: 'skip', s: 0 });
  await sleep(400);
  ok('跳过在线玩家被拒绝（防抢回合）', lastRoom(host).events.length === 2, 'events=' + lastRoom(host).events.length);
  re.ws.terminate();
  await waitFor(() => lastRoom(host).off[2] === true);
  send(host, { t: 'skip', s: 2 });
  ok('跳过掉线玩家：写入 skip 事件并广播给所有人',
    await waitFor(() => lastRoom(host).events.length === 3 && lastRoom(guest).events.length === 3 && lastRoom(host).events[2].skip === true),
    JSON.stringify(lastRoom(host).events[2]));

  /* ===== 再来一局（reset） ===== */
  send(guest, { t: 'reset' });
  await sleep(400);
  ok('非房主 reset 被拒绝', lastRoom(host).events.length === 3 && lastRoom(host).started === true);
  send(host, { t: 'reset' });
  ok('房主再来一局：清空事件回大厅，名单保留',
    await waitFor(() => lastRoom(host).events.length === 0 && lastRoom(host).started === false),
    'roster=' + lastRoom(host).roster.length + ' events=' + lastRoom(host).events.length + ' started=' + lastRoom(host).started);
  ok('再来一局后原班人马（3 人）', lastRoom(host).roster.length === 3, 'roster=' + lastRoom(host).roster.map(p => p.name).join(','));

  /* ===== 已开局后主动退出 = 解散 ===== */
  send(host, { t: 'start' });
  await waitFor(() => lastRoom(host).started === true);
  const late = await connect(code, 'join', '客人乙', 'pThird');
  send(late, { t: 'bye' });
  ok('开局后任何人主动退出 → 本局解散（避免全场干等）',
    await waitFor(() => lastRoom(host).closed === true), 'closed=' + lastRoom(host).closed);

  /* ===== 加入失败原因可诊断 ===== */
  const q1 = await httpGet('?code=' + code);
  ok('查询口：已解散房间返回 closed=true', q1.json && q1.json.exists === true && q1.json.closed === true, JSON.stringify(q1.json));
  const q2 = await httpGet('?code=0000');
  ok('查询口：不存在的房间返回 exists=false', q2.json && q2.json.exists === false, JSON.stringify(q2.json));
  let blocked = false;
  try { await connect(code, 'join', '陌生人', 'pStranger'); } catch (e) { blocked = true; }
  ok('已解散房间不可加入', blocked);

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
