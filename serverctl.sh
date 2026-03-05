#!/usr/bin/env bash
set -Eeuo pipefail

# MediaSoup server control script
# Usage: ./serverctl.sh [start|stop|restart|status]
# - start:    Launch server in background with nohup (uses sudo if needed for privileged ports)
# - stop:     Stop any running server processes
# - restart:  Stop then start
# - status:   Show running processes and listening ports

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/mediasoup.log"
ENV_FILE="$SCRIPT_DIR/.env"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

find_node() {
  local candidate_nvm_dirs=()
  if [[ -n "${SUDO_USER:-}" ]]; then
    local sudo_home
    sudo_home=$(getent passwd "$SUDO_USER" | cut -d: -f6 2>/dev/null || true)
    [[ -n "$sudo_home" ]] && candidate_nvm_dirs+=("$sudo_home/.nvm")
  fi

  candidate_nvm_dirs+=("${NVM_DIR:-$HOME/.nvm}")

  local node_path
  local nvm_dir
  for nvm_dir in "${candidate_nvm_dirs[@]}"; do
    if [[ -d "$nvm_dir/versions/node" ]]; then
      node_path=$(find "$nvm_dir/versions/node" -type f -path '*/bin/node' 2>/dev/null | sort -V | tail -n1)
      if [[ -n "$node_path" ]]; then
        echo "$node_path"
        return 0
      fi
    fi
  done

  node_path=$(command -v node 2>/dev/null || true)
  if [[ -n "$node_path" ]]; then
    echo "$node_path"
    return 0
  fi

  return 1
}

