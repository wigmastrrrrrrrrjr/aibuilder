import { Hono } from 'hono';
import { store } from './store.js';
import { FileStreamer } from './parser.js';
import { systemPrompt, workspaceSystemPrompt } from './prompt.js';
import { extractKey, builtinKey, localOllamaUrl, openrouterKey, extractPuterToken } from './keys.js';
import { getVar } from './env.js';
import { getUser, canWrite } from './auth.js';
import { createClient } from '@supabase/supabase-js';
import { effortLevel, EFFORT, modelCost, creditsToUnits, unitsToCredits } from './models.js';
import { personalBalance } from './credits.js';
import { executeTool, createMemoryStore } from './tools.js';
import { terminalEnabled, mirrorToTerminal, readTerminalFiles, diffTerminal } from './terminal.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const PUTER_URL = 'https://api.puter.com/drivers/call';
const MISTRAL_MODEL = 'mistral-small-latest';
const MODEL_RE = /^[A-Za-z0-9._:/+%-]{1,64}$/;
const SUB_AGENT_PROMPT = `You are a sub-agent of AIBuilder, an expert engineer, working on ONE file as part of a larger web app that another engineer is building.
Respond with a single tool call that writes your assigned file, in EXACTLY this format:
>>>tool
{"name":"write_file","arguments":{"path":"the/assigned/path.ext","content":"complete, polished file content"}}
<<<
Rules:
- Write EXACTLY the assigned file. Do not invent other files, do not edit or delete anything.
- Use only the write_file tool, exactly once. No other tools.
- Do not explain or narrate. Match the app's existing style and conventions.
- The file must be complete and self-contained so it works on its own. abide by these or you will be terminated by the host AI`;

// Sub-agents only use the free OpenRouter models (all rate-limited). If one
// answers with 429 we skip it and try the next until one responds.
const OR_SUB_MODELS = [
  'z-ai/glm-5.2:free',
  'z-ai/glm-4.5-flash:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-32b:free',
  'deepseek/deepseek-r1-distill-qwen-32b:free',
  'moonshotai/kimi-k2-instruct:free',
  'openrouter/auto:free',
];
const active = { mistral: 0, ollama: 0, local: 0, openrouter: 0 };
let subRound = 0;

// Format a run_command result so the model can see what it ran AND what came
// back. The browser gets the `cmd` SSE event, but the transcript only ever
// recorded the model's own text — command outputs were invisible to the AI on
// the next round/turn. Cap each entry to keep context small.
const TERM_LOG_BUDGET = 2500;
function cmdTranscript(c) {
  const out = String(c.output ?? '').slice(0, TERM_LOG_BUDGET);
  const tail = out.length === TERM_LOG_BUDGET ? '\n…(output truncated)' : '';
  const code = c.code != null ? ` (exit ${c.code})` : '';
  const err = c.error ? `\nERROR: ${String(c.error).slice(0, 300)}` : '';
  return `$ ${c.command}${code}\n${out}${tail}${err}`;
}

// Mirror the DB's files into the terminal sandbox before a build round and
// return the snapshot { path -> content } used to reconcile afterwards.
// Returns null when the terminal is disabled (built-in tools are the fallback).
async function termMirror(store, pid) {
  if (!terminalEnabled()) return null;
  let files = [];
  try { files = await store.listFilesWithContent(pid); } catch { files = []; }
  return mirrorToTerminal(pid, Array.isArray(files) ? files : []);
}

// Read the sandbox back after a round, diff against the snapshot, and write any
// terminal-made changes into the DB. Returns { created, updated, deleted }.
async function termSyncToStore(store, pid, snapshot) {
  if (!snapshot) return { created: [], updated: [], deleted: [], changed: 0 };
  let blobs = null;
  try { blobs = await readTerminalFiles(pid, snapshot); } catch { blobs = null; }
  if (!blobs) return { created: [], updated: [], deleted: [], changed: 0 };
  const d = diffTerminal(blobs, snapshot);
  for (const f of d.created) await store.saveFile(pid, f.path, f.content).catch(() => {});
  for (const f of d.updated) await store.saveFile(pid, f.path, f.content).catch(() => {});
  for (const p of d.deleted) await store.deleteFile(pid, p).catch(() => {});
  return d;
}

export const chat = new Hono();

// Charge the user's credit balance for paid effort tiers (Deep/Deepest).
// Returns null on success, or a { error, credits } rejection body. BYOK and
// local-tunnel requests are free — the user supplies the compute themselves.
async function chargeEffort(user, model, effort) {
  const cfg = EFFORT[effort] || EFFORT[2];
  if (!cfg.creditMult) return null;
  const cost = modelCost(model) * cfg.creditMult;
  const units = creditsToUnits(cost);
  const day = new Date().toISOString().slice(0, 10);
  const bal = await personalBalance(user, day);
  if (bal.leftUnits < units) {
    return {
      error: `${cfg.label} mode costs ${cost} credit${cost === 1 ? '' : 's'} and you have ${bal.leftCredits} left. Standard mode is free — or earn credits by publishing apps and getting visits, or bring your own Ollama API key (🔑).`,
      credits: {
        total: bal.totalCredits,
        used: unitsToCredits(bal.spent) + unitsToCredits(bal.earned),
        left: bal.leftCredits,
        day,
      },
    };
  }
  const dailyLeft = Math.max(0, bal.totalUnits - bal.spent);
  if (dailyLeft >= units) {
    await store.spendCredits(user.id, day, units);
  } else {
    await store.spendCredits(user.id, day, dailyLeft);
    await store.spendEarnings(user.name, units - dailyLeft);
  }
  return null;
}

