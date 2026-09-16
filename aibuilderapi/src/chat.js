import { Hono } from 'hono';
import { store } from './store.js';
import { FileStreamer } from './parser.js';
import { systemPrompt, workspaceSystemPrompt } from './prompt.js';
import { extractKey, builtinKey, localOllamaUrl, openrouterKey } from './keys.js';
import { getVar } from './env.js';
import { getUser, canWrite } from './auth.js';
import { createClient } from '@supabase/supabase-js';
import { effortLevel, EFFORT, modelCost, creditsToUnits, unitsToCredits } from './models.js';
import { personalBalance } from './credits.js';
import { execCommand, terminalEnabled } from './terminal.js';
import { pageTest, reportToText, scriptFreezeRisks } from './smoketest.js';

const OLLAMA_URL = 'https://ollama.com/api/chat';
const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';
const MODEL_RE = /^[A-Za-z0-9._:/+%-]{1,64}$/;
const SUB_AGENT_PROMPT = `You are a sub-agent of AIBuilder, an expert engineer, working on ONE file as part of a larger web app that another engineer is building.
Respond with a single generator block that writes your assigned file:
<<<FILE:path>>>
complete, polished file content
<<<END>>>
Rules:
- Write EXACTLY the assigned file. Do not invent other files, do not edit or delete anything.
- Do not use EDIT, DELETE, PLAN, NAME or DELEGATE blocks. Only one FILE block.
- Do not explain or narrate. Match the app's existing style and conventions.
- The file must be complete and self-contained so it works on its own. abide by these or you will be terminated by the host AI`;

