#!/usr/bin/env bash
# terminald bootstrap for a GratisVPS Starter Free VPS (or any Debian/Ubuntu box).
# Usage (as root on the VM):
#   bash bootstrap.sh 'SOME_LONG_SHARED_TOKEN' [port] [sandbox]
# Installs Node 20 + cloudflared, installs terminald as a systemd service,
# and prints the exact TERMINAL_URL/TERMINAL_TOKEN to use in the worker.

set -euo pipefail

TOKEN="${1:?usage: bash bootstrap.sh TOKEN [port] [sandbox]}"
PORT="${2:-3000}"
SANDBOX="${3:-/var/term/sandbox}"

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root: sudo bash bootstrap.sh '$TOKEN'"; exit 1
fi

echo "==> installing Node.js 20 LTS"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
fi
node -v

echo "==> installing cloudflared (for a free HTTPS tunnel)"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(. /etc/os-release && echo "$VERSION_CODENAME") main" > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -q >/dev/null
  apt-get install -y -q cloudflared >/dev/null
fi
cloudflared --version

echo "==> installing terminald"
mkdir -p /opt/terminald "$SANDBOX"
cp "$(dirname "$0")/server.mjs" /opt/terminald/server.mjs 2>/dev/null || cp /opt/terminald/server.mjs /opt/terminald/server.mjs
chmod +x /opt/terminald/server.mjs

cat > /etc/systemd/system/terminald.service <<EOF
[Unit]
Description=AI cloud terminal daemon
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node /opt/terminald/server.mjs $PORT $SANDBOX '$TOKEN'
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now terminald
sleep 1

echo "==> verifying local auth (expect 401 with bad token, 200 /status)"
curl -s -o /dev/null -w "status=%{http_code}\n" "http://127.0.0.1:$PORT/status"
curl -s -o /dev/null -w "bad-token=%{http_code}\n" -X POST "http://127.0.0.1:$PORT/exec" -H 'Content-Type: application/json' -d "{\"token\":\"wrong\",\"cmd\":\"id\"}"

SANDBOXED=$(hostname -I | awk '{print $1}')
echo
echo "============================================================"
echo "terminald is running on 127.0.0.1:$PORT"
echo
echo "NEXT STEPS (one-time, on this VM):"
echo "  1. cloudflared tunnel login"
echo "  2. cloudflared tunnel create aibuilder-term"
echo "  3. cloudflared tunnel route dns aibuilder-term aibuilder-term.YOUR-DOMAIN"
echo "     (or: cloudflared tunnel --url http://localhost:$PORT -> use the *.trycloudflare.com it prints)"
echo "  4. cloudflared tunnel run aibuilder-term  (keep it running / make a systemd unit)"
echo "     -> put locally: cloudflared tunnel --url http://127.0.0.1:$PORT"
echo
echo "Then set these in aibuilderapi/wrangler.toml and redeploy:"
echo "  TERMINAL_URL = \"https://<your-public-tunnel-url>\""
echo "  TERMINAL_TOKEN = \"$TOKEN\""
echo "============================================================"