#!/data/data/com.termux/files/usr/bin/sh
# Probe which Ollama Cloud models the built-in key can actually run.
KEY=$(grep '^OLLAMA_API_KEY=' "$HOME/aibuilder/.env" | cut -d= -f2)
for m in gemma4:31b gpt-oss:20b gpt-oss:120b deepseek-v4-flash:0731 \
         deepseek-v4-flash:preview nemotron-3-nano:30b nemotron-3-super \
         minimax-m2.7 glm-5.1 qwen3.5:397b kimi-k2.6; do
  code=$(curl -s -o /tmp/probe.out -w '%{http_code}' -m 60 \
    https://ollama.com/api/chat \
    -H "Authorization: Bearer $KEY" \
    -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"stream\":false,\"options\":{\"num_predict\":5}}")
  if [ "$code" = "200" ]; then
    echo "OK    $m"
  else
    echo "FAIL  $m  (HTTP $code: $(head -c 80 /tmp/probe.out))"
  fi
done
