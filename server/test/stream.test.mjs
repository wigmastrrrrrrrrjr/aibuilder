import fs from 'node:fs';

const key = process.env.OLLAMA_API_KEY
  || fs.readFileSync('/data/data/com.termux/files/home/aibuilder/.env', 'utf8')
      .match(/OLLAMA_API_KEY=(.*)/)[1].trim();

const t = Date.now();
const res = await fetch('https://ollama.com/api/chat', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-oss:120b',
    messages: [{ role: 'user', content: 'reply with just OK' }],
    stream: true,
  }),
});
console.log('status', res.status, Date.now() - t + 'ms');

const reader = res.body.getReader();
const dec = new TextDecoder();
let n = 0;
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  n += value.length;
  if (n < 1200) process.stdout.write(dec.decode(value));
}
console.log('\nbytes', n, Date.now() - t + 'ms');
