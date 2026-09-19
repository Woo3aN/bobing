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
 * 常量：IDLE_PROXY_MS = 15 秒无操作判定（与客户端 IDLE_MS 对齐；切后台的人 socket 常挂着，
 *       off=false 但人不在 —— 其他玩家可替 15 秒没动的座次代博/跳过，2026-09-19 用户实测定）
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
    if (env.ASSETS) {
      /* 游戏挂在 /bobing，根路径留给将来的主页（2026-09-17 用户定） */
      if (url.pathname === '/' ) return Response.redirect(url.origin + '/bobing', 302);
      const isHtml = url.pathname === '/bobing' || url.pathname === '/bobing/' ||
        url.pathname === '/index.html' || url.pathname.endsWith('.html');
      const resp = await env.ASSETS.fetch(
        url.pathname === '/bobing' || url.pathname === '/bobing/'
          ? new Request(new URL('/index.html', url)) : request);
      if (isHtml && resp.status === 200) {
        /* ⚠️ 必须 no-store：WebView（微信 X5 等）会顽固缓存旧版 HTML，
           用户实测到旧功能还以为代码没生效（2026-09-19）。只对 HTML 禁缓存，静态图片等照旧。 */
        const h = new Headers(resp.headers);
        h.set('Cache-Control', 'no-store, must-revalidate');
        return new Response(resp.body, { status: resp.status, headers: h });
      }
      return resp;
    }
    return new Response('not found', { status: 404 });
  }
};

export class RoomDO {
  static IDLE_PROXY_MS = 15000;   /* 15 秒无操作 = 其他人可替该座次代博/跳过（与客户端 IDLE_MS 对齐） */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rec = null;    /* 保活：客户端每 45 秒发 {"t":"ping"}，由运行时自动回 pong（**不唤醒 DO、不计请求**）。
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

  /* 定时检查：所有人都托管满 2 分钟（全员被移出）→ 房间直接解散（用户 2026-09-19 定）。
     ⚠️ 必须有 alarm 兜底：全员离线时没有任何消息能触发服务端代码，只能靠定时器。
     设置点：某座次首次代博时 setAlarm(now + OFFLINE_MS + 2s)。 */
  /* 某座次"彻底断线"的起算点 = **第一次被代博的时刻**（用户 2026-09-19 确认口径：
     从他第一次被代博起算 2 分钟；前面的 15 秒挂机判定不算在内）。 */
  goneAt(i) {
    const a = this.rec.auto && this.rec.auto[i];
    return (a && a.at) || 0;
  }
  async alarm() {
    await this.load();
    if (!this.rec || this.rec.closed) return;
    const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
    const roster = (this.rec.roster || []);
    if (!roster.length) {            /* 名单空了：连记录一起清掉（不留垃圾） */
      this.rec = null;
      await this.ctx.storage.delete('rec');
      return;
    }
    let allGone = true;
    for (let i = 0; i < roster.length; i++) {
      const t0 = this.goneAt(i);
      if (!t0 || Date.now() - t0 < OFFLINE_MS) { allGone = false; break; }
    }
    if (allGone) {
      this.rec.closed = true;        /* 全员掉线 → 解散（客户端收到 closed 即回设置页并提示） */
      await this.save();
      this.broadcast();
      return;
    }
    /* 还没全踢 → 再等一轮，保证最终会检查到 */
    try { await this.ctx.storage.setAlarm(Date.now() + OFFLINE_MS); } catch (e) {}
  }

