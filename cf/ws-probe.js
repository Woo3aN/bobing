/* 线上 WebSocket 探针：只做一次真正的 WS 升级，不碰任何 HTTP 预检。
   用途：确认 /ws 的 WebSocket 握手有没有被 Cloudflare 缓存拦掉。
   用法：node ws-probe.js [code] */
const WebSocket = require('ws');

const code = process.argv[2] || String(Math.floor(1000 + Math.random() * 9000));
const url =
  `wss://woo3an.top/ws?code=${code}&op=create&name=` +
  encodeURIComponent('探针') + '&pid=probe1';

console.log('连接:', url);
const ws = new WebSocket(url);
const timer = setTimeout(() => {
  console.log('❌ 5 秒内没收到任何消息（连接可能根本没到 Worker）');
  try { ws.close(); } catch {}
  process.exit(1);
}, 5000);

ws.on('open', () => console.log('✅ WebSocket 已建立'));
ws.on('message', (data) => {
  let msg = null;
  try { msg = JSON.parse(String(data)); } catch { msg = String(data).slice(0, 120); }
  console.log('✅ 收到服务端消息:', JSON.stringify(msg).slice(0, 240));
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(0);
});
ws.on('error', (err) => {
  console.log('❌ 错误:', err.message);
  clearTimeout(timer);
  process.exit(1);
});
ws.on('close', (c, r) => console.log('连接关闭 code=' + c + ' reason=' + String(r).slice(0, 80)));