load_env() {
  # Export variables from .env so we can decide whether sudo is needed
  if [[ -f "$ENV_FILE" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$ENV_FILE"; set +a || true
  fi
}

needs_root() {
  # Return 0 if we should use sudo to bind privileged ports (e.g., 443)
  local ssl_enabled="${SSL_ENABLED:-false}"
  local ssl_port="${SSL_PORT:-443}"
  local http_port="${PORT:-3000}"
  ssl_enabled="${ssl_enabled,,}"
  if [[ "$ssl_enabled" == "true" ]] && [[ "$ssl_port" =~ ^[0-9]+$ ]] && (( ssl_port < 1024 )); then
    return 0
  fi
  if [[ "$http_port" =~ ^[0-9]+$ ]] && (( http_port < 1024 )); then
    return 0
  fi
  return 1
}

pids_for_server() {
  # Return PIDs for this project's server by combining cmdline and port listeners,
  # and filtering by working directory == SCRIPT_DIR
  local found=() pid cwd

  # 1) Match by command line patterns
  local pat p
  for pat in "node server.js" "sh -c node server.js" "npm start"; do
    p=$(pgrep -f "$pat" 2>/dev/null || true)
    [[ -z "$p" ]] && p=$(sudo pgrep -f "$pat" 2>/dev/null || true)
    for pid in $p; do
      found+=("$pid")
    done
  done

  # 2) Match processes listening on our ports and grab their PIDs
  local http_port="${PORT:-3000}"
  local ssl_port="${SSL_PORT:-443}"
  local ports_regex="(${http_port}|${ssl_port})"
  local out
  if command -v ss >/dev/null 2>&1; then
    out=$(sudo ss -ltnp 2>/dev/null | grep -E ":${ports_regex}\\s" || true)
    while IFS= read -r line; do
      pid=$(sed -n 's/.*pid=\([0-9]\+\).*/\1/p' <<<"$line")
      [[ -n "$pid" ]] && found+=("$pid")
    done <<<"$out"
  elif command -v netstat >/dev/null 2>&1; then
    out=$(sudo netstat -ltnp 2>/dev/null | grep -E ":${ports_regex}\\s" || true)
    while IFS= read -r line; do
      pid=$(awk '{print $7}' <<<"$line" | cut -d'/' -f1)
      [[ "$pid" =~ ^[0-9]+$ ]] && found+=("$pid")
    done <<<"$out"
  fi

  # 3) Unique and filter to those with cwd == SCRIPT_DIR
  declare -A seen
  local unique=()
  for pid in "${found[@]}"; do
    [[ -z "$pid" ]] && continue
    [[ -n "${seen[$pid]:-}" ]] && continue
    seen[$pid]=1
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    if [[ -z "$cwd" ]] || [[ "$cwd" == "$SCRIPT_DIR" ]]; then
      unique+=("$pid")
    fi
  done
  echo "${unique[@]:-}"
}

alive_pids() {
  # Echo back only PIDs that are currently alive
  local result=() pid
  for pid in "$@"; do
    if sudo kill -0 "$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then
      result+=("$pid")
    fi
  done
  echo "${result[@]:-}"
}

stop_server() {
  local pids running=() pid
  pids=$(pids_for_server)

  # Build list of actually running PIDs (avoid noisy "No such process")
  if [[ -n "$pids" ]]; then
    for pid in $pids; do
      if sudo kill -0 "$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then
        running+=("$pid")
      fi
    done
  fi

  if [[ ${#running[@]} -eq 0 ]]; then
    log "No running mediasoup server process found"
    return 0
  fi

  log "Stopping mediasoup server PIDs: ${running[*]}"
  for pid in "${running[@]}"; do
    sudo kill "$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done

  # Wait up to 10s for graceful shutdown
  for _ in {1..10}; do
    sleep 1
    local still=()
    for pid in "${running[@]}"; do
      if sudo kill -0 "$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then
        still+=("$pid")
      fi
    done
    running=("${still[@]}")
    [[ ${#running[@]} -eq 0 ]] && break || true
  done

  if [[ ${#running[@]} -gt 0 ]]; then
    log "Force killing PIDs: ${running[*]}"
    for pid in "${running[@]}"; do
      sudo kill -9 "$pid" 2>/dev/null || kill -9 "$pid" 2>/dev/null || true
    done
  fi
  log "Server stopped"
}

start_server() {
  # Prevent accidental double-start
  local existing
  existing=$(pids_for_server)
  existing=( $(alive_pids $existing) )
  if [[ ${#existing[@]} -gt 0 ]]; then
    log "Server already running (PIDs: ${existing[*]}); use ./serverctl.sh restart to restart"
    return 0
  fi
  log "Starting mediasoup server in background (logs: $LOG_FILE)"
  # Ensure log file exists and is writable for this user
  touch "$LOG_FILE" || true

  local node_cmd
  node_cmd=$(find_node || true)
  if [[ -z "$node_cmd" ]]; then
    log "Failed to locate node in PATH or NVM installation. Install Node.js and retry."
    return 1
  fi

  if needs_root; then
    # Preserve env and working dir; run as root to bind privileged ports
    sudo -E nohup bash -lc "cd '$SCRIPT_DIR' && '$node_cmd' server.js" >>"$LOG_FILE" 2>&1 &
  else
    nohup "$node_cmd" server.js >>"$LOG_FILE" 2>&1 &
  fi
  # Give it a moment to spawn
  sleep 2
  local pids
  pids=$(pids_for_server)
  if [[ -n "$pids" ]]; then
    log "Server started with PIDs: $pids"
  else
    log "Failed to start server. Check logs at $LOG_FILE"
    return 1
  fi
}

status_server() {
  local pids
  pids=$(pids_for_server)
  pids=$(alive_pids $pids)
  if [[ -z "$pids" ]]; then
    echo "Server status: not running"
  else
    echo "Server status: running (PIDs: $pids)"
    ps -o pid,ppid,stat,etime,cmd -p $pids || true
  fi
  echo
  echo "Listening ports (requires sudo for details):"
  if command -v ss >/dev/null 2>&1; then
    sudo ss -ltnp | grep -E ":(3000|3443|443)\s" || true
  else
    sudo netstat -ltnp | grep -E ":(3000|3443|443)\s" || true
  fi
}

main() {
  load_env
  local cmd="${1:-}"
  case "$cmd" in
    start)   start_server ;;
    stop)    stop_server ;;
    restart) stop_server; start_server ;;
    status)  status_server ;;
    "")     echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
    *)       echo "Unknown command: $cmd"; echo "Usage: $0 {start|stop|restart|status}"; exit 1 ;;
  esac
}

main "$@"
