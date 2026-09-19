/* 本地测试用：与 cf/src/worker.js 语义保持一致的房间服务（仅测试，不部署）
   ⚠️ 改 worker.js 的协议/语义时必须同步这里，否则 e2e 测的不是线上行为。
   用途：headless 沙箱里浏览器无法与 wrangler dev 的 WS 在虚拟时钟下握手，
   用纯 Node ws 替代，从而完整验证【游戏侧 WS 传输层】。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('C:/Users/24431/.workbuddy/binaries/node/workspace/node_modules/ws');

const ROOT = 'C:/Users/24431/Desktop/博饼/cf/public';
const RoomDO = { IDLE_PROXY_MS: Number(process.env.IDLE_PROXY_MS) || 15000 };   /* 与 Worker 对齐（测试可覆盖） */
const rooms = new Map();   /* code -> rec */

/* 与 Worker 的 alarm() 对齐：全员托管超时 → 解散房间（全员离线时没人发消息，只能定时检查）。
   ⚠️ 定时器绝不能挂在 rec 上：rec 要 JSON.stringify 广播出去，Timeout 对象会循环引用直接崩 */
const goneTimers = new Map();
/* 与 Worker 的 goneAt 对齐：**第一次被代博的时刻**起算 2 分钟 */
function goneAtOf(rec, i) {
  const a = rec.auto && rec.auto[i];
  return (a && a.at) || 0;
}
function armAllGoneCheck(rec, delayMs) {
  const key = rec.code;
  if (goneTimers.has(key)) clearTimeout(goneTimers.get(key));
  goneTimers.set(key, setTimeout(function () {
    goneTimers.delete(key);
    if (!rec || rec.closed) return;
    const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 120000;
    if (!rec.roster.length) { rooms.delete(rec.code); return; }
    let allGone = true;
    for (let i = 0; i < rec.roster.length; i++) {
      const t0 = goneAtOf(rec, i);
      if (!t0 || Date.now() - t0 < OFFLINE_MS) { allGone = false; break; }
    }
    if (allGone) { rec.closed = true; broadcast(rec.code); return; }
    armAllGoneCheck(rec, OFFLINE_MS);   /* 还没全踢 → 再等一轮 */
  }, delayMs || ((Number(process.env.OFFLINE_MS) || 120000) + 2000)));
}

