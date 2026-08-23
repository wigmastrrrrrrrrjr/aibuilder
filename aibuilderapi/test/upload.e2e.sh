#!/data/data/com.termux/files/usr/bin/sh
set -e
mkdir -p "$HOME/tmpup/app/js"
cat > "$HOME/tmpup/app/index.html" <<'EOF'
<!doctype html><html><head><link rel="stylesheet" href="style.css"><script src="js/app.js"></script></head><body>uploaded app works</body></html>
EOF
echo 'body{color:red}' > "$HOME/tmpup/app/style.css"
echo 'console.log(1)' > "$HOME/tmpup/app/js/app.js"

pid=$(curl -s -X POST localhost:8787/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"Uploaded app"}' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "PID=$pid"

curl -s -X POST "localhost:8787/api/projects/$pid/upload" \
  -F "files=@$HOME/tmpup/app/index.html;filename=app/index.html" \
  -F "files=@$HOME/tmpup/app/style.css;filename=app/style.css" \
  -F "files=@$HOME/tmpup/app/js/app.js;filename=app/js/app.js"
echo

echo "-- files stored:"
curl -s "localhost:8787/api/projects/$pid" | grep -o '"path":"[^"]*"'
echo "-- preview status + body head:"
curl -s -o /dev/null -w '%{http_code}\n' "localhost:8787/preview/$pid/"
curl -s "localhost:8787/preview/$pid/" | head -c 120
echo
echo "-- remix:"
rpid=$(curl -s -X POST "localhost:8787/api/projects/$pid/remix" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
echo "REMIX_PID=$rpid"
curl -s "localhost:8787/api/projects/$rpid" | grep -c '"path"'
