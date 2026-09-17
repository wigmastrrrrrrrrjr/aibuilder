#!/usr/bin/env bash
# terminald + serveo tunnel supervisor (Ubuntu/proot or any box with ssh).
#
# Keeps the local terminal daemon and a serveo SSH reverse tunnel alive,
# reconnecting both automatically. Run it in tmux/nohup for persistence.
#
# Usage:
#   SUBDOMAIN=aibuilder-term bash serveo.sh
#
# Env:
#   SUBDOMAIN  requested serveo subdomain (default: aibuilder-term)
#   PORT       local daemon port (default: 3000)
#   SANDBOX    daemon sandbox dir (default: ~/.aibuilder/term-sandbox)
#   KEY        ssh private key (default: ~/.ssh/id_ed25519)
#   TERMINAL_TOKEN  shared secret; generated into STATE/terminal-token if unset
#   STATE      state/log dir (default: ~/.aibuilder)
#
# One-time: register the key with serveo (login with Google/GitHub):
#   ssh -R aibuilder-term:80:localhost:3000 serveo.net
#   -> follow the https://console.serveo.net/ssh/keys?add=... it prints

set -uo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-3000}"
SUBDOMAIN="${SUBDOMAIN:-aibuilder-term}"
SANDBOX="${SANDBOX:-$HOME/.aibuilder/term-sandbox}"
KEY="${KEY:-$HOME/.ssh/id_ed25519}"
STATE="${STATE:-$HOME/.aibuilder}"
TOKEN_FILE="${TOKEN_FILE:-$STATE/terminal-token}"
LOG="$STATE/serveo.log"

mkdir -p "$STATE" "$SANDBOX"

if [ -z "${TERMINAL_TOKEN:-}" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    TERMINAL_TOKEN="$(cat "$TOKEN_FILE")"
  else
    TERMINAL_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
    printf '%s' "$TERMINAL_TOKEN" > "$TOKEN_FILE"
    chmod 600 "$TOKEN_FILE"
  fi
fi
export TERMINAL_TOKEN

command -v node >/dev/null 2>&1 || { echo "node not found in PATH" >&2; exit 1; }
command -v ssh  >/dev/null 2>&1 || { echo "ssh not found in PATH"  >&2; exit 1; }
[ -f "$KEY" ] || { echo "ssh key not found: $KEY (run: ssh-keygen -t ed25519)" >&2; exit 1; }

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

daemon_loop() {
  while true; do
    log "terminald: starting on :$PORT (sandbox=$SANDBOX)"
    PORT="$PORT" SANDBOX="$SANDBOX" TERMINAL_TOKEN="$TERMINAL_TOKEN" \
      node "$DIR/server.mjs" >>"$LOG" 2>&1
    log "terminald: exited, restarting in 3s"
    sleep 3
  done
}

tunnel_loop() {
  while true; do
    log "serveo: connecting -R $SUBDOMAIN:80:localhost:$PORT"
    ssh -i "$KEY" \
      -o StrictHostKeyChecking=accept-new \
      -o ServerAliveInterval=20 -o ServerAliveCountMax=3 \
      -o TCPKeepAlive=yes -o ExitOnForwardFailure=yes \
      -R "$SUBDOMAIN:80:localhost:$PORT" serveo.net 2>&1 | tee -a "$LOG"
    log "serveo: tunnel dropped, reconnecting in 5s"
    sleep 5
  done
}

daemon_loop >>"$LOG" 2>&1 &
DPID=$!
cleanup() {
  log "shutting down"
  kill "$DPID" 2>/dev/null
  pkill -P "$DPID" 2>/dev/null
  pkill -f "$DIR/server.mjs" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

tunnel_loop
