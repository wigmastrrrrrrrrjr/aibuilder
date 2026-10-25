// Chat modes — what a turn is allowed to DO, not just how hard it thinks.
//
//   build    the full agent: writes files, runs tools, streams only its prose
//   ask      conversation only: one reply, no tools, no file writes
//   explain  read-only: reads/searches the project and explains it
//
// Kept in its own dependency-free module so the server, the tests and (by
// reading the same names) the SPA all agree on the vocabulary. The legacy
// `workspace` value is NOT a mode here — it is routed to the stateless CLI
// handler before a mode is ever read.

export const CHAT_MODES = ['build', 'ask', 'explain'];

export const MODE_LABEL = { build: 'Build', ask: 'Chat', explain: 'Explain' };

export const MODE_HINT = {
  build: 'writes the files and builds the app',
  ask: 'answers only — no tools, no file changes',
  explain: 'reads the project and explains it, never changes it',
};

/** Normalise anything the client sends into one of CHAT_MODES. */
export function chatMode(v) {
  const m = String(v ?? '').toLowerCase().trim();
  return CHAT_MODES.includes(m) ? m : 'build';
}

// The only tools Explain mode may run — every one of them just looks.
// `update_plan` is deliberately absent: it persists a plan on the project, and
// Explain mode must not change anything at all.
export const READ_ONLY_TOOLS = new Set([
  'read_file', 'search_files', 'list_files', 'glob', 'web_search', 'fetch_url',
]);

/** May `mode` execute the tool `name`? Build may do anything. */
export function modeAllowsTool(mode, name) {
  if (chatMode(mode) !== 'explain') return true;
  return READ_ONLY_TOOLS.has(String(name || ''));
}

/** Does this mode change the project at all? */
export function modeWrites(mode) {
  return chatMode(mode) === 'build';
}
