#!/usr/bin/env bash
# 参照环境启停脚本（ADR-0007）：Xvfb + Chromium + x11vnc + noVNC，全部只监听 127.0.0.1。
# 用法见 tools/reference-env/README.md。不触碰机器上已有的 Multica 服务和系统 nginx。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${DIDA_REF_HOME:-$HOME/.dida-reference}"
PROFILE_DIR="$STATE_DIR/profile"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"
DISPLAY_NUM="${DIDA_REF_DISPLAY:-99}"
VNC_PORT="${DIDA_REF_VNC_PORT:-5901}"
NOVNC_PORT="${DIDA_REF_NOVNC_PORT:-6080}"
SCREEN="${DIDA_REF_SCREEN:-1920x1080}"
START_URL="${DIDA_REF_START_URL:-https://dida365.com/signin}"
NOVNC_WEB="${DIDA_REF_NOVNC_WEB:-/usr/share/novnc}"

die() { echo "错误: $*" >&2; exit 1; }
log() { echo "[reference-env] $*"; }

find_node() {
  if [[ -n "${DIDA_REF_NODE:-}" ]]; then echo "$DIDA_REF_NODE"; return; fi
  local c
  for c in "$HOME"/.local/opt/node-v2[0-9]*-linux-x64/bin/node "$(command -v node 2>/dev/null || true)"; do
    [[ -x "$c" ]] || continue
    if "$c" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then echo "$c"; return; fi
  done
  die "需要 Node >= 20（可设置 DIDA_REF_NODE 指向 node 可执行文件）"
}

chromium_path() {
  local node; node="$(find_node)"
  (cd "$HERE" && "$node" -e 'import("playwright").then(p => console.log(p.chromium.executablePath()))')
}

UNIT_PREFIX="dida-reference"

# 优先用 systemd 临时单元（systemd-run，不写任何配置文件）运行，进程不挂在调用者的 cgroup 下：
# 例如从 Multica 智能体里启动时，不会落进 multica-daemon.service，守护进程重启也不会带走它们。
use_systemd() { [[ "${DIDA_REF_NO_SYSTEMD:-}" != 1 ]] && command -v systemd-run >/dev/null && sudo -n true 2>/dev/null; }

main_pid() {
  if use_systemd; then
    local pid; pid="$(systemctl show -p MainPID --value "$UNIT_PREFIX-$1.service" 2>/dev/null || echo 0)"
    [[ "$pid" != 0 && -n "$pid" ]] && echo "$pid" && return 0
    return 1
  fi
  local f="$RUN_DIR/$1.pid" pid
  [[ -f "$f" ]] || return 1
  pid="$(cut -d' ' -f1 "$f")"
  if [[ "$(cat "$f")" == "$(proc_identity "$pid")" ]]; then echo "$pid"; return 0; fi
  return 1
}

# 进程身份 "<pid> <启动时间> <boot_id>"。只有 pid 文件里记的身份和 /proc 里的一致，才认为是自己启动的进程；
# 否则（服务器重启过、pid 被别的进程复用、旧格式文件）一律当作没在运行，绝不去 kill 它。
proc_identity() {
  local pid="$1" stat
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  stat="$(cat "/proc/$pid/stat" 2>/dev/null)" || return 1
  stat="${stat##*) }"                       # 去掉 "pid (comm) "，comm 里可能有空格或括号
  local -a f; read -ra f <<<"$stat"         # f[0] 是第 3 个字段，启动时间是第 22 个字段
  echo "$pid ${f[19]} $(cat /proc/sys/kernel/random/boot_id)"
}

pid_alive() { main_pid "$1" >/dev/null; }

port_busy() { ss -Hltn "sport = :$1" | grep -q .; }

