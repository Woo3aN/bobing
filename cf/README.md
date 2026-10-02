# 博饼联机服务（Cloudflare Worker + Durable Object）

博饼跨设备联机后端。**零月费**：Worker + Durable Object 都在 Cloudflare 免费额度内。

**额度口径**（6 人局 × 250 掷）：**瓶颈是 SQLite 行写**——每掷一次存一次房间快照，
一局约 270 行 → 免费额度（10 万行/天）**约 300 局/天**；DO 请求、Worker 请求、
行读、计算时长各项余量都在几十到上万倍（WS 消息按 20:1 折算、ping 走 auto-response 不计费、
Hibernation 挂机不烧时长）。详见根目录 `publish/README.md` 的额度表。

## 架构

```
woo3an.top/            博客（另一个 Worker rhinelab-blog，仓库 Woo3aN/rhinelab-blog-theme，
                       本 Worker 不处理根路径）
woo3an.top/bobing/     游戏本体（public/index.html）
woo3an.top/ws?...      Worker → 每个房间号一个 Durable Object
                       · WebSocket 常驻推送（无轮询）
                       · 房间记录 {code, host, started, closed, roster, events} 存 DO SQLite
                       · Hibernation API：空闲不计时长
```

## 部署边界（2026-10-02 拆分）

`woo3an.top` 一个域名两个 Worker，按路径分工，**各自独立仓库、独立部署**：

| Worker 名 | 路由 | 仓库 | 内容 |
|---|---|---|---|
| `rhinelab-blog` | `woo3an.top/*` | Woo3aN/rhinelab-blog-theme（`cf-deploy/`） | 博客 + `/lab/` |
| `bobing-game` | `woo3an.top/bobing*`、`woo3an.top/ws*` | Woo3aN/bobing（`cf/`） | 博饼游戏 + 房间服务 |

⚠️ 两个仓库的 Worker **名字必须不同**——名字就是部署单元 ID，
同名部署 = 后部署的把先部署的整个覆盖掉（2026-10-02 之前两边都叫
`bobing`，游戏一上线就把博客盖没了）。

⚠️ **route pattern 必须带 `*`**：pattern 匹配的是完整 URL，写死 `woo3an.top/ws`
只匹配不带 query 的 `/ws`；游戏连的是 `/ws?code=1234&op=...`，不带 `*` 就会漏回
博客的 `woo3an.top/*`、拿到博客的 404 页，还会被边缘缓存住（握手一直 404）。

改路由请改仓库里的 `wrangler.jsonc`，别只改 Cloudflare 控制台（下次部署会被冲掉）。

两边都是推到 `main` 自动部署（本仓库 `.github/workflows/deploy.yml`，博客那边
`.github/workflows/deploy.yml`），用的都是同名仓库密钥 `CLOUDFLARE_API_TOKEN`。

房间记录的数据结构与游戏里的 Local / CloudBase 传输层完全一致，
游戏侧 `onRoom(r)` 事件回放逻辑零改动 —— 传输层是可插拔的。

## 文件

| 文件 | 作用 |
|---|---|
| `src/worker.js` | Worker 入口 + `RoomDO`（建房/加入/开局/掷骰广播/重连/解散） |
| `wrangler.jsonc` | Worker 名 `bobing-game`、静态资源 ASSETS、Durable Object ROOMS、路由 `woo3an.top/bobing*` 与 `woo3an.top/ws*` |
| `public/index.html` | 游戏本体（由项目根 `index.html` 同步而来，别直接改） |
| `test-room.js` | 服务端协议测试（Node ws 客户端，44 项断言，含掉线托管/取消/全员解散） |
| `ws-probe.js` | 线上 WebSocket 直连探针：只做一次 WS 升级、不碰 HTTP 预检，判断握手有没有被路由或缓存拦掉（`node ws-probe.js`） |
| `mock-server.js` | 本地模拟房间服务（协议与 Worker 一致，供浏览器 e2e 测试用） |
| `dev/__e2e.html` | 浏览器端到端测试页（双实例建房→加入→对博→重连，23 步） |
| `public/dev/__auto.html` | 托管/取消按钮专项验证页（9 步，线上也可打开自测） |

## 掉线 / 挂机托管（自动处置，无需人管）

| 情况 | 处理 |
|---|---|
| 轮到某人 15 秒没动静（页面开着也算） | 判定托管，自动替他博 |
| 直接掉线（关窗口等） | 等 5 秒开始替他博 |
| 托管中 | 每 0.4 秒一把，最多 5 把（满 5 后每轮 0.2 秒跳过） |
| 从**第一次代博**起 2 分钟内回来 | 一切照常（本人可点主按钮取消托管） |
| 超过 2 分钟 | 彻底断线：只点名一次、静默跳过、重连被拒、连本人也不能取消 |
| 没有任何自由玩家（最后一人也掉线） | 状态标记为跳过阶段（**不造事件**——服务端不知道轮到谁），各端显示"本局已停止" |
| 所有人都被移出 | 房间自动解散（DO alarm 兜底） |

关键实现：`lastAct[seat]`（**只在本人操作时刷新**，代博/跳过不算）判 15 秒挂机；
`auto[seat]={cnt,at}` 服务端状态机；`cancelled[seat]` 取消宽限；
事件幂等**只拦同座次同类型**（取消/跳过不产生新座次，过宽会拦死重新代博）。

## 常用命令

```bash
# 本地起真实 Worker（workerd）
npx wrangler dev --port 8788

# 部署：推到 main 由 .github/workflows/deploy.yml 自动跑下面这条，
# 本机手动部署才需要敲（需先 npx wrangler login 授权一次）
npx wrangler deploy --no-bundle

# 服务端协议测试（本地或线上）
node test-room.js
WS_URL=wss://woo3an.top/ws node test-room.js

# 浏览器 e2e（本地模拟服务 + headless Chrome）
node mock-server.js        # 另开一个终端
# 然后访问 http://127.0.0.1:8911/dev/__e2e.html
```

## 协议

客户端 → 服务端：`{t:'roll', s:座次, d:[6颗点数]}` / `{t:'start'}` / `{t:'bye'}`
服务端 → 客户端：`{t:'room', r:房间记录}`（任何变化立即推给房间里所有人）
加入失败（房间不存在/已开局/号被占）走 HTTP 4xx，浏览器侧表现为连接被拒。

## 注意

- 服务端**不跑游戏规则**（只做房间记录 + 事件追加），规则在客户端，与 CloudBase 版一致。
  因此：无防作弊，只适合熟人局。
- `public/index.html` 是同步产物，改游戏请改项目根的 `index.html` 再复制过来。
- 免费额度用尽会拒绝服务（不会产生账单），下月重置。
