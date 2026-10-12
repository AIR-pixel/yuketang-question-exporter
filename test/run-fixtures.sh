#!/usr/bin/env bash
# 无头跑夹具页，把 <pre id="out"> 的内容和 document.title 打到 stdout。
#
# 一条命令完成「起服务 → 跑页 → 杀服务」，服务生命周期不超出本脚本，
# 不会在 WorkBuddy 的任务面板里留下「已运行 N 分钟」的僵尸记录。
#
# 用法：bash test/run-fixtures.sh [fixture.html fixture-font.html ...]
#
# 三个踩过的坑（改脚本时别踩回去）：
#   1) 每次都换临时 user-data-dir。复用 profile 会命中缓存，测出来的是上一版结果。
#   2) --virtual-time-budget 要给到 120000。批量导出那条用例内部有大量
#      await sleep/waitFor，虚拟时钟会把等待一并算掉，给 8s 会卡在中间显示 pending。
#   3) 不要在工具里另起一个常驻的 serve.py（会留下杀不掉的僵尸任务记录），
#      一律走本脚本；端口用 port=0 让系统分配，避免撞上残留进程后
#      「新服务起不来、请求其实被旧服务应答」的假象。
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# 依赖自动探测，别写死路径（写死了别人 clone 下来跑不了）
PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "找不到 python，请先装 Python 3.8+ 并加进 PATH"; exit 1; }

EDGE=""
for c in \
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  "/c/Program Files/Microsoft/Edge/Application/msedge.exe" \
  "$(command -v microsoft-edge 2>/dev/null)" \
  "$(command -v msedge 2>/dev/null)" \
  "$(command -v google-chrome 2>/dev/null)" \
  "$(command -v chromium 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then EDGE="$c"; break; fi
done
[ -n "$EDGE" ] || { echo "找不到 Edge / Chrome / Chromium，无头模式需要其中一个"; exit 1; }

PAGES=("$@")
[ ${#PAGES[@]} -eq 0 ] && PAGES=(fixture.html fixture-yuketang.html)

LOG="$(mktemp)"
"$PY" "$ROOT/test/serve.py" 0 > "$LOG" 2>&1 &
SRV=$!

cleanup() {
  kill "$SRV" 2>/dev/null
  wait "$SRV" 2>/dev/null
  kill -9 "$SRV" 2>/dev/null
}
trap cleanup EXIT INT TERM

PORT=""
for _ in $(seq 1 60); do
  PORT="$(grep -o 'PORT=[0-9]*' "$LOG" 2>/dev/null | head -1 | cut -d= -f2)"
  [ -n "$PORT" ] && break
  sleep 0.2
done
if [ -z "$PORT" ]; then
  echo "测试服务器没起来，日志："
  cat "$LOG"
  exit 1
fi

for page in "${PAGES[@]}"; do
  PROFILE="$(mktemp -d)"        # 临时目录留在 %TEMP%，不删（避免踩删除守卫）
  OUT="/tmp/ce_${page}.txt"
  "$EDGE" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
    --user-data-dir="$PROFILE" --virtual-time-budget=120000 \
    --run-all-compositor-stages-before-draw \
    --dump-dom "http://127.0.0.1:${PORT}/test/${page}?__ceplatform=yuketang&_t=$(date +%s)" \
    > "$OUT" 2>/dev/null
  TITLE="$(grep -o '<title>[^<]*</title>' "$OUT" | head -1 | sed 's/<[^>]*>//g')"
  echo "FILE: ${page} | TITLE: ${TITLE}"
  "$PY" - "$OUT" <<'PYEOF'
import io, re, sys, html
raw = io.open(sys.argv[1], encoding='utf-8', errors='replace').read()
m = re.search(r'<pre id="out">(.*?)</pre>', raw, re.S)
print(html.unescape(m.group(1)) if m else '(未找到 <pre id="out">，脚本可能没跑起来)')
PYEOF
  echo
done
