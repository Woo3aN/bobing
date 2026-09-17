/**
 * 博饼联机房间服务 —— Cloudflare Worker + Durable Object
 * ---------------------------------------------------------------------------
 * 设计要点（与博饼现有"事件回放"架构严格对齐）：
 *   · 房间记录 shape 与 CloudBase 版完全一致：{code, host, started, closed, roster, events}
 *     → 游戏侧 onRoom(r) 回放逻辑零改动，传输层可插拔
 *   · 一个房间号 = 一个 Durable Object 实例（天然单点串行，不需要锁）
 *   · WebSocket 常驻推送（取代 1.2s 轮询）：谁进房、谁掷了什么骰子，立即广播
 *   · Hibernation API：空闲时 DO 不计时长（免费额度关键）
 *   · 服务器只做"房间记录 + 事件追加"，不跑规则（规则在客户端，跟 CloudBase 版一致）
 *
 * 路由：
 *   GET /ws?code=1234&op=create|join&name=X&pid=Y   （WebSocket 升级）
 *   GET /*                                          → 静态资源（游戏页面）
 *
 * 客户端消息：{t:'roll', s:座次, d:[6颗点数]} / {t:'start'} / {t:'bye'}
 * 服务器消息：{t:'room', r:房间记录}
 * 错误（HTTP 4xx 文本）：房间号被占用 / 没有这个房间号 / 这局已经开始了
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('code') || '').trim();
      if (!/^\d{4}$/.test(code)) return new Response('房间号必须是 4 位数字', { status: 400 });
      const id = env.ROOMS.idFromName(code);
      return env.ROOMS.get(id).fetch(request);
    }
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  }
};

export class RoomDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rec = null;
  }

  async load() {
    if (!this.rec) this.rec = (await this.ctx.storage.get('rec')) || null;
    return this.rec;
  }
  async save() { await this.ctx.storage.put('rec', this.rec); }

  /* ---------- WebSocket 接入 ---------- */
  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      /* 非 WS 请求：给一个轻量查询口 —— 客户端加入失败时用它区分原因，
         以及健康检查。只吐**不敏感**的元信息，不回名单。 */
      const rec = await this.load();
      return Response.json(rec
        ? { exists: true, started: !!rec.started, closed: !!rec.closed, count: rec.roster.length }
        : { exists: false });
    }
    const op = url.searchParams.get('op') || 'join';
    const code = url.searchParams.get('code') || '';
    const name = (url.searchParams.get('name') || '玩家').slice(0, 8);
    const pid = (url.searchParams.get('pid') || '').slice(0, 40);
    if (!pid) return new Response('缺少 pid', { status: 400 });

    const rec = await this.load();

    if (op === 'create') {
      const mine = rec && rec.roster.some(p => p.id === pid);
      if (rec && !rec.closed && !mine) return new Response('房间号被占用，换一个', { status: 409 });
      if (!rec || rec.closed) {
        this.rec = { code, host: pid, started: false, closed: false, roster: [{ id: pid, name }], events: [] };
        await this.save();
      }
      /* 房间还在且 pid 是房主 → 刷新重连：直接沿用 */
    } else {
      if (!rec || rec.closed) return new Response('没有这个房间号', { status: 404 });
      const mine = rec.roster.some(p => p.id === pid);
      if (rec.started && !mine) return new Response('这局已经开始了', { status: 403 });
      if (!mine) {
        this.rec.roster.push({ id: pid, name });
        await this.save();
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid });
    if (this.dead) this.dead.delete(pid);   /* 回线：从"刚关闭"名单里摘掉 */
    this.markOffline();
    server.send(JSON.stringify({ t: 'room', r: this.rec }));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  /* 每个座次是否在线（rec.off，广播时重算；只给 UI 用，不参与业务逻辑）。
     ⚠️ 在 webSocketClose 回调里，那条正在关闭的连接**可能仍在 getWebSockets() 里**，
     所以要额外减去 this.dead（本次刚判定关闭的 pid）。 */
  markOffline() {
    if (!this.rec) return;
    const live = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== undefined && ws.readyState !== 1) continue;
      const a = ws.deserializeAttachment() || {};
      if (a.pid) live.add(a.pid);
    }
    if (this.dead) for (const pid of this.dead) live.delete(pid);
    this.rec.off = this.rec.roster.map(p => !live.has(p.id));
  }

  broadcast() {
    if (!this.rec) return;
    this.markOffline();
    const msg = JSON.stringify({ t: 'room', r: this.rec });
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(msg); } catch (e) { /* 已断开 */ }
    }
  }

  /* ---------- 消息处理（Hibernation 回调） ---------- */
  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch (e) { return; }
    await this.load();
    if (!this.rec || this.rec.closed) return;

    if (m.t === 'roll') {
      if (!this.rec.started) return;
      const seat = m.s | 0;
      if (seat < 0 || seat >= this.rec.roster.length) return;
      if (!Array.isArray(m.d) || m.d.length !== 6 || m.d.some(v => !(v >= 1 && v <= 6))) return;
      this.rec.events.push({ s: seat, d: m.d.slice() });
      await this.save();
      this.broadcast();
    } else if (m.t === 'skip') {
      /* 掉线跳过：只允许跳过**当前已掉线**的座次（防止有人跳过在线玩家抢回合）。
         服务端不跑规则，无法判"轮到谁"，所以由客户端带上座次、服务端只校验在线状态；
         事件本身对所有人可见，谁都能核对座次是否合法。 */
      if (!this.rec.started) return;
      const seat = m.s | 0;
      this.markOffline();
      if (seat < 0 || seat >= this.rec.roster.length) return;
      if (!this.rec.off || !this.rec.off[seat]) return;      /* 该座次在线 → 拒绝 */
      this.rec.events.push({ s: seat, skip: true });
      await this.save();
      this.broadcast();
    } else if (m.t === 'start') {
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid !== this.rec.host) return;          /* 只有房主能开局 */
      if (this.rec.roster.length < 2) return;     /* 至少两人 */
      this.rec.started = true;
      await this.save();
      this.broadcast();
    } else if (m.t === 'reset') {
      /* 再来一局：房主清空事件回到大厅，原班人马直接开下一局（不用重建房间） */
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid !== this.rec.host) return;
      this.rec.events = [];
      this.rec.started = false;
      await this.save();
      this.broadcast();
    } else if (m.t === 'bye') {
      await this.dropPlayer(ws, true);      /* 主动退出（区别于掉线） */
    }
  }

  async webSocketClose(ws) {
    await this.load();
    if (this.rec && !this.rec.closed) await this.dropPlayer(ws);
    try { ws.close(); } catch (e) {}
  }

  /* 退场语义：
     · 未开局 → 从名单移除；名单空 → 删除整个房间记录（不留垃圾）
     · 已开局 + 主动退出（bye）→ **任何玩家退出都解散本局**：
       否则轮到他时全场干等，比赛名存实亡（实测过的真实场景）
     · 已开局 + 掉线（socket 被动断开，没发 bye）→ 保留房间，广播 offline 标记，
       其他人可点「掉线跳过」继续；本人刷新/回线可自动重连 */
  async dropPlayer(ws, explicit) {
    if (!this.rec) return;
    const pid = (ws.deserializeAttachment() || {}).pid;
    this.dead = this.dead || new Set();
    if (pid) this.dead.add(pid);          /* 广播前先记账：见 markOffline 注释 */
    if (!this.rec.started) {
      const before = this.rec.roster.length;
      this.rec.roster = this.rec.roster.filter(p => p.id !== pid);
      if (this.rec.roster.length !== before) {
        if (this.rec.roster.length === 0) {
          this.rec = null;
          await this.ctx.storage.delete('rec');
          return;
        }
        await this.save();
        this.broadcast();
      }
    } else if (explicit) {
      this.rec.closed = true;
      await this.save();
      this.broadcast();
    } else {
      this.broadcast();     /* 只更新在线状态 */
    }
  }

  async webSocketClose(ws) {
    await this.load();
    if (this.rec && !this.rec.closed) await this.dropPlayer(ws, false);
    try { ws.close(); } catch (e) {}
  }
}