  /* ---------- WebSocket 接入 ---------- */
  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      /* 非 WS 请求：给一个轻量查询口 —— 客户端加入失败时用它区分原因，
         以及健康检查。2026-09-19 起带回 roster/off/auto（均不敏感）：
         客户端据此区分「这局已经开始了」和「你已掉线太久被移出本局」。 */
      const rec = await this.load();
      const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
      return Response.json(
        rec ? {
          exists: true, started: !!rec.started, closed: !!rec.closed, count: rec.roster.length,
          roster: rec.roster.map(p => ({ id: p.id, name: p.name })),
          off: rec.off || [],
          auto: rec.auto || {},
          lastAct: rec.lastAct || {},
          offlineMs: OFFLINE_MS
        } : { exists: false },
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
      /* 彻底断线（用户 2026-09-18 定）：开始代博（auto[i].at）起 2 分钟没回来 → 无论 pid
         重连还是按名字认领都不再放行。座次与已博到的奖品保留（结算按之前博的算），
         之后每轮到自动跳过，游戏照常走完；「再来一局」清空后可正常参与下一局。 */
      const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
      const kicked = (i) => {
        const a = rec.auto && rec.auto[i];            /* 第一次代博起算 2 分钟（与 goneAt 一致） */
        return !!(a && a.at && Date.now() - a.at >= OFFLINE_MS);
      };
      const mineIdx = rec.roster.findIndex(p => p.id === pid);
      if (mineIdx >= 0 && kicked(mineIdx))
        return new Response('掉线超过两分钟，已被移出本局', { status: 403 });
      const mine = mineIdx >= 0;
      if (!mine && rec.started) {
        /* 页面被杀（iOS/安卓切后台内存回收）后 sessionStorage 连 PEER 身份一起丢：
           新 pid 对不上 roster → 直接 403 的话用户永远回不了房（2026-09-18 用户实测）。
           按名字认领：roster 里有**同名且当前确实离线**的座次 → 顶替它的 pid 重连。
           在线同名 / 不同名 / 已彻底断线（超 2 分钟）→ 仍然拒绝（防冒名顶掉正在玩的人）。 */
        this.markOffline();   /* 先把 off 刷到最新（此刻新连接还没 accept，不会把自己算在线） */
        const idx = rec.roster.findIndex((p, i) => p.name === name && this.rec.off && this.rec.off[i] && !kicked(i));
        if (idx < 0) return new Response('这局已经开始了', { status: 403 });
        this.rec.roster[idx].id = pid;
        if (this.rec.auto) delete this.rec.auto[idx];
        await this.save();
      } else if (!mine) {
        this.rec.roster.push({ id: pid, name });
        await this.save();
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0], server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid });
    if (this.dead) this.dead.delete(pid);   /* 回线：从"刚关闭"名单里摘掉 */
    {   /* 回线 = 恢复正常：清掉该座次的代博计时（2 分钟判定作废，2026-09-18 用户定） */
      const backIdx = this.rec.roster.findIndex(p => p.id === pid);
      if (backIdx >= 0 && this.rec.auto) delete this.rec.auto[backIdx];
    }
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
    if (this.rec.cancelled) for (let i = 0; i < this.rec.off.length; i++)
      if (this.rec.off[i]) delete this.rec.cancelled[i];   /* 又掉线了 → 重新自动托管 */
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
      /* 防冒名：只能替**自己**掷，或替「已掉线 / 15 秒无操作」的座次代博（2026-09-19 用户实测定：
         切后台的人 socket 往往没断（TCP 挂着），服务端视角 off=false —— 若只认 off，
         其他玩家的代博全被拒、只有掉线者自己的端能发起，而他的计时器在后台是冻结的。
         所以加一条「该座次 15 秒无任何操作」也允许代博/跳过 —— 正是"15 秒判定"的服务端对应物。
         ⚠️ 拿不到发送者身份时**放行**（fail-open）：这只是第二道防线，
         为了它把合法掷骰丢掉（运行时瞬时给不出 attachment）才是真事故。 */
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid) {
        const senderSeat = this.rec.roster.findIndex(p => p.id === pid);
        if (senderSeat !== seat) {
          const offOK = this.rec.off && this.rec.off[seat];
          const la = this.rec.lastAct ? this.rec.lastAct[seat] : undefined;
          const idleOK = la !== undefined && Date.now() - la >= RoomDO.IDLE_PROXY_MS;
          if (!offOK && !idleOK) return;
        }
      }
      if (this.rec.events.length >= 5000) return;      /* 兜底：别让异常客户端把记录撑爆 */
      /* 幂等：同一座次不会连续出现两条事件（最少 2 人轮换）——代博/跳过时多个在线端
         同时触发是完全正常的时序，只有第一条被接受，其余丢弃，全员回放零失步。 */
      const lastEv = this.rec.events[this.rec.events.length - 1];
      /* ⚠️ 只拦**同类型**的连续事件：取消托管不产生事件，"取消后重新代博"上一条仍是
         自己的 a-roll，用"同座次即拦"会把正常的重新托管静默拦掉（实测：取消后发呆，
         按钮停在「轮到你了」，整局卡住 —— 2026-09-19 验证页 [4] 抓到）。 */
      if (lastEv && lastEv.s === seat && !lastEv.skip) return;
      /* 代博状态机（服务端集中）：auto[seat] = { cnt: 本轮代博把数, at: 首把时刻 }。
         满 5 把 = 处置方式改为跳过；回线/取消/reset 时整段删除。 */
      if (m.a) {
        this.rec.auto = this.rec.auto || {};
        const st = this.rec.auto[seat];
        if (!st) {
          this.rec.auto[seat] = { cnt: 1, at: Date.now() };   /* 首把 = 2 分钟判定的起点 */
          /* 兜底：托管窗口过后检查"是否全员被移出 → 解散房间"（全员离线时没有消息能触发） */
          try {
            const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
            await this.ctx.storage.setAlarm(Date.now() + OFFLINE_MS + 2000);
          } catch (e) { /* alarm 不可用就算了，不影响主流程 */ }
        }
        else if (st.cnt >= 5) return;                                /* 满 5：只能跳过 */
        else st.cnt++;
      }
      this.rec.events.push({ s: seat, d: m.d.slice(), a: m.a ? 1 : undefined });   /* a=1 代博（仅展示用） */
      this.rec.lastAct = this.rec.lastAct || {};
      if (!m.a) this.rec.lastAct[seat] = Date.now();   /* 只记**玩家本人**操作；代博不算（否则跳不过去） */
      if (!m.a && this.rec.cancelled) delete this.rec.cancelled[seat];   /* 本人正常掷骰 = 取消托管自然完成 */
      await this.save();
      this.broadcast();
    } else if (m.t === 'skip') {
      /* 掉线跳过：只允许跳过「已掉线 / 15 秒无操作」的座次（防抢回合）。
         15 秒无操作（假死：socket 没断但人不在）与 off 等价 —— 见 roll 校验的注释。
         自动化节奏由客户端管（15 秒判定 → 代博 5 把 → 满 5 或超 2 分钟自动跳过），
         服务端只做底线校验。
         ⚠️ 幂等：两个好心人同时点「跳过这一把」是完全正常的时序（一个座次只能跳一次）。
         没有这道去重，第二条重复事件会让所有人回放到"座次对不上"→ 整局被判失步。 */
      if (!this.rec.started) return;
      const seat = m.s | 0;
      this.markOffline();
      if (seat < 0 || seat >= this.rec.roster.length) return;
      const la = this.rec.lastAct ? this.rec.lastAct[seat] : undefined;
      const idleOK = la !== undefined && Date.now() - la >= RoomDO.IDLE_PROXY_MS;
      const st5 = this.rec.auto && this.rec.auto[seat] && this.rec.auto[seat].cnt >= 5;
      if (!this.rec.off || (!this.rec.off[seat] && !idleOK && !st5)) return;   /* 满 5 把 → 直接可跳 */
      /* 全场都已进入「自动跳过」阶段（每座次代博满 5 把或已彻底断线）→ 跳过事件没有观众，
         直接不写：既省额度（每次跳过都是一次 SQLite 行写）也不刷提示（2026-09-19 用户要求），
         静默等 alarm 到点解散房间。
         ⚠️ 判据是"都满 5 把"，**不是**"都进入托管"——最后进入托管的那位还要正常代博 5 把。 */
      {
        let allSkipping = (this.rec.roster.length > 0);
        for (let i = 0; i < this.rec.roster.length; i++) {
          const a = this.rec.auto && this.rec.auto[i];
          const t0 = this.goneAt(i);
          const gone = t0 && (Date.now() - t0 >= OFFLINE_MS);
          if (!((a && a.cnt >= 5) || gone)) { allSkipping = false; break; }
        }
        if (allSkipping) return;
      }
      const last = this.rec.events[this.rec.events.length - 1];
      if (last && last.skip && last.s === seat) return;      /* 已跳过 → 忽略重复请求 */
      if (this.rec.events.length >= 5000) return;            /* 兜底上限，同 roll */
      this.rec.events.push({ s: seat, skip: true });
      /* 不刷新 lastAct：跳过是"别人替他跳"，不代表本人活动（刷了会把 2 分钟无限续期） */
      /* 彻底断线点名：开始代博起超 2 分钟（用户 2026-09-18 定）→ left 带 kicked，
         其他人看到「XX 掉线太久，已被移出本局」；此后该座次的重连/认领一律被拒。 */
      {
        const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
        const goneT0 = this.goneAt(seat);
        if (goneT0 && Date.now() - goneT0 >= OFFLINE_MS) {
          /* ⚠️ 只点名一次：之后每轮跳过都静默（用户 2026-09-19 定——重复刷"已被移出本局"很丑） */
          this.rec.kickNotified = this.rec.kickNotified || {};
          if (!this.rec.kickNotified[seat]) {
            this.rec.kickNotified[seat] = true;
            this.rec.leftSeq = (this.rec.leftSeq || 0) + 1;
            this.rec.left = { seq: this.rec.leftSeq, name: this.rec.roster[seat].name, kicked: true };
          }
          /* ⚠️ auto 不删：它持续作为"拒绝重连"的依据，直到本人回线（accept 时清）或 reset */
        }
      }
      await this.save();
      this.broadcast();
    } else if (m.t === 'start') {
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid !== this.rec.host) return;          /* 只有房主能开局 */
      if (this.rec.roster.length < 2) return;     /* 至少两人 */
      this.rec.started = true;
      this.rec.lastAct = this.rec.roster.map(() => Date.now());   /* 开局重置活动时间：15 秒判定从这里起算 */
      await this.save();
      this.broadcast();
    } else if (m.t === 'cancel') {
      /* 取消代博/跳过（2026-09-19 用户定）：被代博的玩家本人点「取消代博」→ 整段代博状态删除，
         之后轮到他正常等他自己博；若他又 15 秒没动，会重新进入托管（lastAct 判定）。 */
      const seat = m.s | 0;
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid && this.rec.roster.findIndex(p => p.id === pid) !== seat) return;   /* 只能取消自己的 */
      /* ⚠️ 已彻底断线（托管满 2 分钟）→ 取消无效：他已被真正移出本局。
         否则"人还在页面但已超时"的玩家一点取消就复活（socket 活着，cancel 照样能进来）——
         这就违背了"2 分钟没回来 = 移出"的规则（2026-09-19 用户实测发现）。 */
      {
        const OFFLINE_MS = Number(this.env && this.env.OFFLINE_MS) || 120000;
        const goneT0 = this.goneAt(seat);      /* 与 kicked 判定同一套起算点 */
        if (goneT0 && Date.now() - goneT0 >= OFFLINE_MS) return;
      }
      if (this.rec.auto) delete this.rec.auto[seat];
      this.rec.cancelled = this.rec.cancelled || {};
      this.rec.cancelled[seat] = Date.now();   /* 时间戳：15 秒宽限期内正常博，超时未动重新托管 */
      this.rec.lastAct = this.rec.lastAct || {};
      this.rec.lastAct[seat] = Date.now();
      await this.save();
      this.broadcast();
    } else if (m.t === 'reset') {
      /* 再来一局：房主清空事件回到大厅，原班人马直接开下一局（不用重建房间） */
      const pid = (ws.deserializeAttachment() || {}).pid;
      if (pid !== this.rec.host) return;
      this.rec.gen = (this.rec.gen || 0) + 1;   /* 世代号：客户端据此识别"新一局"，
                                                   过期快照防护只对同世代生效（防重开局被冻死在旧视图） */
      this.rec.events = [];
      this.rec.auto = {}; this.rec.cancelled = {}; this.rec.kickNotified = {};   /* 新局：全部复活 */
      try { await this.ctx.storage.deleteAlarm(); } catch (e) {}
      this.rec.lastAct = this.rec.roster.map(() => Date.now());
      this.rec.left = null;
      this.rec.started = false;
      await this.save();
      this.broadcast();
    } else if (m.t === 'bye') {
      await this.dropPlayer(ws, true, !!m.done);   /* 主动退出（区别于掉线） */
      try { ws.close(); } catch (e) {}             /* 退都退了，别让连接挂着（与 mock 一致） */
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

    /* 主动退出：把"谁走了"写进记录再广播 —— 否则打完之后有人退出，房间照常在、
       其他人却完全看不出人少了（实测用户报的问题）。带 seq 让客户端只提示一次。
       掉线（没发 bye）不写，那是"暂时联系不上"，不是"离场"。 */
    if (explicit) {
      const who = this.rec.roster.find(p => p.id === pid);
      this.rec.leftSeq = (this.rec.leftSeq || 0) + 1;
      this.rec.left = { seq: this.rec.leftSeq, name: who ? who.name : '有人', done: !!done };
    }

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
