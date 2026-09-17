const fs = require('fs');
const https = require('https');
const tok = fs.readFileSync('C:/Users/24431/AppData/Roaming/xdg.config/.wrangler/config/default.toml', 'utf8')
  .match(/oauth_token\s*=\s*"([^"]+)"/)[1];

function api(p) {
  return new Promise((res, rej) => {
    https.get({ host: 'api.cloudflare.com', path: p, headers: { Authorization: 'Bearer ' + tok } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res({ status: r.statusCode, json: JSON.parse(d) }); } catch (e) { rej(new Error('HTTP ' + r.statusCode + ' 非 JSON: ' + d.slice(0, 200))); } });
    }).on('error', rej);
  });
}

(async () => {
  const z = await api('/client/v4/zones?name=woo3an.top');
  const zid = z.json.result[0].id;
  const recs = await api('/client/v4/zones/' + zid + '/dns_records?per_page=50');
  console.log('dns_records HTTP ' + recs.status + ' | success=' + recs.json.success);
  if (!recs.json.success) console.log('errors: ' + JSON.stringify(recs.json.errors));
  (recs.json.result || []).forEach(r => {
    console.log('  ' + r.type + ' ' + r.name + ' -> ' + String(r.content).slice(0, 30) + ' proxied=' + (r.proxied ? 'yes' : 'no') + ' id=' + r.id);
  });

  /* Worker 自定义域名状态 */
  const dom = await api('/client/v4/accounts/4fbd588701e01fbe0f3a2cce7c02d7b5/workers/domains');
  console.log('\nworkers/domains HTTP ' + dom.status + ' | success=' + dom.json.success);
  if (!dom.json.success) console.log('errors: ' + JSON.stringify(dom.json.errors));
  (dom.json.result || []).forEach(d => console.log('  ' + d.hostname + ' -> ' + d.service + ' (' + (d.zone_name || '') + ')'));
})().catch(e => console.log('失败: ' + e.message));
