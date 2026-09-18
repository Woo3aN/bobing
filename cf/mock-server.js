/* 本地测试用：与 cf/src/worker.js 语义保持一致的房间服务（仅测试，不部署）
   ⚠️ 改 worker.js 的协议/语义时必须同步这里，否则 e2e 测的不是线上行为。
   用途：headless 沙箱里浏览器无法与 wrangler dev 的 WS 在虚拟时钟下握手，
   用纯 Node ws 替代，从而完整验证【游戏侧 WS 传输层】。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('C:/Users/24431/.workbuddy/binaries/node/workspace/node_modules/ws');

const ROOT = 'C:/Users/24431/Desktop/博饼/cf/public';
const rooms = new Map();   /* code -> rec */

function marks(rec) {
  const live = new Set();
  wss.clients.forEach(c => { if (c.roomCode === rec.code && c.readyState === 1 && c.pid) live.add(c.pid); });
  rec.off = rec.roster.map(p => !live.has(p.id));
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
      ? { exists: true, started: !!rec.started, closed: !!rec.closed, count: rec.roster.length }
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
    const kicked = (i) => rec.autoAt && rec.autoAt[i] && Date.now() - rec.autoAt[i] >= OFFLINE_MS;
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
      if (rec.autoAt) delete rec.autoAt[idx];
    } else if (!mine) {
      rec.roster.push({ id: pid, name });
    }
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.roomCode = code; ws.pid = pid;
    marks(rec);
    {   /* 回线 = 恢复正常：清掉该座次的代博计时（与 Worker 同步） */
      const backIdx = rec.roster.findIndex(p => p.id === pid);
      if (backIdx >= 0 && rec.autoAt) delete rec.autoAt[backIdx];
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
          if (ss !== seat && !(r.off && r.off[seat])) return;   /* 防冒名：只能替自己掷，或替掉线座次代博 */
        }
        if (r.events.length >= 5000) return;
        const lastEv = r.events[r.events.length - 1];
        if (lastEv && lastEv.s === seat) return;   /* 与 Worker 同步：同座次连续事件幂等（多端并发代博去重） */
        {   /* 与 Worker 同步：代博把数上限（满 5 只能跳） */
          let autoCnt = 0;
          for (const e of r.events) if (e.s === seat && e.a) autoCnt++;
          if (m.a && autoCnt >= 5) return;
        }
        if (m.a) {   /* 与 Worker 同步：首次代博时刻 = 2 分钟"彻底断线"判定起点 */
          r.autoAt = r.autoAt || {};
          if (!r.autoAt[seat]) r.autoAt[seat] = Date.now();
        }
        r.events.push({ s: seat, d: m.d.slice(), a: m.a ? 1 : undefined });   /* a=1 代博（仅展示用） */
        broadcast(code);
      } else if (m.t === 'skip') {
        if (!r.started) return;
        marks(r);
        const seat = m.s | 0;
        if (seat < 0 || seat >= r.roster.length) return;
        if (!r.off || !r.off[seat]) return;   /* 与 Worker 同步：off 即可跳（自动化节奏由客户端管） */
        const last = r.events[r.events.length - 1];
        if (last && last.skip && last.s === seat) return;   /* 幂等：同一座次只跳一次 */
        if (r.events.length >= 5000) return;
        r.events.push({ s: seat, skip: true });
        {   /* 与 Worker 同步：开始代博起超 2 分钟 = 彻底断线点名（kicked 标记，只发一次） */
          const OFFLINE_MS = Number(process.env.OFFLINE_MS) || 120000;
          if (r.autoAt && r.autoAt[seat] && Date.now() - r.autoAt[seat] >= OFFLINE_MS) {
            r.leftSeq = (r.leftSeq || 0) + 1;
            r.left = { seq: r.leftSeq, name: r.roster[seat].name, kicked: true };
            /* ⚠️ autoAt 不删：它持续作为"拒绝重连"的依据，直到本人回线（accept 时清）或 reset */
          }
        }
        broadcast(code);
      } else if (m.t === 'start') {
        if (pid !== r.host || r.roster.length < 2) return;
        r.started = true; broadcast(code);
      } else if (m.t === 'reset') {
        if (pid !== r.host) return;
        r.gen = (r.gen || 0) + 1;   /* 世代号：客户端据此识别"新一局"（与 Worker 一致） */
        r.events = []; r.autoAt = {}; r.left = null; r.started = false; broadcast(code);
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
