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
    /* 保活：客户端每 45 秒发 {"t":"ping"}，由运行时自动回 pong（**不唤醒 DO、不计请求**）。
       移动网络/运营商 NAT 会掐掉长时间空闲的连接，进大厅等人时最容易中招。 */
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch (e) { /* 运行时不支持就算了，不影响主流程 */ }
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
         以及健康检查。只吐**不敏感**的元信息，不回名单。
         ⚠️ 必须带 CORS 头：GitHub Pages（跨站）上才能读到正文，
         否则加入失败只会笼统地报"连不上房间服务"。 */
      const rec = await this.load();
      return Response.json(
        rec ? { exists: true, started: !!rec.started, closed: !!rec.closed, count: rec.roster.length }
            : { exists: false },
        { headers: { 'Access-Control-Allow-Origin': '*' } });
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
    /* 名单里已经没有的人不必再记着（否则反复进退房会把 dead 撑大） */
    if (this.dead && this.dead.size) {
      for (const pid of [...this.dead]) {
        if (!this.rec.roster.some(p => p.id === pid)) this.dead.delete(pid);
      }
    }
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
      /* 防冒名：只能替**自己**掷（客户端本来就只发自己的座次）。
         服务端不跑规则、判不了"轮到谁"，但"谁在替谁掷"是可以判的 —— 这道检查挡掉
         一半的伪造路径，也让出 bug 的客户端不至于污染整条事件序列。 */
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (this.rec.roster.findIndex(p => p.id === pid) !== seat) return;
      if (this.rec.events.length >= 5000) return;      /* 兜底：别让异常客户端把记录撑爆 */
      this.rec.events.push({ s: seat, d: m.d.slice() });
      await this.save();
      this.broadcast();
    } else if (m.t === 'skip') {
      /* 掉线跳过：只允许跳过**当前已掉线**的座次（防止有人跳过在线玩家抢回合）。
         服务端不跑规则，无法判"轮到谁"，所以由客户端带上座次、服务端只校验在线状态；
         事件本身对所有人可见，谁都能核对座次是否合法。
         ⚠️ 幂等：两个好心人同时点「跳过这一把」是完全正常的时序（一个座次只能跳一次）。
         没有这道去重，第二条重复事件会让所有人回放到"座次对不上"→ 整局被判失步。 */
      if (!this.rec.started) return;
      const seat = m.s | 0;
      this.markOffline();
      if (seat < 0 || seat >= this.rec.roster.length) return;
      if (!this.rec.off || !this.rec.off[seat]) return;      /* 该座次在线 → 拒绝 */
      const last = this.rec.events[this.rec.events.length - 1];
      if (last && last.skip && last.s === seat) return;      /* 已跳过 → 忽略重复请求 */
      if (this.rec.events.length >= 5000) return;            /* 兜底上限，同 roll */
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
      await this.dropPlayer(ws, true, !!m.done);   /* 主动退出（区别于掉线） */
    }
  }

  async webSocketError(ws) {
    /* 连接异常（非正常关闭）按"掉线"处理，别让房间误判成解散 */
    await this.load();
    if (this.rec && !this.rec.closed) await this.dropPlayer(ws, false);
    try { ws.close(); } catch (e) {}
  }

  /* 退场语义：
     · 未开局 → 从名单移除；名单空 → 删除整个房间记录（不留垃圾）
     · 已开局 + 主动退出（bye，本局还没打完）→ **任何玩家退出都解散本局**：
       否则轮到他时全场干等，比赛名存实亡（实测过的真实场景）
     · 已开局 + 主动退出（bye，本局**已打完**）→ 只把自己从名单摘掉，房间留给别人看结果 /
       点「再来一局」—— 打完一局就有人退，不该把还在看结算的人一起轰走
     · 已开局 + 掉线（socket 被动断开，没发 bye）→ 保留房间，广播 offline 标记，
       其他人可点「掉线跳过」继续；本人刷新/回线可自动重连 */
  async dropPlayer(ws, explicit, done) {
    if (!this.rec) return;
    const pid = (ws.deserializeAttachment() || {}).pid;
    this.dead = this.dead || new Set();
    if (pid) this.dead.add(pid);          /* 广播前先记账：见 markOffline 注释 */
    const leaveRoster = !this.rec.started || done;
    if (leaveRoster) {
      const before = this.rec.roster.length;
      this.rec.roster = this.rec.roster.filter(p => p.id !== pid);
      if (this.rec.roster.length !== before) {
        if (this.rec.roster.length === 0) {
          this.rec = null;
          await this.ctx.storage.delete('rec');
          return;
        }
        /* 房主走了 → 把房主顺位给剩下第一个，否则新房子主点「开始」会被服务端拒绝
           （客户端按 roster[0] 显示"开始游戏"按钮，两边必须一致） */
        if (!this.rec.roster.some(p => p.id === this.rec.host)) this.rec.host = this.rec.roster[0].id;
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
