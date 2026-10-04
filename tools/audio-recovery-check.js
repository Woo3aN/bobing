/**
 * 音频恢复路径回归：把 AudioContext 人为挂起，再派发「回到前台」该发的事件，
 * 看每条路径是否都能把上下文唤醒。iOS 上丢声音多半就丢在这几步。
 *
 * 用法（本机没有 ws，借 cf 目录里那份）：
 *   1) 起一个允许自动播放的调试版 Chrome（不加 --autoplay-policy 的话，
 *      无头环境没有用户手势，resume 会被浏览器挡下，测试全红）：
 *      chrome --headless=new --disable-gpu --no-sandbox --enable-unsafe-swiftshader \
 *             --autoplay-policy=no-user-gesture-required \
 *             --remote-debugging-port=9338 --window-size=1200,900 about:blank
 *   2) NODE_PATH=<仓库>/cf/node_modules node tools/audio-recovery-check.js 9338 <页面地址>
 *
 * 页面地址可以是 file:///<仓库>/index.html（本地）或 https://woo3an.top/bobing/（线上）。
 * 退出码非 0 表示有路径没能恢复。
 */
const WebSocket = require("ws");

const PORT = process.argv[2] || "9338";
const URL_ = process.argv[3];
if (!URL_) {
  console.error("用法：node tools/audio-recovery-check.js <CDP端口> <页面地址>");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("没有可用的页面 target");

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
  await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

  let id = 0;
  const pending = new Map();
  ws.on("message", (buf) => {
    const m = JSON.parse(buf.toString());
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
  const js = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  };

  let failures = 0;
  const check = (label, actual, want = "running") => {
    const ok = actual === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? "[ok]" : "[!!]"} ${label.padEnd(36)} rawState=${actual}${ok ? "" : `（期望 ${want}）`}`);
  };
  const suspend = async () => { await js("Sfx.suspendForTest(); 1"); await sleep(200); };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: URL_ });
  await sleep(7000);

  console.log("音频恢复路径");
  await js("Sfx.unlock(); 1");
  await sleep(700);
  check("解锁后", await js("Sfx.rawState()"));

  await suspend();
  check("人为挂起（模拟切后台）", await js("Sfx.rawState()"), "suspended");
  await js("document.dispatchEvent(new Event('visibilitychange')); 1");
  await sleep(700);
  check("visibilitychange 唤醒", await js("Sfx.rawState()"));

  await suspend();
  await js("window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); 1");
  await sleep(700);
  check("pageshow 唤醒（Safari 关标签再打开走这条）", await js("Sfx.rawState()"));

  await suspend();
  await js("document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 1");
  await sleep(700);
  check("pointerdown 唤醒（任意一次触碰）", await js("Sfx.rawState()"));

  console.log(failures ? `\n有 ${failures} 项未通过` : "\n全部通过");
  ws.close();
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error("失败：", e.message); process.exit(1); });
