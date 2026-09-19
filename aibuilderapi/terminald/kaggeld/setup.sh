#!/usr/bin/env bash
# One-time setup for the Kaggle remote terminal (kaggle agent).
#
# Run on the DEVICE (where your Kaggle API token lives) to store the token and
# print the steps to start the agent inside a Kaggle Notebook:
#
#   KAGGLE_API_TOKEN=KGAT_... bash kaggeld/setup.sh
#
# The token is written ONLY to ~/.kaggle/access_token (chmod 600) and is NEVER
# committed to the repo. It is used with Bearer auth on Kaggle's API and is the
# same value you paste as the notebook secret below (Kaggle's own secret store).
#
# After running, do the ONE-TIME notebook setup:
#   1. Create a Notebook on https://www.kaggle.com (Python, any dataset or none)
#      -> Settings -> Secrets -> add two notebook secrets:
#           KTERM_TOKEN   = <your Kaggle API token, same as ~/.kaggle/access_token>
#           RELAY_URL     = https://aibuilderapi.csomeone301.workers.dev
#   2. Internet must be enabled (Settings -> Internet -> On).
#   3. In a code cell, run:
#         %%bash
#         git clone --depth 1 https://github.com/wigmastrrrrrrrrjr/aibuilder /tmp/aib
#         cat > /tmp/run_agent.sh <<'EOF'
#         set -e
#         pip install -q requests
#         KTERM_TOKEN="$(python3 - <<'PY'
# from kaggle_secrets import UserSecretsClient
# import os
# print(UserSecretsClient().get_secret("KTERM_TOKEN"))
# PY
# )" KTERM_TOKEN_RELAY="$(python3 - <<'PY'
# from kaggle_secrets import UserSecretsClient
# import os
# print(UserSecretsClient().get_secret("RELAY_URL"))
# PY
# )" nohup python3 /tmp/aib/aibuilderapi/terminald/kaggeld/agent.py >> /tmp/agent.log 2>&1 &
#         EOF
#         sed -i "s/KTERM_TOKEN_RELAY=\"/RELAY_URL=\"/" /tmp/run_agent.sh
#         bash /tmp/run_agent.sh
#         sleep 4 && tail -5 /tmp/agent.log
#   Each notebook session has a time budget; keep a window open or schedule
#   recurrences. The builder falls back to the normal terminal when the agent is
#   idle (status check: https://aibuilderapi.csomeone301.workers.dev/api/kterm/status).

set -euo pipefail

[ -n "${KAGGLE_API_TOKEN:-}" ] || { echo "KAGGLE_API_TOKEN is required" >&2; exit 1; }

mkdir -p "$HOME/.kaggle"
umask 177
printf '%s' "$KAGGLE_API_TOKEN" > "$HOME/.kaggle/access_token"
chmod 600 "$HOME/.kaggle/access_token"

echo "token written to $HOME/.kaggle/access_token (chmod 600)"
echo "hex digest: $(printf '%s' "$KAGGLE_API_TOKEN" | sha256sum | cut -c1-16)"
echo
echo "Notebook setup: readonly the steps above. Add secrets KTERM_TOKEN and RELAY_URL,
enable Internet, and run the %%bash cell. agent.py polls /api/kterm for jobs."
echo "Health: curl https://aibuilderapi.csomeone301.workers.dev/api/kterm/status"