const SUB_LOCAL_MODEL = 'tinyllama:1.1b';
const OR_SUB_MODEL = 'z-ai/glm-5.2:free';
const PROVIDER_CAPS = { mistral: 4, ollama: 4, local: 4, openrouter: 4 };
const active = { mistral: 0, ollama: 0, local: 0, openrouter: 0 };
let subRound = 0;

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

  // BYOK: a user-supplied key (x-api-key header or body.apiKey) takes priority
  // over the built-in platform key. It is used for this request only.
  const isLocalModel = typeof body.model === 'string' && body.model.startsWith('local:');
  const ownKey = Boolean(extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ));
  const key = extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ) || builtinKey();
  if (!key && !isLocalModel) {
    return c.json({ error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY/MISTRAL_API_KEY in .env' }, 500);
  }
  {
    const reqOR = typeof body.model === 'string'
      && (body.model.includes('/') || body.model === 'openrouter/free');
    if (reqOR && !openrouterKey()) {
      return c.json({ error: 'no OPENROUTER_API_KEY configured — set it to use OpenRouter free models' }, 500);
    }
  }

  let pid = body.projectId;
  let project = null;
  if (pid) {
    project = await store.getProject(pid);
    if (!project) pid = null;
    else if (!(await canWrite(project, user))) return c.json({ error: "you don't own this project" }, 403);
  }
  if (!project) {
    // the owner names the project themselves — never name it after the prompt
    pid = (await store.createProject(undefined, user.name)).id;
  }

  // Concurrency cap: at most 10 people live on one project at once. Presence is
  // keyed per client (sid = browser tab), so 10 tabs/people = the working set.
  {
    const sid = String(body.sid || '').trim().slice(0, 64) || `cli:${crypto.randomUUID().slice(0, 12)}`;
    try {
      const pr = await store.touchPresence(project.id, sid, user.name, Date.now());
      if (!pr.accepted) {
        return c.json({
          error: 'This project is at its 10-people live limit right now. Wait a moment for a spot, or open it read-only.',
          presence: { active: pr.active, limit: 10 },
        }, 429);
      }
    } catch { /* presence is best-effort */ }
  }

  // model precedence: request > stored on project > env default
  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || (project && MODEL_RE.test(project.model || '') ? project.model : '')
    || getVar('OLLAMA_MODEL') || 'gemma4:31b';
  const isORModel = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
  const orKey = openrouterKey();

  // Chat is rate-limited only (3000 req/min per IP in app.js) — no per-request
  // credit cost. Credit balances are still tracked for the gift feature.
  await store.setModel(pid, model);

  // Effort: the user picks how hard the AI works. Deep/Deepest charge credits
  // (Standard and Fast stay free); platform-paid requests only — BYOK/local
  // requests get the longer generation for free since the user owns the compute.
  const effort = effortLevel(body.effort);
  if (!ownKey && !isLocalModel) {
    const chargeErr = await chargeEffort(user, model, effort);
    if (chargeErr) return c.json(chargeErr, 402);
  }

  const fileCtx = await buildFileContext(pid);
  await store.addMessage(pid, 'user', message, user.name);

  // Client-cancel propagates to the upstream request.
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
      send({ type: 'meta', projectId: pid, model, effort: EFFORT[effort].label });

      const mistralKey = getVar('MISTRAL_API_KEY') || '';
      const localUrl = await localOllamaUrl();

      let provider = 'ollama';
      const emit = (ev) => send(ev);

      const written = [];
      const edited = [];
      const deleted = [];
      const renamed = [];
      const assets = [];
      const seeds = [];
      const diag = [];          // operations that failed to apply — fed back to the model next turn
      const testReports = [];   // page-test reports — appended to each recorded round
      const subAgentTasks = []; // reused each round — cleared at round start
      let ops = 0;
      let refactorSent = false;
      let inBatch = false;
      const batchOps = [];
      const maybeRefactor = () => {
        if (!refactorSent && (deleted.length >= 2 || edited.length >= 3 || ops >= 6)) {
          refactorSent = true;
          send({ type: 'refactor' });
        }
      };

      // apply one generator op; returns an SSE event for the client
      const handleGen = async (ev) => {
        if (ev.type === 'batch') { inBatch = true; return; }
        if (ev.type === 'endbatch') { inBatch = false; await flushBatch(); return; }
        if (ev.batch && inBatch) { batchOps.push(ev); return; }
        if (ev.type === 'file' && ev.path) {
          await store.saveFile(pid, ev.path, ev.content);
          written.push(ev.path);
          ops++;
          maybeRefactor();
          if (scriptFreezeRisks(ev.content).length) {
            diag.push(`freeze risk detected in ${ev.path} (non-terminating loop) — the page is disabled until this is fixed.`);
            await quarantineSync([ev.path], send);
          }
          send({ type: 'file', path: ev.path });
        } else if (ev.type === 'edit' && ev.path) {
          const res = await applyEdit(pid, ev.path, ev.hunks || []);
          if (res.ok) {
            edited.push(ev.path);
            ops++;
            maybeRefactor();
            if (res.content && scriptFreezeRisks(res.content).length) {
              diag.push(`freeze risk detected in ${ev.path} (non-terminating loop) — the page is disabled until this is fixed.`);
              await quarantineSync([ev.path], send);
            }
            send({ type: 'edit', path: ev.path });
          } else {
            send({ type: 'warn', message: `edit failed on ${ev.path}: ${res.error}` });
            diag.push(`edit failed on ${ev.path}: ${res.error}`);
          }
        } else if (ev.type === 'delete' && ev.path) {
          try {
            await store.deleteFile(pid, ev.path);
            deleted.push(ev.path);
            ops++;
            maybeRefactor();
            send({ type: 'delete', path: ev.path });
          } catch (e) {
            send({ type: 'warn', message: `delete failed on ${ev.path}: ${e.message}` });
            diag.push(`delete failed on ${ev.path}: ${e.message}`);
          }
        } else if (ev.type === 'rename' && ev.from && ev.to) {
          try {
            const refs = await applyRename(pid, ev.from, ev.to);
            renamed.push({ from: ev.from, to: ev.to });
            ops += 1 + refs;
            maybeRefactor();
            send({ type: 'rename', from: ev.from, to: ev.to, refs });
          } catch (e) {
            send({ type: 'warn', message: `rename failed: ${String(e.message || e)}` });
            diag.push(`rename failed: ${String(e.message || e)}`);
          }
        } else if (ev.type === 'asset' && ev.path) {
          try {
            await store.saveFile(pid, ev.path, ev.data, ev.encoding);
            assets.push(ev.path);
            ops++;
            maybeRefactor();
            if ((!ev.encoding || ev.encoding === 'utf8') && scriptFreezeRisks(ev.data || '').length) {
              diag.push(`freeze risk detected in asset ${ev.path} (non-terminating loop) — the page is disabled until this is fixed.`);
              await quarantineSync([ev.path], send);
            }
            send({ type: 'asset', path: ev.path, encoding: ev.encoding });
          } catch (e) {
            send({ type: 'warn', message: `asset failed on ${ev.path}: ${String(e.message || e)}` });
            diag.push(`asset failed on ${ev.path}: ${String(e.message || e)}`);
          }
        } else if (ev.type === 'seed' && ev.collection) {
          try {
            const n = await seedCollection(pid, ev.collection, ev.items || [], ev.clear);
            seeds.push({ collection: ev.collection, n });
            ops++;
            maybeRefactor();
            send({ type: 'seed', collection: ev.collection, count: n });
          } catch (e) {
            send({ type: 'warn', message: `seed failed on ${ev.collection}: ${String(e.message || e)}` });
            diag.push(`seed failed on ${ev.collection}: ${String(e.message || e)}`);
          }
        } else if (ev.type === 'cmd' && ev.command) {
          const command = String(ev.command).slice(0, 2000);
          if (!terminalEnabled()) {
            send({ type: 'warn', message: `command "${command.slice(0, 60)}" skipped — cloud terminal not configured yet` });
          } else {
            const res = await execCommand(pid, command);
            send({ type: 'cmd', command, enabled: true, ok: res.ok, code: res.code, output: res.output, error: res.error });
            if (!res.ok) diag.push(`command failed (exit ${res.code}): ${command.slice(0, 80)} — ${String(res.error || '').slice(0, 120)}`);
          }
        } else if (ev.type === 'plan') {
          try {
            await store.setPlan(pid, ev.items || []);
            send({ type: 'plan', items: ev.items || [] });
          } catch { /* plan is cosmetic */ }
        } else if (ev.type === 'name' && ev.name) {
          const nm = String(ev.name).trim().slice(0, 60);
          if (!nm) return;
          try {
            await store.rename(pid, nm);
            send({ type: 'name', name: nm, projectId: pid });
          } catch { /* cosmetic */ }
        } else if (ev.type === 'delegate' && ev.path) {
          const task = String(ev.task || '').trim();
          if (!task) return;
          if (subAgentTasks.length >= 4) {
            send({ type: 'warn', message: `sub-agent queue full — skipping delegate for ${ev.path}` });
            diag.push(`sub-agent for ${ev.path} was skipped (queue full)`);
            return;
          }
          send({ type: 'delegate', path: ev.path });
          subAgentTasks.push(spawnSubAgent(ev.path, task));
        } else if (ev.type === 'test') {
          await runPageTest(send, String(ev.note || ''));
        }
      };
      // apply a queued BATCH group atomically-ish (sequentially, abort on first failure)
      const flushBatch = async () => {
        if (!batchOps.length) return;
        const opsToApply = batchOps.slice();
        batchOps.length = 0;
        for (const ev of opsToApply) {
          try {
            await handleGen({ ...ev, batch: false });
          } catch (e) {
            send({ type: 'warn', message: `batch op failed: ${String(e.message || e)}` });
            break;
          }
        }
      };

      // Headless page test: resolve every reference the preview server would,
      // syntax-check every script, and report failures back to the model.
      const runPageTest = async (evSend, note) => {
        try {
          const files = await store.listFilesWithContent(pid);
          if (!Array.isArray(files) || !files.length) {
            evSend({ type: 'test', ok: false, pages: 0, scripts: 0, errors: [], note: 'no files to test yet' });
            return;
          }
          const r = await pageTest({ files });
          const label = note ? `PAGE TEST (${note})` : 'PAGE TEST';
          testReports.push(reportToText(r, label));
          evSend({ type: 'test', ok: r.ok, pages: r.pages, scripts: r.scripts, errors: r.errors, more: r.more, note });
          await quarantineFromReport(r, evSend);
        } catch (e) {
          evSend({ type: 'warn', message: `page test failed to run: ${String(e.message || e)}` });
          diag.push(`page test failed to run: ${String(e.message || e)}`);
        }
      };

      // Quarantine state: a project with a freeze-risk loop is "temporarily
      // disabled" — its preview serves a static blocker (no scripts can run)
      // until a fixing generation's page test comes back clean. Stored in meta
      // so it survives reloads and is enforced server-side by the preview route.
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
      const quarantineFromReport = async (r, evSend) => {
        const frozen = r && r.freezeRisk
          ? (r.errors || []).filter((e) => e.type === 'freeze risk' || e.type === 'freeze risk (inline)')
            .map((e) => e.file).filter((p, i2, a) => p && a.indexOf(p) === i2)
          : [];
        if (frozen.length) {
          diag.push(`PAGE TEST: freeze risk in ${frozen.join(', ')} — the preview is disabled until the loop is fixed.`);
          await quarantineSync(frozen, evSend);
        } else {
          await quarantineSync([], evSend);
        }
      };

      // Spin off a parallel sub-agent: a focused single-file generator that
      // runs concurrently with the main response and merges its FILE output in.
      const providerNames = ['mistral', 'ollama', 'local', 'openrouter'];
      const providerAvailable = (id) =>
        id === 'mistral' ? Boolean(mistralKey)
          : id === 'local' ? Boolean(localUrl)
            : id === 'openrouter' ? Boolean(orKey)
              : Boolean(key);
      const cloudModel = model.startsWith('local:') ? (getVar('OLLAMA_MODEL') || 'gemma4:31b') : model;

      // Route each sub-agent to a different provider than the main request
      // when slots are free, round-robin across providers that have capacity,
      // so Mistral never exceeds its 4-concurrent-model limit.
      const pickSubProvider = () => {
        const candidates = [];
        for (const id of providerNames) {
          if (id === provider || !providerAvailable(id)) continue;
          if (active[id] < PROVIDER_CAPS[id]) candidates.push(id);
        }
        if (!candidates.length && providerAvailable(provider) && active[provider] < PROVIDER_CAPS[provider]) candidates.push(provider);
        if (!candidates.length) return null;
        const p = candidates[subRound++ % candidates.length];
        active[p]++;
        return p;
      };

      const spawnSubAgent = async (subPath, task) => {
        const pid = pickSubProvider();
        if (!pid) throw new Error('all providers are at capacity — retry in a moment');
        const msg = [
          { role: 'system', content: SUB_AGENT_PROMPT },
          { role: 'user', content: `Your one assigned file: ${subPath}\n\n` +
            `Task from the main engineer:\n${task}\n\n` +
            `Return ONLY a single <<<FILE:${subPath}>>> ... <<<END>>> block.` },
        ];
        try {
          let r;
          if (pid === 'mistral') {
            r = await fetch(MISTRAL_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { Authorization: `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: MISTRAL_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`mistral ${r.status}`);
          } else if (pid === 'openrouter') {
            r = await fetch(OPENROUTER_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: {
                Authorization: `Bearer ${orKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/wigmastrrrrrrrrjr/aibuilder',
                'X-Title': 'aibuilder',
              },
              body: JSON.stringify({ model: OR_SUB_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`openrouter ${r.status}`);
          } else if (pid === 'local') {
            r = await fetch(`${localUrl}/api/chat`, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: SUB_LOCAL_MODEL, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`local ollama ${r.status}`);
          } else {
            r = await fetch(OLLAMA_URL, {
              method: 'POST',
              signal: AbortSignal.any([ac.signal, AbortSignal.timeout(300000)]),
              headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: cloudModel, messages: msg, stream: true }),
            });
            if (!r.ok) throw new Error(`ollama ${r.status}`);
          }
          const sp = new FileStreamer();
          const evs = [];
          const reader = r.body.getReader();
          const d = new TextDecoder();
          let lb = '';
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
              let tok = '';
              if (pid === 'mistral' || pid === 'openrouter') tok = j?.choices?.[0]?.delta?.content ?? '';
              else tok = j?.message?.content ?? '';
              if (!tok) continue;
              for (const ev of sp.feed(tok)) {
                if (ev.type === 'file' && ev.path) {
                  ev.path = subPath;
                  evs.push(ev);
                } else if (ev.type === 'file') {
                  evs.push(ev);
                }
              }
            }
          }
          for (const ev of sp.flush()) {
            if (ev.type === 'file' && ev.path) {
              ev.path = subPath;
              evs.push(ev);
            } else if (ev.type === 'file') {
              evs.push(ev);
            }
          }
          return { evs, provider: pid };
        } finally {
          active[pid]--;
        }
      };

      // One "round" = one model generation plus its post-build checks. If the
      // build still has errors (failed page test, freeze risk, failed ops) the
      // session keeps going and the AI is asked to fix everything IN PLACE.
      // Every error is logged into history first, so the AI always sees each
      // failure before the stream stops and can repair its own build without
      // waiting for another prompt.
      const MAX_REPAIR_ROUNDS = 3;
      const buildGenMessages = async () => {
        const hist = await store.history(pid).then(ms => ms.map(m => ({ role: m.role, content: m.content })));
        return [{ role: 'system', content: systemPrompt() + fileCtx }, ...hist];
      };
      const repairPrompt = () => {
        const parts = [];
        if (diag.length) parts.push('FAILED OPERATIONS (exact errors — fix every one):\n' + diag.map((x) => ' - ' + x).join('\n'));
        if (testReports.length) parts.push('AUTO PAGE TEST reports:\n' + testReports.join('\n\n'));
        return 'The page test just ran and the build still has errors. Do NOT stop and do NOT restate the problem — apply the exact fixes below, then keep building the app.\n\n' +
          (parts.join('\n\n') || 'No specific errors were captured, but the page did not pass. Re-check the page and fix whatever is wrong.');
      };

      let attempt = 0;
      let wantRepair = true;
      while (wantRepair && attempt < MAX_REPAIR_ROUNDS && !ac.signal.aborted) {
        attempt++;
        wantRepair = false;
        const diagAtStart = diag.length;
        const trAtStart = testReports.length;
        subAgentTasks.length = 0;
        const parser = new FileStreamer();

        let upstream;
        let providerUsed = null;
        try {
          ({ upstream, provider } = await openUpstream(model, await buildGenMessages(), key, ac.signal, emit, EFFORT[effort]));
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
          let raw = '';
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
              if (provider === 'mistral' || provider === 'openrouter') {
                tok = j?.choices?.[0]?.delta?.content ?? '';
              } else {
                // ollama cloud + local ollama both use message.content
                const msg = j?.message ?? {};
                if (msg.thinking) send({ type: 'think', v: msg.thinking });
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
                send({ type: 'subagent', path: ev.path, model, provider: res.value.provider });
              }
            }
          }
          // Auto page test: give the model the same "load the page, look at the
          // console" feedback a human would — every round. It runs BEFORE the
          // round is recorded so its report is part of the history the AI reads
          // when it continues.
          let autoResult = null;
          try {
            const fileList = await store.listFiles(pid);
            if (Array.isArray(fileList) && fileList.length <= 200 && fileList.length) {
              const all = await store.listFilesWithContent(pid);
              const r = await pageTest({ files: all });
              autoResult = r;
              testReports.push(reportToText(r, 'AUTO PAGE TEST'));
              send({ type: 'test', ok: r.ok, pages: r.pages, scripts: r.scripts, errors: r.errors, more: r.more, auto: true });
              await quarantineFromReport(r, send);
            } else if (!Array.isArray(fileList) || !fileList.length) {
              send({ type: 'test', ok: true, pages: 0, scripts: 0, errors: [], auto: true, note: 'no files yet — nothing to test' });
            }
          } catch { /* page test is best-effort */ }
          // Decide whether the AI must keep fixing within this session, then
          // record the round WITH every new error so it reaches the AI before
          // the stream stops.
          if (autoResult && !autoResult.ok) wantRepair = true;
          if (diag.length > diagAtStart) wantRepair = true;
          if (wantRepair) send({ type: 'note', message: 'The build still has errors — continuing in this session so the AI can fix them right now.' });
          if (raw.trim()) {
            let recorded = raw;
            const notes = [];
            const roundDiag = diag.slice(diagAtStart);
            const roundTests = testReports.slice(trAtStart);
            if (roundDiag.length) {
              notes.push('DIAGNOSTICS — these operations FAILED just now, so the app may be incomplete or broken. Fix them in your very next step using the exact errors above:\n' +
                roundDiag.map((x) => ' - ' + x).join('\n'));
            }
            if (roundTests.length) {
              notes.push('PAGE TESTS (a headless pass over the app — navigation-visible reference errors and script syntax errors):\n' +
                roundTests.join('\n\n'));
            }
            if (wantRepair) {
              notes.push('REPAIR REQUIRED — the checks above still fail. Your next turn starts from this exact message and must fix every error listed here.');
            }
            if (notes.length) recorded += '\n\n' + notes.join('\n\n');
            await store.addMessage(pid, 'assistant', recorded);
          }
          if (wantRepair) await store.addMessage(pid, 'user', repairPrompt());
          // Point-in-time snapshot after each round for rollback (best-effort).
          try { await store.takeSnapshot(pid, message.slice(0, 60)); } catch { /* snapshots are best-effort */ }
        } catch (e) {
          if (!ac.signal.aborted) send({ type: 'error', message: String(e.message || e) });
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
      try { controller.close(); } catch { /* already closed */ }
    },
    cancel() { ac.abort(); },
  });

  return c.newResponse(streamBody, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  });
});