function marks(rec) {
  const live = new Set();
  wss.clients.forEach(c => { if (c.roomCode === rec.code && c.readyState === 1 && c.pid) live.add(c.pid); });
  rec.off = rec.roster.map(p => !live.has(p.id));
  if (rec.cancelled) for (let i = 0; i < rec.off.length; i++)
    if (rec.off[i]) delete rec.cancelled[i];   /* 与 Worker 同步：又掉线 → 重新自动托管 */
  return rec;
}
function broadcast(code) {
  const rec = rooms.get(code);
  if (!rec) return;
  marks(rec);
  const msg = JSON.stringify({ t: 'room', r: rec });
  wss.clients.forEach(c => { if (c.roomCode === code && c.readyState === 1) { try { c.send(msg); } catch (e) {} } });
}
function dropPlayer(ws, explicit, done) {
  const rec = rooms.get(ws.roomCode);
  if (!rec) return;
  if (explicit) {   /* 主动退出：记录"谁走了"，客户端据此提示（与 Worker 版一致） */
    const who = rec.roster.find(p => p.id === ws.pid);
    rec.leftSeq = (rec.leftSeq || 0) + 1;
    rec.left = { seq: rec.leftSeq, name: who ? who.name : '有人', done: !!done };
  }
  const leaveRoster = !rec.started || done;   /* 未开局 / 本局已打完 → 只把自己摘掉 */
  if (leaveRoster) {
    const before = rec.roster.length;
    rec.roster = rec.roster.filter(p => p.id !== ws.pid);
    if (rec.roster.length !== before) {
      if (rec.roster.length === 0) { rooms.delete(rec.code); return; }   /* 空房间删除，不留垃圾 */
      if (!rec.roster.some(p => p.id === rec.host)) rec.host = rec.roster[0].id;   /* 房主顺位 */
      broadcast(rec.code);
    }
  } else if (explicit) {
    rec.closed = true;                       /* 打到一半主动退出 → 任何玩家退出都解散 */
    broadcast(rec.code);
  } else {
    broadcast(rec.code);                     /* 掉线只更新在线状态 */
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws') {
    const rec = rooms.get(url.searchParams.get('code'));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(rec
      ? { exists: true, started: !!rec.started, closed: !!rec.closed, count: rec.roster.length,
          roster: rec.roster.map(p => ({ id: p.id, name: p.name })), off: rec.off || [],
          auto: rec.auto || {}, cancelled: rec.cancelled || {}, lastAct: rec.lastAct || {},
          offlineMs: Number(process.env.OFFLINE_MS) || 120000 }
      : { exists: false }));
    return;
  }
  if (url.pathname === '/__state') {         /* 测试钩子：直接看某房间记录 */
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rooms.get(url.searchParams.get('code')) || { exists: false }));
    return;
  }
  if (url.pathname === '/__kick') {          /* 测试钩子：强制掐断（模拟掉线，不发 bye）
                                                  带 &pid= 只掐指定玩家（测"某一人掉线"） */
    const c = url.searchParams.get('code');
    const only = url.searchParams.get('pid');
    let n = 0;
    wss.clients.forEach(cl => {
      if (cl.roomCode === c && (!only || cl.pid === only)) { try { cl.terminate(); n++; } catch (e) {} }
    });
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('kicked ' + n);
    return;
  }
  let p = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(p)) p = path.join(ROOT, '..', 'dev', url.pathname.split('/').pop());   /* 测试页放 dev/ */
  fs.readFile(p, (e, d) => {
    if (e) { res.writeHead(404); res.end('no'); return; }
    res.writeHead(200, { 'Content-Type': p.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript' });
    res.end(d);
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  const code = (url.searchParams.get('code') || '').trim();
  const op = url.searchParams.get('op') || 'join';
  const name = (url.searchParams.get('name') || '玩家').slice(0, 8);
  const pid = (url.searchParams.get('pid') || '').slice(0, 40);
  const deny = (msg, status) => {
    socket.write('HTTP/1.1 ' + status + ' ' + msg + '\r\nConnection: close\r\n\r\n');
    socket.destroy();
  };
  if (!/^\d{4}$/.test(code)) return deny('Bad code', 400);
  if (!pid) return deny('No pid', 400);

  let rec = rooms.get(code);
  if (op === 'create') {
    const mine = rec && rec.roster.some(p => p.id === pid);
    if (rec && !rec.closed && !mine) return deny('Room taken', 409);
    if (!rec || rec.closed) {
      rec = { code, host: pid, started: false, closed: false, roster: [{ id: pid, name }], events: [] };
      rooms.set(code, rec);
    }
  } else {
    if (!rec || rec.closed) return deny('No room', 404);
    /* 与 Worker 同步：开始代博起 2 分钟没回来 = 彻底断线，不再放行重连/认领 */
    const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 120000;
    const kicked = (i) => { const t0 = goneAtOf(rec, i); return !!t0 && Date.now() - t0 >= OFFLINE_MS; };  /* 首次代博起算 */
    const mineIdx = rec.roster.findIndex(p => p.id === pid);
    if (mineIdx >= 0 && kicked(mineIdx))
      return deny('Kicked', 403);
    const mine = mineIdx >= 0;
    if (!mine && rec.started) {
      /* 与 Worker 同步：页面被杀后 PEER 丢 → 按名字认领离线座次（在线同名/不同名/已彻底断线拒绝） */
      marks(rec);
      const idx = rec.roster.findIndex((p, i) => p.name === name && rec.off && rec.off[i] && !kicked(i));
      if (idx < 0) return deny('Started', 403);
      rec.roster[idx].id = pid;
      if (rec.auto) delete rec.auto[idx];
    } else if (!mine) {
      rec.roster.push({ id: pid, name });
    }
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.roomCode = code; ws.pid = pid;
    marks(rec);
    {   /* 回线 = 恢复正常：清掉该座次的代博计时（与 Worker 同步） */
      const backIdx = rec.roster.findIndex(p => p.id === pid);
      if (backIdx >= 0 && rec.auto) delete rec.auto[backIdx];
    }
    ws.send(JSON.stringify({ t: 'room', r: rec }));
    broadcast(code);
    ws.on('message', data => {
      let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
      const r = rooms.get(code);
      if (!r || r.closed) return;
      if (m.t === 'roll') {
        if (!r.started) return;
        const seat = m.s | 0;
        if (seat < 0 || seat >= r.roster.length) return;
        if (!Array.isArray(m.d) || m.d.length !== 6 || m.d.some(v => !(v >= 1 && v <= 6))) return;
        if (pid) {
          const ss = r.roster.findIndex(p => p.id === pid);
          if (ss !== seat) {
            const offOK = r.off && r.off[seat];
            const la = r.lastAct ? r.lastAct[seat] : undefined;
            const idleOK = la !== undefined && Date.now() - la >= RoomDO.IDLE_PROXY_MS;   /* 15 秒无操作 */
            if (!offOK && !idleOK) return;   /* 防冒名：只能替自己掷，或替掉线/挂机座次代博 */
          }
        }
        if (r.events.length >= 5000) return;
        const lastEv = r.events[r.events.length - 1];
        /* 与 Worker 同步：只拦同类型的连续掷骰（取消后重新代博要放行） */
        if (lastEv && lastEv.s === seat && !lastEv.skip) return;
        {   /* 与 Worker 同步：代博状态机（满 5 只能跳） */
          r.auto = r.auto || {};
          const st = r.auto[seat];
          if (m.a) {
            if (!st) {
              r.auto[seat] = { cnt: 1, at: Date.now() };
              armAllGoneCheck(r);   /* 与 Worker 同步：兜底检查"全员被移出 → 解散" */
            }
            else if (st.cnt >= 5) return;
            else st.cnt++;
          }
        }
        r.events.push({ s: seat, d: m.d.slice(), a: m.a ? 1 : undefined });   /* a=1 代博（仅展示用） */
        r.lastAct = r.lastAct || {};
        if (!m.a) r.lastAct[seat] = Date.now();   /* 与 Worker 同步：代博不算玩家活动 */
        if (!m.a && r.cancelled) delete r.cancelled[seat];   /* 本人正常掷骰 = 取消托管自然完成 */
        broadcast(code);
      } else if (m.t === 'skip') {
        if (!r.started) return;
        marks(r);
        const seat = m.s | 0;
        if (seat < 0 || seat >= r.roster.length) return;
        {   /* 与 Worker 同步：off 或 15 秒无操作才可跳 */
          const la = r.lastAct ? r.lastAct[seat] : undefined;
          const idleOK = la !== undefined && Date.now() - la >= RoomDO.IDLE_PROXY_MS;
          const st5 = r.auto && r.auto[seat] && r.auto[seat].cnt >= 5;
          if (!r.off || (!r.off[seat] && !idleOK && !st5)) return;   /* 与 Worker 同步：满 5 把直接可跳 */
        }
        {   /* 与 Worker 同步：全场都进入跳过阶段（每座次满 5 把或已移出）→ 不写跳过事件
               （省额度、不刷提示），静默等 2 分钟解散。注意不是"都进入托管" */
          const OFFLINE_MS2 = Number(process.env.OFFLINE_MS) || 120000;
          let allSkipping = (r.roster.length > 0);
          for (let i = 0; i < r.roster.length; i++) {
            const a = r.auto && r.auto[i];
            const t0 = goneAtOf(r, i);
            const gone = t0 && (Date.now() - t0 >= OFFLINE_MS2);
            if (!((a && a.cnt >= 5) || gone)) { allSkipping = false; break; }
          }
          if (allSkipping) return;
        }
        const last = r.events[r.events.length - 1];
        if (last && last.skip && last.s === seat) return;   /* 幂等：同一座次只跳一次 */
        if (r.events.length >= 5000) return;
        r.events.push({ s: seat, skip: true });
        /* 与 Worker 同步：跳过不刷新 lastAct（是别人替他跳，不代表本人活动） */
        {   /* 与 Worker 同步：开始代博起超 2 分钟 = 彻底断线点名（kicked 标记，只发一次） */
          const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 120000;
          const goneT0m = goneAtOf(r, seat);
          if (goneT0m && Date.now() - goneT0m >= OFFLINE_MS) {
            /* 与 Worker 同步：只点名一次，之后每轮跳过静默 */
            r.kickNotified = r.kickNotified || {};
            if (!r.kickNotified[seat]) {
              r.kickNotified[seat] = true;
              r.leftSeq = (r.leftSeq || 0) + 1;
              r.left = { seq: r.leftSeq, name: r.roster[seat].name, kicked: true };
            }
          }
        }
        broadcast(code);
      } else if (m.t === 'cancel') {
        /* 与 Worker 同步：本人取消托管 → 删代博状态，15 秒内正常博，再发呆重新托管 */
        const seat = m.s | 0;
        if (pid && r.roster.findIndex(p => p.id === pid) !== seat) return;
        {   /* 与 Worker 同步：已彻底断线（从本人最后活动起算 2 分钟）→ 取消无效，已被真正移出 */
          const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 120000;
          const goneT0c = goneAtOf(r, seat);
          if (goneT0c && Date.now() - goneT0c >= OFFLINE_MS) return;
        }
        if (r.auto) delete r.auto[seat];
        r.cancelled = r.cancelled || {};
        r.cancelled[seat] = Date.now();
        r.lastAct = r.lastAct || {};
        r.lastAct[seat] = Date.now();
        broadcast(code);
      } else if (m.t === 'start') {
        if (pid !== r.host || r.roster.length < 2) return;
        r.started = true;
        r.lastAct = r.roster.map(() => Date.now());   /* 开局重置：15 秒判定从这里起算 */
        broadcast(code);
      } else if (m.t === 'reset') {
        if (pid !== r.host) return;
        r.gen = (r.gen || 0) + 1;   /* 世代号：客户端据此识别"新一局"（与 Worker 一致） */
        r.events = []; r.auto = {}; r.cancelled = {}; r.kickNotified = {}; r.lastAct = r.roster.map(() => Date.now());
        if (goneTimers.has(code)) { clearTimeout(goneTimers.get(code)); goneTimers.delete(code); }
        r.left = null; r.started = false; broadcast(code);
      } else if (m.t === 'bye') {
        dropPlayer(ws, true, !!m.done);
        try { ws.close(); } catch (e) {}
      }
    });
    ws.on('close', () => dropPlayer(ws, false));
  });
});

server.listen(8911, '127.0.0.1', () => console.log('mock room service on http://127.0.0.1:8911'));
setTimeout(() => process.exit(0), 1800000);
