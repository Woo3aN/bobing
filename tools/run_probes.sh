#!/bin/bash
# 博饼自检探针 · 一条命令跑全套
# ---------------------------------------------------------------------------
# 用法：bash tools/run_probes.sh
#
# ⚠️ 两个必须遵守的跑法（都踩过）：
#  1. `--allow-file-access-from-files` 不能省：net 探针用两个同源 iframe 互博，
#     file:// 下缺这个标志会被同源策略挡住 → 报 "Blocked a frame with origin null"，
#     看起来像"探针挂了"，其实是跑法问题。
#  2. 每个探针独立 user-data-dir：共用会因 localStorage 互相污染而假失败。
#  3. 必须显式 --window-size：缺省 800×600 会让宽屏断言假失败。
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 临时 user-data-dir 放项目内的 .workbuddy/ 下：Git Bash 的 /tmp 往往不可写，
# 而项目目录一定可写（本机踩过：TMPDIR=/tmp → mkdir 权限拒绝 → 13 组全"解析失败"）
UD="${BOBING_PROBE_UD:-$ROOT/.workbuddy/probe-ud}"
mkdir -p "$UD" || { echo "无法创建 $UD"; exit 1; }
# Windows 版 Chrome 要 `file:///C:/...`（MSYS 风格的 /c/... 它不认）→ 用 cygpath 转
if command -v cygpath >/dev/null 2>&1; then URLROOT="$(cygpath -m "$ROOT")"; else URLROOT="$ROOT"; fi
BAD=0

run_probe() {   # mode w h tag
  local mode="$1" w="$2" h="$3" tag="$4" ud="$UD/$tag"
  rm -rf "$ud"
  "$CHROME" --headless=new --disable-gpu --no-sandbox --allow-file-access-from-files \
    --user-data-dir="$ud" --window-size="$w,$h" --virtual-time-budget=90000 \
    --dump-dom "file:///$URLROOT/博饼.html?selftest=$mode" 2>/dev/null \
    | grep -o '<pre id="__state">.*</pre>' | tail -1 \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
        const j=JSON.parse(d.replace(/<[^>]*>/g,''));
        const f=j.checks.filter(c=>!c.pass);
        console.log('[$mode @${w}x${h}] failed='+j.failed+' total='+j.checks.length+' errors='+j.errors.length);
        f.forEach(c=>console.log('   \u2717 '+c.name+' | '+String(c.detail).slice(0,100)));
        j.errors.forEach(e=>console.log('   ! '+String(e).slice(0,120)));
        if (j.failed || j.errors.length) process.exitCode = 1;
      }catch(e){console.log('[$mode @${w}x${h}] 解析失败: '+String(d).slice(0,150)); process.exitCode = 1;}});"
  [ $? -ne 0 ] && BAD=$((BAD + 1))
  return 0
}

echo "=== 博饼探针全套（$ROOT） ==="
for m in exhaustive flow steal input rules dice solo quota net; do
  run_probe "$m" 1280 800 "p_$m"
done
# 窄视口回归：布局类断言（状态栏 grid / 按钮不再乱跳）必须在手机宽度下也过
run_probe input 520 700  "p_input_520"
run_probe flow  520 700  "p_flow_520"
run_probe input 360 650  "p_input_360"
run_probe flow  360 650  "p_flow_360"

echo "=== 汇总：$BAD 组有问题（0 = 全过） ==="
exit $BAD
