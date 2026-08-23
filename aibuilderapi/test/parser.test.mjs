import { FileStreamer } from '../src/parser.js';

const p = new FileStreamer();
let evs = [];
const chunks = [
  'Plan: todo app.\n',
  '<<<FI', 'LE:index.ht', 'ml>>>\n',
  '<html><body>hi</body></html>\n',
  '<<<END', '>>> Now css:\n',
  '```css\n<<<FILE:style.css>>>\nbody{margin:0}\n<<<END>>>\n',
  'truncated file without end <<<FILE:broken.js>>> console.log(1)',
];
for (const c of chunks) evs.push(...p.feed(c));
evs.push(...p.flush());

console.log(JSON.stringify(evs, null, 1));

const files = evs.filter(e => e.type === 'file');
const ok =
  files[0]?.path === 'index.html' &&
  files[0]?.content === '<html><body>hi</body></html>' &&
  files[1]?.path === 'style.css' &&
  files[1]?.content === 'body{margin:0}' &&
  files[2]?.path === 'broken.js' &&
  files[2]?.truncated === true;
console.log(ok ? 'PARSER OK' : 'PARSER FAIL');
process.exit(ok ? 0 : 1);