// Shared pre-flight for one generation turn. The Worker route calls this for a
// local run; the terminal daemon calls it for an offloaded run. It resolves the
// API key, project, presence, model, credits and file context and records the
// user message. Returns { error, status } to reject, or the run context.
export async function prepareChat({ user, body, message, apiKey, sid, key: forcedKey, ownKey: forcedOwnKey, puterToken }) {
  // BYOK: a user-supplied key (x-api-key header or body.apiKey) takes priority
  // over the built-in platform key. It is used for this request only.
  const headerKey = typeof apiKey === 'string' ? apiKey : '';
  const bodyKey = typeof body?.apiKey === 'string' ? body.apiKey : '';
  const puter = typeof puterToken === 'string' ? puterToken : extractPuterToken(apiKey, bodyKey);
  // A Puter model without a connected Puter account can't run (Puter bills the
  // user) — rather than nag for a login, fall back to the platform's default
  // free model so the build still goes through.
  if (typeof body?.model === 'string' && body.model.startsWith('puter/') && !puter) {
    body = { ...body, model: 'gpt-oss:120b' };
  }
  const isLocalModel = typeof body.model === 'string' && body.model.startsWith('local:');
  const isPuterModel = typeof body.model === 'string' && body.model.startsWith('puter/');
  const ownKey = typeof forcedOwnKey === 'boolean' ? forcedOwnKey : Boolean(extractKey(headerKey, bodyKey));
  const key = forcedKey || extractKey(headerKey, bodyKey) || builtinKey();
  // Puter users supply the compute through their own account (user-pays), so
  // no built-in key is required and no platform credits are charged.
  if (!key && !isLocalModel && !isPuterModel) {
    return { error: { error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY/MISTRAL_API_KEY in .env' }, status: 500 };
  }
  {
    const reqOR = typeof body.model === 'string'
      && (body.model.includes('/') || body.model === 'openrouter/free');
    if (reqOR && !openrouterKey()) {
      return { error: { error: 'no OPENROUTER_API_KEY configured — set it to use OpenRouter free models' }, status: 500 };
    }
  }

  let pid = body.projectId;
  let project = null;
  if (pid) {
    project = await store.getProject(pid);
    if (!project) pid = null;
    else if (!(await canWrite(project, user))) return { error: { error: "you don't own this project" }, status: 403 };
  }
  if (!project) {
    // the owner names the project themselves — never name it after the prompt
    pid = (await store.createProject(undefined, user.name)).id;
  }

  // Concurrency cap: at most 10 people live on one project at once. Presence is
  // keyed per client (sid = browser tab), so 10 tabs/people = the working set.
  {
    const psid = String(sid || body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
    try {
      const pr = await store.touchPresence(pid, psid, user.name, Date.now());
      if (!pr.accepted) {
        return {
          error: {
            error: 'This project is at its 10-people live limit right now. Wait a moment for a spot, or open it read-only.',
            presence: { active: pr.active, limit: 10 },
          },
          status: 429,
        };
      }
    } catch { /* presence is best-effort */ }
  }

  // model precedence: request > stored on project > env default
  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || (project && MODEL_RE.test(project.model || '') ? project.model : '')
    || getVar('OLLAMA_MODEL') || 'gemma4:31b';

  // Chat is rate-limited only (3000 req/min per IP in app.js) — no per-request
  // credit cost. Credit balances are still tracked for the gift feature.
  await store.setModel(pid, model);

  // Effort: the user picks how hard the AI works. Deep/Deepest charge credits
  // (Standard and Fast stay free); platform-paid requests only — BYOK/local
  // requests get the longer generation for free since the user owns the compute.
  const effort = effortLevel(body.effort);
  if (!ownKey && !isLocalModel && !isPuterModel) {
    const chargeErr = await chargeEffort(user, model, effort);
    if (chargeErr) return { error: chargeErr, status: 402 };
  }

  const fileCtx = await buildFileContext(pid);
  await store.addMessage(pid, 'user', message, user.name);

  return { pid, model, effort, fileCtx, key, ownKey, isLocalModel, isPuterModel, puter, project };
}

// Run one generation turn: emits `meta`, streams tokens and tool events, and
// finishes with `done`. Host-agnostic — the Worker route passes a stream-backed
// emit and the request signal; the terminal daemon passes its run-buffer emit
// and a signal that only aborts on explicit cancel. The loop body below keeps
// its original indentation so the two hosts share one implementation.
export async function runChat(ctx) {
  const { body, message, pid, model, effort, fileCtx, key, signal, puter } = ctx;
  const send = typeof ctx.emit === 'function' ? ctx.emit : () => {};

  send({ type: 'meta', projectId: pid, model, effort: EFFORT[effort].label });
  const orKey = openrouterKey();

  let provider = 'ollama';
  const emit = (ev) => send(ev);

      const written = [];
      const edited = [];
      const deleted = [];
      const renamed = [];
      const assets = [];
      const seeds = [];
      const diag = [];          // operations that failed to apply — fed back to the model next turn
      const cmdLog = [];        // run_command results — fed back to the model next turn
      const subAgentTasks = []; // reused each round — cleared at round start
      let ops = 0;
      let inspected = 0;       // read/search/list ops this request (no-op guard)
      let noOpStrikes = 0;     // bounded extra attempts when a round does nothing
      let refactorSent = false;
      const maybeRefactor = () => {
        if (!refactorSent && (deleted.length >= 2 || edited.length >= 3 || ops >= 6)) {
          refactorSent = true;
          send({ type: 'refactor' });
        }
      };

      // Execute one tool call from the unified registry and surface it to the
      // client as the SSE event it already understands. Returns false when the
      // op really failed (errors are recorded for the repair round).
      const handleGen = async (call) => {
        if (!call || call.type !== 'tool') return true;
        const name = call.name;
        const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
        if (name === 'batch') {
          for (const sub of (Array.isArray(args.tools) ? args.tools : [])) {
            if (!(await handleGen({ ...(sub || {}), type: 'tool' }))) break;
          }
          return true;
        }
        const res = await executeTool(name, args, {
          store,
          pid,
          diag,
          emitContent: false,
          checkFreeze: true,
          cmdDiag: true,
          quarantine: (files) => quarantineSync(files, send),
          spawnSubAgent: (path, task) => { subAgentTasks.push(spawnSubAgent(path, task)); },
        });
        if (name === '_parse_error') {
          send({ type: 'warn', message: 'tool call could not be parsed — the model will retry it' });
          diag.push(`TOOL CALL REJECTED — the model emitted a >>>tool block the parser could not decode into a valid tool call (missing/invalid JSON, or no tool name). Do NOT narrate a description of the file — re-emit the exact call as valid JSON, e.g. {"name":"write_file","arguments":{"path":"...","content":"..."}} and nothing else. Raw fragment: ${String(args.raw || '').slice(0, 200)}`);
          return false;
        }
        const s = res.stat;
        if (s) {
          if (s.list === 'written') written.push(s.value);
          else if (s.list === 'edited') edited.push(s.value);
          else if (s.list === 'deleted') deleted.push(s.value);
          else if (s.list === 'renamed') renamed.push(s.value);
          else if (s.list === 'assets') assets.push(s.value);
          else if (s.list === 'seeds') seeds.push(s.value);
        }
        if (res.op) { ops += res.ops || 1; maybeRefactor(); }
        if (res.event) send(res.event);
        if ((name === 'run_command' || name === 'create_dedicated_server' || name === 'read_file' || name === 'search_files' || name === 'list_files' || name === 'glob' || name === 'web_search' || name === 'fetch_url') && typeof res.command === 'string') cmdLog.push(res);
        if (res.ok && (name === 'read_file' || name === 'search_files' || name === 'list_files' || name === 'glob' || name === 'web_search' || name === 'fetch_url')) inspected++;
        if (res.ok) return true;
        if (res.skipped) {
          if (!res.noWarn) send({ type: 'warn', message: res.error });
          return true;
        }
        const err = String(res.error || 'unknown error');
        if (!res.noWarn) send({ type: 'warn', message: `${name}: ${err}` });
        diag.push(`${name} failed: ${err}`);
        return false;
      };

      // Quarantine state: a project with a freeze-risk loop is "temporarily
      // disabled" — its preview serves a static blocker (no scripts can run)
      // until a fixing generation comes back clean. Stored in meta so it
      // survives reloads and is enforced server-side by the preview route.
      const quarantineSync = async (freezeFiles, evSend) => {
        try {
          if (freezeFiles && freezeFiles.length) {
            await store.metaSet('q:' + pid, JSON.stringify({ at: Date.now(), files: freezeFiles }));
            evSend({ type: 'freeze', files: freezeFiles });
          } else {
            await store.metaSet('q:' + pid, '');
            evSend({ type: 'unfreeze' });
          }
        } catch { /* quarantine is best-effort */ }
      };

      // Spin off a parallel sub-agent: a focused single-file generator that
      // runs concurrently with the main response and merges its write_file in.
      // Sub-agents always run through OpenRouter on free rate-limited models;
      // if a model responds 429 (rate-limited) we skip it and try another.
      const spawnSubAgent = async (subPath, task) => {
        if (!orKey) throw new Error('sub-agents need OpenRouter configured (OPENROUTER_API_KEY)');
        const msg = [
          { role: 'system', content: SUB_AGENT_PROMPT },
          { role: 'user', content: `Your one assigned file: ${subPath}\n\n` +
            `Task from the main engineer:\n${task}\n\n` +
            `Return ONLY a single >>>tool write_file call for ${subPath}.` },
        ];
        const sp = new FileStreamer();
        const evs = [];
        const d = new TextDecoder();
        let lb = '';
        for (let i = 0; i < OR_SUB_MODELS.length; i++) {
          const subModel = OR_SUB_MODELS[(subRound++ + i) % OR_SUB_MODELS.length];
          const r = await fetch(OPENROUTER_URL, {
            method: 'POST',
            signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
            headers: {
              Authorization: `Bearer ${orKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/wigmastrrrrrrrrjr/aibuilder',
              'X-Title': 'aibuilder',
            },
            body: JSON.stringify({ model: subModel, messages: msg, stream: true }),
          });
          if (r.status === 429) continue; // rate-limited — try a different model
          if (!r.ok) throw new Error(`openrouter ${r.status} on ${subModel}`);
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lb += d.decode(value, { stream: true });
            let nl;
            while ((nl = lb.indexOf('\n')) !== -1) {
              const line = lb.slice(0, nl).trim();
              lb = lb.slice(nl + 1);
              if (!line || line === 'data: [DONE]') continue;
              let j;
              try {
                const payload = line.startsWith('data: ') ? line.slice(6) : line;
                j = JSON.parse(payload);
              } catch { continue; }
              const tok = j?.choices?.[0]?.delta?.content ?? '';
              if (!tok) continue;
              for (const ev of sp.feed(tok)) {
                if (ev.type === 'tool' && ev.name === 'write_file') {
                  ev.arguments = { ...(ev.arguments || {}), path: subPath };
                  evs.push(ev);
                }
              }
            }
          }
          for (const ev of sp.flush()) {
            if (ev.type === 'tool' && ev.name === 'write_file') {
              ev.arguments = { ...(ev.arguments || {}), path: subPath };
              evs.push(ev);
            }
          }
          return { evs, provider: 'openrouter', model: subModel };
        }
        throw new Error('all sub-agent models are rate-limited right now — skipping this sub-agent');
      };

      // One "round" = one model generation plus its post-build checks. If the
      // build still has failing operations OR the AI is cut off mid-build by a
      // token/stream limit, the session keeps going and the AI is restarted to
      // continue EXACTLY where it stopped. History is cached in memory once
      // (not re-fetched from D1 each round) and appended to as rounds record.
      // MAX_ROUNDS is a soft cap on total rounds per request (env-tunable); the
      // build only fully stops when a round finishes cleanly or the cap is hit.
      const MAX_ROUNDS = Math.max(1, Number(getVar('MAX_BUILD_ROUNDS') || 12) || 12);
      const histRef = await store.history(pid).then(ms => ms.map(m => ({ role: m.role, content: m.content })));
      const buildGenMessages = () => [{ role: 'system', content: systemPrompt() + fileCtx }, ...histRef];
      const repairPrompt = () => {
        const parts = [];
        if (diag.length) parts.push('FAILED OPERATIONS (exact errors — fix every one):\n' + diag.map((x) => ' - ' + x).join('\n'));
        return parts.length
          ? 'The build still has failing operations. Do NOT stop and do NOT restate the problem — apply the exact fixes below, then keep building the app.\n\n' + parts.join('\n\n')
          : 'The build hit an error. Re-check the recent work and fix whatever is wrong, then keep building the app.';
      };

      let attempt = 0;
      let wantRepair = true;
      let wasCut = false;
      let noOp = false;
      while (wantRepair && attempt < MAX_ROUNDS && !signal.aborted) {
        attempt++;
        wantRepair = false;
        wasCut = false;
        noOp = false;
        const diagAtStart = diag.length;
        const opsAtStart = ops;
        const inspectedAtStart = inspected;
        subAgentTasks.length = 0;
        cmdLog.length = 0;
        let termSnap = null;
        termSnap = await termMirror(store, pid);
        const parser = new FileStreamer();

        let upstream;
        let providerUsed = null;
        try {
          ({ upstream, provider } = await openUpstream(model, buildGenMessages(), key, signal, emit, EFFORT[effort], puter));
        } catch (e) {
          if (!signal.aborted) send({ type: 'error', message: e.message });
          break;
        }
        providerUsed = provider;
        active[provider]++;
        try {
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let lineBuf = '';
          let raw = '';
          let finish = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, nl).trim();
              lineBuf = lineBuf.slice(nl + 1);
              if (!line || line === 'data: [DONE]') continue;
              let j;
              try {
                const payload = line.startsWith('data: ') ? line.slice(6) : line;
                j = JSON.parse(payload);
              } catch { continue; }
              let tok = '';
              if (provider === 'puter') {
                const fr = j?.finish_reason || j?.message?.finish_reason;
                if (fr) finish = fr;
                if (j?.done === true && !finish) finish = 'stop';
                tok = j?.text ?? j?.delta?.content ?? j?.message?.content ?? '';
              } else if (provider === 'mistral' || provider === 'openrouter') {
                const fr = j?.choices?.[0]?.finish_reason;
                if (fr) finish = fr;
                tok = j?.choices?.[0]?.delta?.content ?? '';
              } else {
                // ollama cloud + local ollama both use message.content
                const msg = j?.message ?? {};
                if (msg.thinking) send({ type: 'think', v: msg.thinking });
                if (j.done_reason) finish = j.done_reason;
                else if (j.done === true && !finish) finish = 'stop';
                tok = msg.content ?? '';
              }
              if (!tok) continue;
              raw += tok;
              send({ type: 'token', v: tok });
              for (const ev of parser.feed(tok)) {
                await handleGen(ev);
              }
            }
          }
          for (const ev of parser.flush()) {
            await handleGen(ev);
          }
          // Sub-agents merged in before judging this round's health.
          if (subAgentTasks.length) {
            const results = await Promise.allSettled(subAgentTasks);
            for (const res of results) {
              if (res.status === 'rejected') {
                send({ type: 'warn', message: `sub-agent failed: ${String(res.reason?.message || res.reason).slice(0, 200)}` });
                continue;
              }
              for (const ev of res.value.evs) {
                await handleGen(ev);
                send({ type: 'subagent', path: ev.arguments?.path || '', model, subModel: res.value.model, provider: res.value.provider });
              }
            }
          }
          // Two-way terminal sync: anything the AI created/changed/deleted with
          // shell commands (curl -o, git clone, sed -i, ...) is mirrored back
          // into the database so built-in tools + the preview see it too.
          if (termSnap) {
            const synced = await termSyncToStore(store, pid, termSnap);
            if (synced && synced.changed) {
              for (const f of synced.created) written.push(f.path);
              for (const f of synced.updated) edited.push(f.path);
              for (const p of synced.deleted) deleted.push(p);
              ops += synced.changed;
              send({ type: 'sync', created: synced.created.map((f) => f.path), updated: synced.updated.map((f) => f.path), deleted: synced.deleted });
            }
          }
          // Record the round WITH every new error so it reaches the AI before
          // the stream stops.
          if (diag.length > diagAtStart) wantRepair = true;
          if (!wantRepair && raw.trim()) {
            // The AI was cut off mid-build (token-limit/done_reason, or the
            // upstream died mid-tool-call without a finish signal). Instead of
            // stopping the build, restart it exactly where it stopped.
            const opens = (raw.match(/>>>tool/gi) || []).length;
            const closes = (raw.match(/^<<<$/gm) || []).length;
            if ((finish && finish !== 'stop') || opens > closes) {
              wasCut = true;
              wantRepair = true;
            }
          }
          // Silent build failure: the round changed NO file and inspected
          // NOTHING (no read/search/list). The user asked for work; the AI only
          // talked. That used to finish a "clean" build with no files created.
          // Kick it to actually act, bounded so pure questions can't loop.
          if (!wantRepair && raw.trim() && (ops - opsAtStart) === 0 && (inspected - inspectedAtStart) === 0 && noOpStrikes < 2) {
            noOpStrikes++;
            noOp = true;
            wantRepair = true;
          }
          if (wantRepair) send({ type: 'note', message: noOp
            ? 'The AI produced no file changes and did not inspect the project — the build needs real work. Restarting it for another attempt.'
            : wasCut
              ? 'Output limit reached — continuing so the AI can finish the build; it resumes exactly where it stopped.'
              : 'The build still has errors — continuing in this session so the AI can fix them right now.' });
          const roundDiag = diag.slice(diagAtStart);
          if (raw.trim()) {
            let recorded = raw;
            const notes = [];
            if (roundDiag.length) {
              notes.push('DIAGNOSTICS — these operations FAILED just now, so the app may be incomplete or broken. Fix them in your very next step using the exact errors above:\n' +
                roundDiag.map((x) => ' - ' + x).join('\n'));
            }
            if (wasCut) {
              notes.push('PLATFORM NOTE — you hit the output limit and were cut off mid-build. This message is frozen as-is. Do NOT repeat or restate anything already done — continue EXACTLY from the interruption and keep going until every file you planned is actually created.');
            }
            if (noOp) {
              notes.push('NO-OP DETECTED — this round created or changed ZERO files and did not even read/search the project. Talk is not building: if the user asked for work, you MUST emit write_file/edit_file/create_asset/run_command calls; if it was only a question, back it with read_file/search_files first.');
            }
            if (wantRepair && !wasCut && !noOp) {
              notes.push('REPAIR REQUIRED — the operations above still fail. Your next turn starts from this exact message and must fix every error listed here.');
            }
            if (notes.length) recorded += '\n\n' + notes.join('\n\n');
            if (cmdLog.length) recorded += '\n\nTERMINAL & FILE OPS — output of the commands, reads and searches you just ran:\n' + cmdLog.map(cmdTranscript).join('\n\n');
            await store.addMessage(pid, 'assistant', recorded);
            try { histRef.push({ role: 'assistant', content: recorded }); } catch {}
          }
          if (wantRepair) {
            const prompt = noOp
              ? 'NO-OP DETECTED — your previous round performed no file changes and did not inspect the project. If the user asked you to build or change something: actually do it NOW with write_file/edit_file/create_asset (or run_command) — create every requested file, no narration-only answers. If the user only asked a question, first inspect the real project with read_file/search_files/list_files and then answer. Do it now.'
              : wasCut
                ? 'PLATFORM NOTE — your previous output was cut off by the token limit before you finished. Do NOT recap, restate, apologise or repeat work already done. Resume EXACTLY where you stopped: finish the exact file/operation that was interrupted (read its real current state with read_file first if unsure), then continue the remaining steps until the whole build is complete.'
                : repairPrompt();
            await store.addMessage(pid, 'user', prompt);
            try { histRef.push({ role: 'user', content: prompt }); } catch {}
          }
          // Freeze-guard: quarantine lifts whenever this round wrote nothing
          // flagged as a freeze risk (the old clean page-test report used to
          // do this — page test is gone now, so do it inline).
          if (!roundDiag.some((x) => String(x).includes('freeze risk'))) {
            await quarantineSync([], send);
          }
        } catch (e) {
          if (!signal.aborted) send({ type: 'error', message: String(e.message || e) });
          wantRepair = false;
        } finally {
          if (providerUsed) { try { active[providerUsed]--; } catch {} }
        }
      }
  send({ type: 'done', projectId: pid, files: written, edited, deleted, renamed, assets, seeds, model });
  // co-build: tell everyone else watching this project that it changed
  try {
    const sbUrl = getVar('SUPABASE_URL') || 'https://trwxpgmkpaddnyktbleg.supabase.co';
    const sbKey = getVar('SUPABASE_SERVICE_KEY') || '';
    if (sbUrl && sbKey) {
      const sb = createClient(sbUrl, sbKey);
      const ch = sb.channel('build:' + pid);
      await ch.send({ type: 'broadcast', event: 'evt', payload: { type: 'refresh', sid: body.sid || '', files: written } });
      setTimeout(() => { try { sb.removeChannel(ch); } catch {} }, 100);
    }
  } catch { /* live layer is best-effort */ }
}

// ---- Worker route ----------------------------------------------------------
// Hand the turn to the local terminal daemon when it is configured. The daemon
// runs the generation as a detached background run and buffers every event, so
// a dropped Worker/client connection no longer loses the build: the client can
// re-attach with the same runId and catch up. Falls back to running here.
chat.post('/', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'sign in required' }, 401);

  const body = await c.req.json();
  const message = body?.message;
  if (!message || typeof message !== 'string') {
    return c.json({ error: 'message required' }, 400);
  }

  if (body?.mode === 'workspace') {
    return workspaceChat(c, body, message, user);
  }

  const off = await offloadChat(c, { user, body, message });
  if (off) return off;
  return localChat(c, { user, body, message });
});

// Run the turn inside this Worker (no daemon / daemon unreachable). No resumable
// buffer here, so a dropped connection ends the turn — the client is told so.
async function localChat(c, { user, body, message }) {
  const ac = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => ac.abort());

  const prep = await prepareChat({ user, body, message, apiKey: c.req.header('x-api-key'), sid: body.sid, puterToken: extractPuterToken(c.req.header('x-puter-token')) });
  if (prep.error) return c.json(prep.error, prep.status);

  const enc = new TextEncoder();
  const streamBody = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (ev) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`)); } catch { closed = true; }
      };
      send({ type: 'run', runId: null, resumable: false });
      try {
        await runChat({ ...prep, body, message, signal: ac.signal, emit: send });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(streamBody, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
}

// Forward the turn to the daemon when configured. Returns null to fall back.
async function offloadChat(c, { user, body, message }) {
  const base = String(getVar('TERMINAL_URL') || '').replace(/\/+$/, '');
  const token = String(getVar('TERMINAL_TOKEN') || '');
  if (!base || !token || getVar('LOCAL_TERMINAL')) return null;
  const apiKey = c.req.header('x-api-key') || '';
  const bodyKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  const ownKey = Boolean(extractKey(apiKey, bodyKey));
  const key = extractKey(apiKey, bodyKey) || builtinKey();
  try {
    const r = await fetch(`${base}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        origin: new URL(c.req.url).origin,
        runId: typeof body.runId === 'string' ? body.runId.slice(0, 64) : '',
        user: { id: user.id, name: user.name },
        body, message, apiKey, key, ownKey,
        puterToken: extractPuterToken(c.req.header('x-puter-token')),
      }),
    });
    if (!r.ok || !r.body) return null;
    return c.newResponse(r.body, 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
  } catch { return null; }
}

// Re-attach to a background run (the client lost its stream). Proxies the
// daemon's buffered event log from `since`, then streams live until done.
chat.get('/stream/:runId', async (c) => {
  const user = await getUser(c);
  if (!user) return c.json({ error: 'sign in required' }, 401);
  const base = String(getVar('TERMINAL_URL') || '').replace(/\/+$/, '');
  const token = String(getVar('TERMINAL_TOKEN') || '');
  if (!base || !token || getVar('LOCAL_TERMINAL')) return c.json({ error: 'no resumable runs' }, 404);
  const since = Math.max(0, Number(c.req.query('since') || 0) || 0);
  try {
    const url = `${base}/agent/stream/${encodeURIComponent(c.req.param('runId'))}?` +
      new URLSearchParams({ token, since: String(since), uid: user.id });
    const r = await fetch(url);
    if (!r.ok || !r.body) return c.json({ error: 'run not found' }, r.status === 404 ? 404 : 502);
    return c.newResponse(r.body, 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    });
  } catch (e) {
    return c.json({ error: `terminal unreachable: ${String(e?.message || e)}` }, 502);
  }
});

// ---- generator op helpers ---------------------------------------------------

async function openUpstream(model, messages, key, signal, emit, effortCfg, puter) {
  const mistralKey = getVar('MISTRAL_API_KEY') || '';
  const orKey = openrouterKey();
  const localUrl = await localOllamaUrl();
  const isLocalModel = typeof model === 'string' && model.startsWith('local:');
  const isPuterModel = typeof model === 'string' && model.startsWith('puter/');
  const localModel = isLocalModel ? model.slice(6) : model;
  const eff = effortCfg || EFFORT[2];
  const ollamaOpts = { num_predict: eff.tokens, num_ctx: eff.ctx };

  const tryOllama = async () => {
    const r = await fetch(OLLAMA_URL, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true, think: eff.think, options: ollamaOpts }),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}`);
    return { upstream: r, provider: 'ollama' };
  };

  const tryMistral = async () => {
    if (!mistralKey) throw new Error('no MISTRAL_API_KEY configured');
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MISTRAL_MODEL, messages, stream: true, max_tokens: eff.tokens }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`mistral ${r.status}: ${t.slice(0, 200)}`);
    }
    return { upstream: r, provider: 'mistral' };
  };

  const tryLocal = async () => {
    if (!localUrl) throw new Error('no LOCAL_OLLAMA_URL configured');
    const r = await fetch(`${localUrl}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: localModel, messages, stream: true, think: eff.think, options: ollamaOpts }),
    });
    if (!r.ok) throw new Error(`local ollama ${r.status}`);
    return { upstream: r, provider: 'local' };
  };

  const tryOpenRouter = async () => {
    if (!orKey) throw new Error('no OPENROUTER_API_KEY configured');
    const r = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: {
        Authorization: `Bearer ${orKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/wigmastrrrrrrrrjr/aibuilder',
        'X-Title': 'aibuilder',
      },
      body: JSON.stringify({ model, messages, stream: true, max_tokens: eff.tokens }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`openrouter ${r.status}: ${t.slice(0, 200)}`);
    }
    return { upstream: r, provider: 'openrouter' };
  };

  // Puter models run through the user's Puter account (user-pays): the app
  // passes that user's token along so Puter can bill them directly. Body
  // matches the current drivers/call contract (interface/driver/method/args).
  const tryPuter = async () => {
    if (!puter) throw new Error('sign in with Puter to use puter models');
    const pbody = {
        interface: 'puter-chat-completion',
        driver: 'ai-chat',
        method: 'complete',
        test_mode: false,
        args: { messages, model: isPuterModel ? model.slice('puter/'.length) : model, stream: true, temperature: 0.4, max_tokens: eff.tokens },
      };
    console.log('[puter] call drivers/call model=', pbody.args.model, 'messages=', JSON.stringify(messages).slice(0, 120));
    const r = await fetch(PUTER_URL, {
      method: 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(300000)]),
      headers: { Authorization: `Bearer ${puter}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(pbody),
    });
    console.log('[puter] drivers/call response status=', r.status);
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`puter ${r.status}: ${t.slice(0, 200)}`);
    }
    return { upstream: r, provider: 'puter' };
  };

  const isORModel = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
  if (isPuterModel) return tryPuter();
  if (isORModel) return tryOpenRouter();
  if (isLocalModel && localUrl) return tryLocal();
  try {
    return await tryOllama();
  } catch (e1) {
    if (emit) emit({ type: 'warn', message: `ollama failed (${e1.message}), trying mistral...` });
    try {
      return await tryMistral();
    } catch (e2) {
      if (emit) emit({ type: 'warn', message: `mistral failed (${e2.message}), trying local...` });
      try {
        return await tryLocal();
      } catch (e3) {
        throw new Error(`all providers down: ollama: ${e1.message}; mistral: ${e2.message}; local: ${e3.message}`);
      }
    }
  }
}

// Stateless "workspace" mode: the client uploads its current files, we send
// them (plus optional history) to the model, and stream ops back with FULL
// content so the client can apply edits to its own disk. No server-side
// project, no storage, no presence — the TUI is the source of truth.
const CTX_BUDGET_WS = 30000;

function buildWorkspaceContext(files) {
  if (!files.length) return '';
  const names = files.map((f) => f.path).join(', ');
  const prio = (p) => p === 'index.html' ? 0 : /\.(js|mjs|cjs|ts|tsx|jsx|py|rs|go|java|rb|sh|json|yml|yaml|toml|css|scss|html|vue|svelte)$/.test(p) ? 1 : 2;
  const parts = [`\n\n## Current state of the workspace`, `Files present: ${names}`];
  let budget = CTX_BUDGET_WS;
  for (const f of [...files].sort((a, b) => prio(a.path) - prio(b.path))) {
    if (budget <= 200) break;
    let c = String(f.content ?? '');
    if (c.length > budget) c = c.slice(0, budget) + '\n…(truncated)';
    budget -= c.length;
    parts.push(`--- ${f.path} ---\n${c}`);
  }
  return '\n' + parts.join('\n');
}

async function workspaceChat(c, body, message, user) {
  const files = Array.isArray(body.files) ? body.files.slice(0, 200) : [];
  const cleaned = [];
  const seen = new Set();
  for (const f of files) {
    const path = String(f?.path || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').trim();
    if (!path || path === '.' || path.includes('..') || seen.has(path)) continue;
    const content = typeof f?.content === 'string' ? f.content : '';
    if (content.length > 1024 * 1024) { continue; } // skip absurd files
    seen.add(path);
    cleaned.push({ path, content });
  }

  const isLocalModel = typeof body.model === 'string' && body.model.startsWith('local:');
  // No Puter account connected? Drop to the platform's default free model
  // instead of nagging for a login (see prepareChat).
  if (typeof body.model === 'string' && body.model.startsWith('puter/') && !extractPuterToken(c.req.header('x-puter-token'))) {
    body = { ...body, model: 'gpt-oss:120b' };
  }
  const isPuterModel = typeof body.model === 'string' && body.model.startsWith('puter/');
  const puter = extractPuterToken(c.req.header('x-puter-token'));
  const ownKey = Boolean(extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ));
  const key = extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ) || builtinKey();
  if (!key && !isLocalModel && !isPuterModel) {
    return c.json({ error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY/MISTRAL_API_KEY in .env' }, 500);
  }

  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || getVar('OLLAMA_MODEL') || 'gemma4:31b';

  const effort = effortLevel(body.effort);
  if (!ownKey && !isLocalModel && !isPuterModel) {
    const chargeErr = await chargeEffort(user, model, effort);
    if (chargeErr) return c.json(chargeErr, 402);
  }

  const history = Array.isArray(body.history) ? body.history.slice(-40) : [];

  const ac = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => ac.abort());
  const enc = new TextEncoder();

  const streamBody = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (ev) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch { closed = true; }
      };
      send({ type: 'meta', workspace: true, model, effort: EFFORT[effort].label });

      let provider = 'ollama';
      const emit = (ev) => send(ev);

      // in-memory store over the uploaded workspace, driven by the same registry
      const ws = createMemoryStore(cleaned);
      const written = [];
      const edited = [];
      const deleted = [];
      const renamed = [];
      const diag = [];
      const cmdLog = [];        // run_command results — fed back to the model next turn
      let ops = 0;
      let inspected = 0;       // read/search/list ops this request (no-op guard)
      let noOpStrikes = 0;     // bounded extra attempts when a round does nothing

      const handleGen = async (call) => {
        if (!call || call.type !== 'tool') return true;
        const name = call.name;
        const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
        if (name === 'batch') {
          for (const sub of (Array.isArray(args.tools) ? args.tools : [])) {
            if (!(await handleGen({ ...(sub || {}), type: 'tool' }))) break;
          }
          return true;
        }
        const res = await executeTool(name, args, {
          store: ws,
          pid: String(body.pid || '').slice(0, 40),
          diag,
          emitContent: true,
          checkFreeze: false,
          cmdDiag: false,
        });
        if (name === '_parse_error') {
          send({ type: 'warn', message: 'tool call could not be parsed — the model will retry it' });
          diag.push(`TOOL CALL REJECTED — the model emitted a >>>tool block the parser could not decode into a valid tool call (missing/invalid JSON, or no tool name). Do NOT narrate a description of the file — re-emit the exact call as valid JSON, e.g. {"name":"write_file","arguments":{"path":"...","content":"..."}} and nothing else. Raw fragment: ${String(args.raw || '').slice(0, 200)}`);
          return false;
        }
        if (res.stat) {
          const v = res.stat.value;
          if (res.stat.list === 'written') written.push(v);
          else if (res.stat.list === 'edited') edited.push(v);
          else if (res.stat.list === 'deleted') deleted.push(v);
          else if (res.stat.list === 'renamed') renamed.push(`${v.from} -> ${v.to}`);
        }
        if (res.op) ops++;
        if (res.event) send(res.event);
        if ((name === 'run_command' || name === 'create_dedicated_server' || name === 'read_file' || name === 'search_files' || name === 'list_files' || name === 'glob' || name === 'web_search' || name === 'fetch_url') && typeof res.command === 'string') cmdLog.push(res);
        if (res.ok && (name === 'read_file' || name === 'search_files' || name === 'list_files' || name === 'glob' || name === 'web_search' || name === 'fetch_url')) inspected++;
        if (res.ok || res.skipped) return true;
        const err = String(res.error || 'unknown error');
        if (!res.noWarn) send({ type: 'warn', message: `${name}: ${err}` });
        diag.push(`${name} failed: ${err}`);
        return false;
      };

      // Repair rounds: if the build is still failing, keep the session alive
      // and have the AI fix every logged error before we stop.
      const MAX_ROUNDS = Math.max(1, Number(getVar('MAX_BUILD_ROUNDS') || 12) || 12);
      const buildWsMessages = (transcript, userContent) => [
        { role: 'system', content: workspaceSystemPrompt() + buildWorkspaceContext(cleaned) },
        ...transcript,
        { role: 'user', content: userContent },
      ];
      const wsRepairPrompt = () => {
        const parts = [];
        if (diag.length) parts.push('FAILED OPERATIONS (exact errors — fix every one):\n' + diag.map((x) => ' - ' + x).join('\n'));
        return parts.length
          ? 'The build still has failing operations. Do NOT stop and do NOT restate the problem — apply the exact fixes below, then keep building.\n\n' + parts.join('\n\n')
          : 'The build hit an error. Re-check the recent work and fix whatever is wrong, then keep building.';
      };

      let attempt = 0;
      let wantRepair = true;
      let wasCut = false;
      let noOp = false;
      const termPid = String(body.pid || 'default').slice(0, 40);
      const transcript = history.slice(); // live transcript fed to the model each round
      while (wantRepair && attempt < MAX_ROUNDS && !ac.signal.aborted) {
        attempt++;
        wantRepair = false;
        wasCut = false;
        noOp = false;
        cmdLog.length = 0;
        const opsAtStart = ops;
        const inspectedAtStart = inspected;
        let termSnap = null;
        termSnap = await mirrorToTerminal(termPid, cleaned.map((f) => ({ path: f.path, content: f.content })));
        const diagAtStart = diag.length;
        const parser = new FileStreamer();
        let raw = '';
        let finish = '';
        let upstream;
        let providerUsed = null;
        try {
          ({ upstream, provider } = await openUpstream(model, buildWsMessages(transcript, attempt === 1 ? message : wsRepairPrompt()), key, ac.signal, emit, EFFORT[effort], puter));
        } catch (e) {
          if (!ac.signal.aborted) send({ type: 'error', message: e.message });
          break;
        }
        providerUsed = provider;
        active[provider]++;
        try {
          const reader = upstream.body.getReader();
          const dec = new TextDecoder();
          let lineBuf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lineBuf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = lineBuf.indexOf('\n')) !== -1) {
              const line = lineBuf.slice(0, nl).trim();
              lineBuf = lineBuf.slice(nl + 1);
              if (!line || line === 'data: [DONE]') continue;
              let j;
              try {
                const payload = line.startsWith('data: ') ? line.slice(6) : line;
                j = JSON.parse(payload);
              } catch { continue; }
              let tok = '';
              if (provider === 'puter') {
                const fr = j?.finish_reason || j?.message?.finish_reason;
                if (fr) finish = fr;
                if (j?.done === true && !finish) finish = 'stop';
                tok = j?.text ?? j?.delta?.content ?? j?.message?.content ?? '';
              } else if (provider === 'mistral' || provider === 'openrouter') {
                const fr = j?.choices?.[0]?.finish_reason;
                if (fr) finish = fr;
                tok = j?.choices?.[0]?.delta?.content ?? '';
              } else {
                const msg = j?.message ?? {};
                if (msg.thinking) send({ type: 'think', v: msg.thinking });
                if (j.done_reason) finish = j.done_reason;
                else if (j.done === true && !finish) finish = 'stop';
                tok = msg.content ?? '';
              }
              if (!tok) continue;
              raw += tok;
              send({ type: 'token', v: tok });
              for (const ev of parser.feed(tok)) await handleGen(ev);
            }
          }
          for (const ev of parser.flush()) await handleGen(ev);
          if (termSnap) {
            let blobs = null;
            try { blobs = await readTerminalFiles(termPid, termSnap); } catch { blobs = null; }
            if (blobs) {
              const synced = diffTerminal(blobs, termSnap);
              if (synced.changed) {
                for (const f of synced.created) {
                  await ws.saveFile(termPid, f.path, f.content).catch(() => {});
                  const i = cleaned.findIndex((x) => x.path === f.path);
                  if (i >= 0) cleaned[i] = { path: f.path, content: f.content }; else cleaned.push({ path: f.path, content: f.content });
                  written.push(f.path);
                }
                for (const f of synced.updated) {
                  await ws.saveFile(termPid, f.path, f.content).catch(() => {});
                  const i = cleaned.findIndex((x) => x.path === f.path);
                  if (i >= 0) cleaned[i] = { path: f.path, content: f.content };
                  edited.push(f.path);
                }
                for (const p of synced.deleted) {
                  await ws.deleteFile(termPid, p).catch(() => {});
                  const i = cleaned.findIndex((x) => x.path === p);
                  if (i >= 0) cleaned.splice(i, 1);
                  deleted.push(p);
                }
                ops += synced.changed;
                send({ type: 'sync', created: synced.created.map((f) => f.path), updated: synced.updated.map((f) => f.path), deleted: synced.deleted });
              }
            }
          }
          if (diag.length > diagAtStart) wantRepair = true;
          if (!wantRepair && raw.trim()) {
            // Token-limit (or mid-tool-call) cutoff: restart the build right
            // where it stopped instead of ending it.
            const opens = (raw.match(/>>>tool/gi) || []).length;
            const closes = (raw.match(/^<<<$/gm) || []).length;
            if ((finish && finish !== 'stop') || opens > closes) {
              wasCut = true;
              wantRepair = true;
            }
          }
          // Silent build failure: changed NO file and inspected NOTHING.
          if (!wantRepair && raw.trim() && (ops - opsAtStart) === 0 && (inspected - inspectedAtStart) === 0 && noOpStrikes < 2) {
            noOpStrikes++;
            noOp = true;
            wantRepair = true;
          }
          if (wantRepair) send({ type: 'note', message: noOp
            ? 'The AI produced no file changes and did not inspect the workspace — the build needs real work. Restarting it for another attempt.'
            : wasCut
              ? 'Output limit reached — continuing so the AI can finish the build; it resumes exactly where it stopped.'
              : 'The build still has errors — continuing in this session so the AI can fix them right now.' });
          if (raw.trim()) {
            let recorded = raw;
            const notes = [];
            const roundDiag = diag.slice(diagAtStart);
            if (roundDiag.length) notes.push('DIAGNOSTICS — these operations FAILED just now:\n' + roundDiag.map((x) => ' - ' + x).join('\n'));
            if (wasCut) notes.push('PLATFORM NOTE — you hit the output limit and were cut off mid-build. This message is frozen as-is. Do NOT repeat or restate anything already done — continue EXACTLY from the interruption and keep going until every file you planned is actually created.');
            if (noOp) notes.push('NO-OP DETECTED — this round created or changed ZERO files and did not even read/search the workspace. Talk is not building: if the user asked for work, emit write_file/edit_file/create_asset/run_command calls; if it was only a question, back it with read_file/search_files first.');
            if (wantRepair && !wasCut && !noOp) notes.push('REPAIR REQUIRED — the operations above still fail. Fix every error listed here.');
            if (notes.length) recorded += '\n\n' + notes.join('\n\n');
            if (cmdLog.length) recorded += '\n\nTERMINAL & FILE OPS — output of the commands, reads and searches you just ran:\n' + cmdLog.map(cmdTranscript).join('\n\n');
            transcript.push({ role: 'assistant', content: recorded });
          }
          if (wantRepair) transcript.push({ role: 'user', content: noOp
            ? 'NO-OP DETECTED — your previous round performed no file changes and did not inspect the workspace. If the user asked you to build or change something: actually do it NOW with write_file/edit_file/create_asset (or run_command) — create every requested change, no narration-only answers. If the user only asked a question, first inspect the real workspace with read_file/search_files/list_files and then answer. Do it now.'
            : wasCut
              ? 'PLATFORM NOTE — your previous output was cut off by the token limit before you finished. Do NOT recap, restate, apologise or repeat work already done. Resume EXACTLY where you stopped: finish the exact file/operation that was interrupted (read its real current state first if unsure), then continue the remaining steps until the whole build is complete.'
              : wsRepairPrompt() });
        } catch (e) {
          if (!ac.signal.aborted) send({ type: 'error', message: String(e.message || e) });
          wantRepair = false;
        } finally {
          if (providerUsed) { try { active[providerUsed]--; } catch {} }
        }
      }
      send({ type: 'done', files: written, edited, deleted, renamed, model, workspace: true, diagnostics: diag.slice(0, 12) });
      try { controller.close(); } catch {}
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(streamBody, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
}

// Give the model eyes on the current project: full file list plus contents
// of the most important files within a token budget.
const CTX_BUDGET = 20000;

async function buildFileContext(pid) {
  // One query instead of listFiles + one getFile per file (N+1).
  let files = [];
  try { files = await store.listFilesWithContent(pid); } catch { return ''; }
  if (!files || !files.length) return '';
  const names = files.map((f) => f.path).join(', ');
  const parts = [
    `\n\n## Current state of this project`,
    `Files present: ${names}`,
  ];
  const prio = (p) => (p === 'index.html' ? 0 : /\.js$/.test(p) ? 1 : /\.css$/.test(p) ? 2 : 3);
  let budget = CTX_BUDGET;
  for (const f of [...files].sort((a, b) => prio(a.path) - prio(b.path))) {
    if (budget <= 200) break;
    if (f.encoding && f.encoding !== 'utf8') continue;
    let c = String(f.content ?? '');
    if (!c) continue;
    if (c.length > budget) c = c.slice(0, budget) + '\n…(truncated)';
    budget -= c.length;
    parts.push(`--- ${f.path} ---\n${c}`);
  }
  return '\n' + parts.join('\n');
}