ensure_state_dir() {
  umask 077
  mkdir -p "$STATE_DIR" "$PROFILE_DIR" "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$STATE_DIR" "$PROFILE_DIR" "$RUN_DIR" "$LOG_DIR"
  if [[ ! -f "$STATE_DIR/vncpasswd" ]]; then
    local pw=""
    # VNC 密码最多 8 位；循环补足，保证一定是 8 位字母数字。
    while (( ${#pw} < 8 )); do pw+="$(head -c 64 /dev/urandom | tr -dc 'A-Za-z0-9')"; done
    pw="${pw:0:8}"
    printf '%s\n' "$pw" > "$STATE_DIR/vncpasswd.txt"
    x11vnc -storepasswd "$pw" "$STATE_DIR/vncpasswd" >/dev/null 2>&1
    chmod 600 "$STATE_DIR/vncpasswd" "$STATE_DIR/vncpasswd.txt"
  fi
}

# 后台启动；调用者退出后继续运行。
spawn() {
  local name="$1"; shift
  if pid_alive "$name"; then log "$name 已在运行 (pid $(main_pid "$name"))"; return; fi
  if use_systemd; then
    sudo systemd-run --quiet --collect --unit="$UNIT_PREFIX-$name" \
      --uid="$(id -u)" --gid="$(id -g)" -p WorkingDirectory="$HOME" \
      -p StandardOutput="append:$LOG_DIR/$name.log" -p StandardError="append:$LOG_DIR/$name.log" \
      -E HOME="$HOME" -E PATH="$PATH" -E LANG=C.UTF-8 ${DISPLAY:+-E DISPLAY="$DISPLAY"} \
      "$@"
    sleep 0.3
    pid_alive "$name" || die "$name 启动失败，见 $LOG_DIR/$name.log"
  else
    setsid nohup "$@" >>"$LOG_DIR/$name.log" 2>&1 < /dev/null &
    proc_identity $! > "$RUN_DIR/$name.pid" || die "$name 启动后立刻退出，见 $LOG_DIR/$name.log"
  fi
  log "已启动 $name (pid $(main_pid "$name"))"
}

wait_port() {
  local port="$1" i
  for i in $(seq 1 50); do port_busy "$port" && return 0; sleep 0.2; done
  return 1
}

preflight() {
  for cmd in Xvfb x11vnc websockify ss; do command -v "$cmd" >/dev/null || die "缺少 $cmd，先运行: $0 setup"; done
  [[ -f "$NOVNC_WEB/vnc.html" ]] || die "找不到 noVNC 网页目录 $NOVNC_WEB，先运行: $0 setup"
  # 端口冲突检查：只在不是自己启动的进程占用时报错，绝不去停别人的服务。
  if ! pid_alive x11vnc && port_busy "$VNC_PORT"; then die "端口 $VNC_PORT 已被其他进程占用，换一个: DIDA_REF_VNC_PORT=..."; fi
  if ! pid_alive novnc && port_busy "$NOVNC_PORT"; then die "端口 $NOVNC_PORT 已被其他进程占用，换一个: DIDA_REF_NOVNC_PORT=..."; fi
  if ! pid_alive xvfb && [[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]]; then die "显示号 :$DISPLAY_NUM 已被占用，换一个: DIDA_REF_DISPLAY=..."; fi
}

start_browser() {
  ensure_state_dir
  pid_alive xvfb || die "Xvfb 没在运行，先运行: $0 start"
  local chrome; chrome="$(chromium_path)"
  [[ -x "$chrome" ]] || die "找不到 Chromium，先运行: $0 setup"
  local w="${SCREEN%x*}" h="${SCREEN#*x}"
  # 参数与 Playwright 启动时保持一致（basic 密码存储、无沙箱），截图工具才能读到同一份登录态。
  DISPLAY=":$DISPLAY_NUM" spawn chromium "$chrome" \
    --user-data-dir="$PROFILE_DIR" \
    --password-store=basic --use-mock-keychain --no-sandbox \
    --no-first-run --no-default-browser-check --disable-features=Translate \
    --lang=zh-CN --window-position=0,0 --window-size="$w,$h" \
    "$START_URL"
}

stop_one() {
  local name="$1" pid i
  if use_systemd; then
    if pid_alive "$name"; then
      pid="$(main_pid "$name")"
      sudo systemctl stop "$UNIT_PREFIX-$name.service"
      log "已停止 $name (pid $pid)"
    fi
    return 0
  fi
  local f="$RUN_DIR/$name.pid"
  [[ -f "$f" ]] || return 0
  if pid="$(main_pid "$name")"; then
    kill "$pid"
    for i in $(seq 1 50); do pid_alive "$name" || break; sleep 0.2; done
    pid_alive "$name" && kill -9 "$pid"
    log "已停止 $name (pid $pid)"
  elif [[ -s "$f" ]]; then
    log "$name 的 pid 文件已失效（$(cat "$f")），只删除文件，不发信号"
  fi
  rm -f "$f"
}

cmd_setup() {
  log "安装系统依赖（Xvfb、x11vnc、noVNC、websockify、中文字体）"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    xvfb x11vnc novnc websockify fonts-noto-cjk fonts-noto-color-emoji
  local node; node="$(find_node)"
  local bindir; bindir="$(dirname "$node")"
  log "安装 Playwright 和 Chromium（node: $node）"
  (cd "$HERE" && PATH="$bindir:$PATH" npm ci && PATH="$bindir:$PATH" npx playwright install chromium \
    && sudo env PATH="$bindir:$PATH" npx playwright install-deps chromium)
  ensure_state_dir
  log "完成。配置目录: $STATE_DIR（权限 700）"
}

cmd_start() {
  preflight
  ensure_state_dir
  spawn xvfb Xvfb ":$DISPLAY_NUM" -screen 0 "${SCREEN}x24" -nolisten tcp
  for _ in $(seq 1 50); do [[ -e "/tmp/.X11-unix/X$DISPLAY_NUM" ]] && break; sleep 0.2; done
  start_browser
  spawn x11vnc x11vnc -display ":$DISPLAY_NUM" -localhost -rfbport "$VNC_PORT" \
    -noipv6 -rfbportv6 -1 -rfbauth "$STATE_DIR/vncpasswd" -forever -shared -noxdamage
  wait_port "$VNC_PORT" || die "x11vnc 没有监听 $VNC_PORT，见 $LOG_DIR/x11vnc.log"
  spawn novnc websockify --web "$NOVNC_WEB" "127.0.0.1:$NOVNC_PORT" "127.0.0.1:$VNC_PORT"
  wait_port "$NOVNC_PORT" || die "websockify 没有监听 $NOVNC_PORT，见 $LOG_DIR/novnc.log"
  cmd_status
}

cmd_stop() {
  local n
  for n in novnc x11vnc chromium xvfb; do stop_one "$n"; done
}

cmd_status() {
  local n rc=0
  for n in xvfb chromium x11vnc novnc; do
    if pid_alive "$n"; then echo "$n: 运行中 (pid $(main_pid "$n"))"; else echo "$n: 未运行"; rc=1; fi
  done
  echo "监听端口:"
  ss -Hltn "( sport = :$VNC_PORT or sport = :$NOVNC_PORT )" | awk '{print "  " $4}'
  echo "noVNC 地址: http://localhost:$NOVNC_PORT/vnc.html?autoconnect=1&resize=scale"
  echo "配置目录:   $STATE_DIR ($(stat -c %a "$STATE_DIR" 2>/dev/null || echo 不存在))"
  return $rc
}

cmd_purge() {
  [[ "${1:-}" == "--yes" ]] || die "会删除 $STATE_DIR（含登录态），确认请加 --yes"
  cmd_stop
  rm -rf -- "$STATE_DIR"
  log "已删除 $STATE_DIR"
}

case "${1:-}" in
  setup) cmd_setup ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  start-browser) start_browser ;;
  stop-browser) stop_one chromium ;;
  password) cat "$STATE_DIR/vncpasswd.txt" ;;
  purge) shift; cmd_purge "$@" ;;
  *) echo "用法: $0 {setup|start|stop|restart|status|start-browser|stop-browser|password|purge --yes}" >&2; exit 2 ;;
esac
