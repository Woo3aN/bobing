const fs = require('fs');
const https = require('https');
const cfgPath = 'C:/Users/24431/AppData/Roaming/xdg.config/.wrangler/config/default.toml';
const tok = fs.readFileSync(cfgPath, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function api(path) {
  return new Promise((resolve, reject) => {
    https.get({ host: 'api.cloudflare.com', path, headers: { Authorization: 'Bearer ' + tok } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad json: ' + d.slice(0, 200))); } });
    }).on('error', reject);
  });
}

(async () => {
  const zones = await api('/client/v4/zones?name=woo3an.top');
  if (!zones.result || !zones.result.length) { console.log('没找到 zone: ' + JSON.stringify(zones).slice(0, 300)); return; }
  const z = zones.result[0];
  console.log('zone: ' + z.name + ' | id=' + z.id + ' | status=' + z.status);

  const recs = await api('/client/v4/zones/' + z.id + '/dns_records?per_page=50');
  console.log('DNS 记录 ' + (recs.result || []).length + ' 条：');
  (recs.result || []).forEach(r => {
    console.log('  ' + r.type.padEnd(6) + ' ' + String(r.name).padEnd(20) +
      ' -> ' + String(r.content).slice(0, 28).padEnd(30) +
      ' proxied=' + (r.proxied ? '是(橙云)' : '否(灰云)'));
  });
})().catch(e => console.log('调用失败: ' + e.message));