// ---- generator op helpers ---------------------------------------------------

async function openUpstream(model, messages, key, signal, emit, effortCfg) {
  const mistralKey = getVar('MISTRAL_API_KEY') || '';
  const orKey = openrouterKey();
  const localUrl = await localOllamaUrl();
  const isLocalModel = typeof model === 'string' && model.startsWith('local:');
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

  const isORModel = typeof model === 'string' && (model.includes('/') || model === 'openrouter/free');
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
  const ownKey = Boolean(extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ));
  const key = extractKey(
    c.req.header('x-api-key'),
    typeof body.apiKey === 'string' ? body.apiKey : '',
  ) || builtinKey();
  if (!key && !isLocalModel) {
    return c.json({ error: 'no API key — add one in the UI (🔑) or set OLLAMA_API_KEY/MISTRAL_API_KEY in .env' }, 500);
  }

  const requested = typeof body.model === 'string' && MODEL_RE.test(body.model) ? body.model : '';
  const model = requested || getVar('OLLAMA_MODEL') || 'gemma4:31b';

  const effort = effortLevel(body.effort);
  if (!ownKey && !isLocalModel) {
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

      // in-memory copy of the workspace for applying surgical edits
      const ws = new Map(cleaned.map((f) => [f.path, f.content]));
      const written = [];
      const edited = [];
      const deleted = [];
      const renamed = [];
      const diag = [];
      const testReports = [];
      let ops = 0;

      const wsFiles = () => [...ws].map(([path, content]) => ({ path, content }));

      const handleGen = async (ev) => {
        if (ev.type === 'file' && ev.path) {
          ws.set(ev.path, ev.content);
          written.push(ev.path);
          ops++;
          send({ type: 'file', path: ev.path, content: ev.content });
        } else if (ev.type === 'edit' && ev.path) {
          const existing = ws.get(ev.path);
          if (existing === undefined) {
            send({ type: 'warn', message: `edit failed on ${ev.path}: file not present in workspace` });
            diag.push(`edit failed on ${ev.path}: file not present in workspace`);
            return;
          }
          let text = existing;
          let ok = true;
          for (const h of (ev.hunks || [])) {
            const i = text.indexOf(h.search);
            if (i === -1) {
              const msg = `edit failed on ${ev.path}: search text not found: ${JSON.stringify(String(h.search).slice(0, 60))}`;
              send({ type: 'warn', message: msg });
              diag.push(msg);
              ok = false;
              break;
            }
            text = text.slice(0, i) + h.replace + text.slice(i + h.search.length);
          }
          if (!ok) return;
          ws.set(ev.path, text);
          edited.push(ev.path);
          ops++;
          send({ type: 'edit', path: ev.path, content: text });
        } else if (ev.type === 'delete' && ev.path) {
          ws.delete(ev.path);
          deleted.push(ev.path);
          ops++;
          send({ type: 'delete', path: ev.path });
        } else if (ev.type === 'rename' && ev.from && ev.to) {
          if (ws.has(ev.from)) {
            ws.set(ev.to, ws.get(ev.from));
            ws.delete(ev.from);
          }
          renamed.push(`${ev.from} -> ${ev.to}`);
          ops++;
          send({ type: 'rename', from: ev.from, to: ev.to });
        } else if (ev.type === 'asset' && ev.path) {
          ws.set(ev.path, ev.data || '');
          ops++;
          send({ type: 'asset', path: ev.path, encoding: ev.encoding || 'utf8', data: ev.data || '' });
        } else if (ev.type === 'plan' && ev.items) {
          send({ type: 'plan', items: ev.items });
        } else if (ev.type === 'name' && ev.name) {
          send({ type: 'name', name: ev.name });
        } else if (ev.type === 'test') {
          try {
            const r = await pageTest({ files: wsFiles() });
            testReports.push(reportToText(r, String(ev.note || '').slice(0, 200) ? `PAGE TEST (${String(ev.note).slice(0, 200)})` : 'PAGE TEST'));
            send({ type: 'test', ok: r.ok, pages: r.pages, scripts: r.scripts, errors: r.errors, more: r.more, note: String(ev.note || '').slice(0, 200), workspace: true });
          } catch (e) {
            send({ type: 'warn', message: `page test failed to run: ${String(e.message || e)}` });
            diag.push(`page test failed to run: ${String(e.message || e)}`);
          }
        } else if (ev.type === 'cmd' && ev.command) {
          // Execute on the project's dedicated cloud terminal when configured;
          // otherwise relay so the client can offer to run it locally.
          const command = String(ev.command).slice(0, 2000);
          if (terminalEnabled()) {
            const res = await execCommand(String(body.pid || '').slice(0, 40), command);
            send({ type: 'cmd', command, enabled: true, ok: res.ok, code: res.code, output: res.output, error: res.error });
          } else {
            send({ type: 'cmd', command, enabled: false });
          }
        }
      };

      // Repair rounds: if the build is still failing, keep the session alive
      // and have the AI fix every logged error before we stop.
      const MAX_REPAIR_ROUNDS = 3;
      const buildWsMessages = (transcript, userContent) => [
        { role: 'system', content: workspaceSystemPrompt() + buildWorkspaceContext(cleaned) },
        ...transcript,
        { role: 'user', content: userContent },
      ];
      const wsRepairPrompt = () => {
        const parts = [];
        if (diag.length) parts.push('FAILED OPERATIONS (exact errors — fix every one):\n' + diag.map((x) => ' - ' + x).join('\n'));
        if (testReports.length) parts.push('PAGE TEST reports:\n' + testReports.join('\n\n'));
        return 'The page test just ran and the build still has errors. Do NOT stop and do NOT restate the problem — apply the exact fixes below, then keep building.\n\n' +
          (parts.join('\n\n') || 'No specific errors were captured, but the page did not pass. Re-check the page and fix whatever is wrong.');
      };

      let attempt = 0;
      let wantRepair = true;
      const transcript = history.slice(); // live transcript fed to the model each round
      while (wantRepair && attempt < MAX_REPAIR_ROUNDS && !ac.signal.aborted) {
        attempt++;
        wantRepair = false;
        const diagAtStart = diag.length;
        const trAtStart = testReports.length;
        const parser = new FileStreamer();
        let raw = '';
        let upstream;
        let providerUsed = null;
        try {
          ({ upstream, provider } = await openUpstream(model, buildWsMessages(transcript, attempt === 1 ? message : wsRepairPrompt()), key, ac.signal, emit, EFFORT[effort]));
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
              if (provider === 'mistral' || provider === 'openrouter') {
                tok = j?.choices?.[0]?.delta?.content ?? '';
              } else {
                const msg = j?.message ?? {};
                if (msg.thinking) send({ type: 'think', v: msg.thinking });
                tok = msg.content ?? '';
              }
              if (!tok) continue;
              raw += tok;
              send({ type: 'token', v: tok });
              for (const ev of parser.feed(tok)) await handleGen(ev);
            }
          }
          for (const ev of parser.flush()) await handleGen(ev);
          let autoResult = null;
          try {
            const r = await pageTest({ files: wsFiles() });
            autoResult = r;
            testReports.push(reportToText(r, 'AUTO PAGE TEST'));
            send({ type: 'test', ok: r.ok, pages: r.pages, scripts: r.scripts, errors: r.errors, more: r.more, auto: true, workspace: true });
          } catch { /* page test is best-effort */ }
          if (autoResult && !autoResult.ok && autoResult.pages > 0) wantRepair = true;
          if (diag.length > diagAtStart) wantRepair = true;
          if (wantRepair) send({ type: 'note', message: 'The build still has errors — continuing in this session so the AI can fix them right now.' });
          if (raw.trim()) {
            let recorded = raw;
            const notes = [];
            const roundDiag = diag.slice(diagAtStart);
            const roundTests = testReports.slice(trAtStart);
            if (roundDiag.length) notes.push('DIAGNOSTICS — these operations FAILED just now:\n' + roundDiag.map((x) => ' - ' + x).join('\n'));
            if (roundTests.length) notes.push('PAGE TESTS:\n' + roundTests.join('\n\n'));
            if (wantRepair) notes.push('REPAIR REQUIRED — the checks above still fail. Fix every error listed here.');
            if (notes.length) recorded += '\n\n' + notes.join('\n\n');
            transcript.push({ role: 'assistant', content: recorded });
          }
          if (wantRepair) transcript.push({ role: 'user', content: wsRepairPrompt() });
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

async function applyEdit(pid, fpath, hunks) {
  if (!hunks.length) return { error: 'no SEARCH/REPLACE hunks found' };
  const row = await store.getFile(pid, fpath);
  if (!row) return { error: 'file not found' };
  if (row.encoding && row.encoding !== 'utf8') return { error: 'binary file — rewrite with FILE instead' };
  let text = String(row.content ?? '');
  for (const h of hunks) {
    const i = text.indexOf(h.search);
    if (i === -1) {
      return { error: `search text not found: ${JSON.stringify(String(h.search).slice(0, 60))}` };
    }
    text = text.slice(0, i) + h.replace + text.slice(i + h.search.length);
  }
  await store.saveFile(pid, fpath, text);
  return { ok: true, content: text };
}

// Move a file and refresh every other text file that references it
// (src="...", href="...", url(...), fetch('...'), import "...", scripts).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function applyRename(pid, from, to) {
  const row = await store.getFile(pid, from);
  if (!row) throw new Error(`file not found: ${from}`);
  const oldBase = from.split('/').pop();
  const newBase = to.split('/').pop();
  let refs = 0;
  let files = [];
  try { files = await store.listFiles(pid); } catch { files = []; }
  const nameRe = new RegExp(`(?<=[\\s"'()=/]|^)${escRe(oldBase)}(?=[\\s"'()\\.\\?#/&]|$)`, 'g');
  for (const f of files) {
    if (f.path === from || f.path === to) continue;
    let r;
    try { r = await store.getFile(pid, f.path); } catch { continue; }
    if (!r || (r.encoding && r.encoding !== 'utf8')) continue;
    let text = String(r.content ?? '');
    const before = text;
    // exact path references (plain, ./ , / and quoted)
    text = text
      .replace(new RegExp(`['"]${escRe(from)}['"]`, 'g'), (m) => m.replace(from, to))
      .replace(new RegExp(escRe(from), 'g'), to);
    // bare basename references bound by delimiters
    text = text.replace(nameRe, newBase);
    if (text !== before) {
      await store.saveFile(pid, f.path, text);
      refs++;
    }
  }
  await store.saveFile(pid, to, row.content, row.encoding || 'utf8');
  try { await store.deleteFile(pid, from); } catch { /* already gone */ }
  return refs;
}

// SEED blocks insert rows (optionally clearing first) into a creat.db-style
// collection using the same lazy-table BaaS storage the SDK exposes.
async function seedCollection(pid, coll, items, clear) {
  const tname = store.baasTable(pid, coll);
  if (!tname) throw new Error('unsupported collection name');
  let n = 0;
  if (clear) {
    const existing = await store.baasList(pid, coll);
    for (const row of existing) {
      try { await store.baasRemove(pid, coll, row.id); } catch { /* skip */ }
    }
  }
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    try { await store.baasInsert(pid, coll, it); n++; } catch { /* skip bad row */ }
  }
  return n;
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
