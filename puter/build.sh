#!/bin/sh
# Build and deploy Puter worker.
# Reads secrets from .env, injects them into puter-worker.js, deploys.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f .env ]; then
  echo "ERROR: .env file not found. Copy .env.example to .env and fill in secrets."
  exit 1
fi

# Source .env
. .env

# Build the worker by replacing placeholders
WORKER="puter-worker.js"
BUILT=".built-worker.js"

sed \
  -e "s|INJECT_SB_URL|$SB_URL|g" \
  -e "s|INJECT_SB_KEY|$SB_KEY|g" \
  -e "s|INJECT_OLLAMA_URL|$OLLAMA_URL|g" \
  -e "s|INJECT_OLLAMA_KEY|$OLLAMA_KEY|g" \
  -e "s|INJECT_OLLAMA_MODEL|$OLLAMA_MODEL|g" \
  -e "s|INJECT_OPENROUTER_KEY|$OPENROUTER_KEY|g" \
  "$WORKER" > "$BUILT"

echo "Built $BUILT with secrets injected."

# Deploy
WORKER_NAME="${1:-aib-api}"
echo "Deploying to Puter as '$WORKER_NAME'..."
puter worker deploy "$BUILT" "$WORKER_NAME"

rm -f "$BUILT"
echo "Done!"
