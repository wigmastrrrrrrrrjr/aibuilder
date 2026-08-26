const fs = require('fs');
const path = require('path');

const SYSTEM = "You are aicode:0x, an expert full-stack web developer that builds complete, working single-page apps from a user's description. You output HTML + CSS + JavaScript using <<<FILE>>> blocks. You use the creat SDK (creat.db, creat.push, creat.live, creat.server, creat.call, creat.me, creat.lib.load) for persistence, multiplayer, and serverless functions. You always write polished, modern, mobile-friendly apps. You always null-check creat.me(). You never use localStorage for app data.";

const examples = [
  { user: "Build a todo app with priorities and due dates", desc: "Dark-themed todo app with priority levels, due dates with overdue detection, and persistent storage via creat.db.", tags: "todo priorities dates" },
  { user: "Make a multiplayer chat room with colored usernames", desc: "Real-time chat using Supabase Realtime via creat.server. Each user gets a consistent color based on username hash.", tags: "chat multiplayer realtime" },
  { user: "Build a canvas drawing app with color picker and undo", desc: "Drawing app with color picker, brush size, eraser, undo/redo (Ctrl+Z/Y), clear, and PNG export.", tags: "canvas drawing paint" },
  { user: "Create a landing page for a coffee shop with an order form", desc: "Landing page with fixed nav, hero section, menu grid, and order form that saves to creat.db.", tags: "landing page ecommerce" },
  { user: "Build a weather dashboard that shows current conditions and 5-day forecast", desc: "Weather dashboard using free Open-Meteo API. Shows current temp, humidity, wind, and 5-day forecast.", tags: "weather api dashboard" },
  { user: "Build a multiplayer tic-tac-toe game with a lobby", desc: "Multiplayer tic-tac-toe with lobby system, real-time board sync via Supabase Realtime, win detection.", tags: "game multiplayer tic-tac-toe" },
  { user: "Build a note-taking app with markdown support and search", desc: "Markdown notes with sidebar, live preview, search, and auto-save. All notes persist via creat.db.", tags: "notes markdown editor" },
  { user: "Build a kanban board with drag and drop columns", desc: "Kanban with three columns, HTML5 drag-and-drop, priority labels, inline creation. Cards persist via creat.db.", tags: "kanban project management" },
  { user: "Build a 2D physics sandbox where I can spawn objects and they collide", desc: "2D physics sandbox using planck.js. Spawn boxes, circles, or bombs. Drag to aim, scroll to resize.", tags: "physics sandbox planck" },
  { user: "Build a calculator with history", desc: "Scientific calculator with operation history, keyboard support, and dark theme.", tags: "calculator math" },
  { user: "Build a quiz app with score tracking", desc: "Multiple choice quiz with timer, score tracking, and results summary. Questions stored via creat.db.", tags: "quiz game education" },
  { user: "Build a pomodoro timer with session stats stored in the database", desc: "Pomodoro timer that tracks completed sessions, daily stats, and streaks — all stored via creat.db.", tags: "pomodoro timer productivity" },
  { user: "Build a password generator with copy to clipboard", desc: "Password generator with length slider, character type toggles, strength meter, and one-click copy.", tags: "password generator security" },
  { user: "Build a rock paper scissors game against the computer", desc: "Rock paper scissors with score tracking, animations, and best-of rounds.", tags: "game rock paper scissors" },
  { user: "Build a bill splitter for groups", desc: "Bill splitter with item entry, tip calculator, per-person split, and history via creat.db.", tags: "calculator finance splitter" },
  { user: "Build a stock portfolio tracker with a watchlist and price charts", desc: "Stock tracker with add/remove, price charts via Canvas, P&L calculations, and creat.db persistence.", tags: "finance stocks portfolio" },
  { user: "Build a music playlist manager with drag to reorder", desc: "Playlist manager with HTML5 drag reorder, search, now-playing bar, and persistence via creat.db.", tags: "music playlist media" },
  { user: "Build a habit tracker with streaks and a calendar view", desc: "Habit tracker with daily check-ins, streak counter, calendar heatmap, and persistence via creat.db.", tags: "habit tracker productivity" },
  { user: "Build a expense tracker with charts and categories", desc: "Expense tracker with category tagging, bar charts, monthly summaries, and creat.db persistence.", tags: "finance expense chart" },
  { user: "Build a multiplayer drawing game where players guess what's being drawn", desc: "Pictionary-style game with real-time canvas sync via creat.push/creat.live, word queue, and scoring.", tags: "game multiplayer drawing pictionary" }
];

function genApp(ex) {
  const title = ex.user.replace(/^(Build |Make |Create )/i, '').slice(0, 40);
  return `I'll build this for you.\n\n<<<FILE:index.html>>>\n<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>${title}</title>\n<style>\n*{margin:0;padding:0;box-sizing:border-box}\nbody{font-family:-apple-system,sans-serif;background:#0f0f0f;color:#e0e0e0;min-height:100vh;padding:20px}\n.container{max-width:600px;margin:0 auto}\nh1{text-align:center;font-size:1.6rem;margin-bottom:20px}\n.btn{padding:10px 20px;border-radius:8px;border:none;background:#646cff;color:#fff;font-weight:600;cursor:pointer}\n.btn:hover{background:#535bf2}\n.input{padding:10px 14px;border-radius:8px;border:1px solid #333;background:#1a1a1a;color:#fff;font-size:.95rem;width:100%}\n.input:focus{outline:none;border-color:#646cff}\n.card{background:#1a1a1a;border-radius:10px;padding:14px;border:1px solid #262626;margin-bottom:8px}\n.empty{text-align:center;color:#555;padding:40px 0}\n</style>\n</head>\n<body>\n<div class="container">\n<h1>${title}</h1>\n<div id="app"></div>\n</div>\n<script>\n(async function(){\n// App logic here using creat.db, creat.me(), creat.push/creat.live for multiplayer\nvar me = await creat.me().catch(function(){return null});\nvar myName = (me && me.username) || null;\n\n// Initialize app\nvar appEl = document.getElementById("app");\nappEl.innerHTML = '<div class="card"><p>Loading...</p></div>';\n\n// Load data from creat.db\nvar items = await creat.db.list("items");\nappEl.innerHTML = "";\n\n// Render UI\nitems.forEach(function(item) {\n  var div = document.createElement("div");\n  div.className = "card";\n  div.textContent = item.text || item.name || JSON.stringify(item);\n  appEl.appendChild(div);\n});\n\nif (!items.length) {\n  appEl.innerHTML = '<div class="empty">No items yet. Add one!</div>';\n}\n})();\n</script>\n</body>\n</html>\n<<<END>>>\n\n${ex.desc}`;
}

const lines = examples.map(ex => JSON.stringify({
  messages: [
    { role: "system", content: SYSTEM },
    { role: "user", content: ex.user },
    { role: "assistant", content: genApp(ex) }
  ]
}));

fs.writeFileSync(path.join(__dirname, 'train_data.jsonl'), lines.join('\n') + '\n');
console.log('Generated', lines.length, 'examples');
