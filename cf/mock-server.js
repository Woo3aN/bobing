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
    const mine = rec.roster.some(p => p.id === pid);
    if (rec.started && !mine) return deny('Started', 403);
    if (!mine) rec.roster.push({ id: pid, name });
  }

  wss.handleUpgrade(req, socket, head, ws => {
    ws.roomCode = code; ws.pid = pid;
    marks(rec);
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
        r.events.push({ s: seat, d: m.d.slice() });
        broadcast(code);
      } else if (m.t === 'skip') {
        if (!r.started) return;
        marks(r);
        const seat = m.s | 0;
        if (seat < 0 || seat >= r.roster.length) return;
        if (!r.off || !r.off[seat]) return;
        const last = r.events[r.events.length - 1];
        if (last && last.skip && last.s === seat) return;   /* 幂等：同一座次只跳一次 */
        r.events.push({ s: seat, skip: true });
        broadcast(code);
      } else if (m.t === 'start') {
        if (pid !== r.host || r.roster.length < 2) return;
        r.started = true; broadcast(code);
      } else if (m.t === 'reset') {
        if (pid !== r.host) return;
        r.events = []; r.started = false; broadcast(code);
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
