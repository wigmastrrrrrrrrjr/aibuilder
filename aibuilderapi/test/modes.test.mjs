// Chat-mode regression suite.
//
// The mode split has one invariant that everything else hangs off: a machine
// payload — a `>>>tool {…}` call or a legacy `<<<FILE…>>>` block — must never
// reach the client as streamed text, no matter how the upstream chunks it.
// Files still have to be written; only the wire changes. That is what
// VisibleStream does, and why these tests feed it byte by byte as well as in
// one piece.
//
// Run:  node --test aibuilderapi/test/modes.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { VisibleStream, stripBlocks } from '../src/stream-filter.js';
import { askSystemPrompt, explainSystemPrompt, systemPrompt } from '../src/prompt.js';
import { CHAT_MODES, MODE_LABEL, chatMode, modeAllowsTool, modeWrites } from '../src/modes.js';

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Feed `text` to a fresh filter in fixed-size slices. */
function streamed(text, size) {
  const f = new VisibleStream();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += f.push(text.slice(i, i + size));
  return out + f.flush();
}

const TOOL_CALL = [
  'Building it now.',
  '',
  '>>>tool',
  '{"name":"write_file","arguments":{"path":"index.html","content":"<h1>SECRET_MARKER</h1>"}}',
  '<<<',
  '',
  'Done — the page is live.',
].join('\n');

const LEGACY_BLOCK = [
  'Updating the styles.',
  '<<<FILE:styles.css>>>',
  'body { color: SECRET_MARKER; }',
  '<<<END>>>',
  'That is everything.',
].join('\n');

test('prose passes through untouched', () => {
  const text = 'Plain answer with no payloads at all.\nSecond line.';
  assert.equal(streamed(text, 3), text);
  assert.equal(stripBlocks(text), text);
});

test('a tool call is stripped and its file content never leaks', () => {
  const out = streamed(TOOL_CALL, TOOL_CALL.length);
  assert.ok(out.includes('Building it now.'), 'leading prose must survive');
  assert.ok(out.includes('Done — the page is live.'), 'trailing prose must survive');
  assert.ok(!out.includes('SECRET_MARKER'), 'file contents must never reach the client');
  assert.ok(!out.includes('>>>tool'), 'the marker itself must not be streamed');
  assert.ok(!out.includes('"name"'), 'tool JSON must not be streamed');
});

test('a legacy FILE block is stripped', () => {
  const out = streamed(LEGACY_BLOCK, LEGACY_BLOCK.length);
  assert.equal(collapse(out), 'Updating the styles. That is everything.');
  assert.ok(!out.includes('SECRET_MARKER'));
});

test('stripping is independent of how the upstream chunks the stream', () => {
  const want = collapse(streamed(TOOL_CALL, TOOL_CALL.length));
  for (const size of [1, 2, 3, 4, 5, 7, 11, 16, 64]) {
    assert.equal(collapse(streamed(TOOL_CALL, size)), want, `chunk size ${size}`);
  }
  const wantLegacy = collapse(streamed(LEGACY_BLOCK, LEGACY_BLOCK.length));
  for (const size of [1, 2, 3, 5, 9, 40]) {
    assert.equal(collapse(streamed(LEGACY_BLOCK, size)), wantLegacy, `legacy chunk size ${size}`);
  }
});

test('braces and quotes inside the payload do not end the block early', () => {
  const tricky = 'a >>>tool {"name":"write_file","arguments":{"content":"if (x) { y(\\"}\\") }"}} <<< b';
  const out = stripBlocks(tricky);
  assert.equal(collapse(out), 'a b');
});

test('an unterminated payload is dropped, not half-emitted', () => {
  const out = streamed('Intro.\n>>>tool\n{"name":"write_file","arguments":{"path":"a.js"', 3);
  assert.equal(collapse(out), 'Intro.');
});

test('a malformed tool call ends at its marker, so the prose after it survives', () => {
  const malformed = 'Before. >>>tool\nnot json at all\n<<< After.';
  for (const size of [1, 2, 3, 5, malformed.length]) {
    assert.equal(collapse(streamed(malformed, size)), 'Before. After.', `chunk size ${size}`);
  }
});

test('prose that merely contains <<< is preserved', () => {
  const text = 'The binary shift a <<< b is not a file block.';
  for (const size of [1, 2, 5, text.length]) {
    assert.equal(collapse(streamed(text, size)), collapse(text), `chunk size ${size}`);
  }
});

test('modes normalise and only build writes', () => {
  assert.deepEqual(CHAT_MODES, ['build', 'ask', 'explain']);
  assert.equal(chatMode('ask'), 'ask');
  assert.equal(chatMode(' EXPLAIN '), 'explain');
  assert.equal(chatMode('workspace'), 'build', 'the legacy workspace route is not a chat mode');
  assert.equal(chatMode(undefined), 'build');
  assert.equal(chatMode('bogus'), 'build');
  assert.deepEqual(Object.keys(MODE_LABEL).sort(), ['ask', 'build', 'explain']);
  assert.equal(modeWrites('build'), true);
  assert.equal(modeWrites('explain'), false);
  assert.equal(modeWrites('ask'), false);
});

test('explain mode allows reading and refuses every write tool', () => {
  for (const ok of ['read_file', 'search_files', 'list_files', 'glob', 'web_search', 'fetch_url']) {
    assert.equal(modeAllowsTool('explain', ok), true, `${ok} should be allowed`);
  }
  for (const no of ['write_file', 'edit_file', 'delete_file', 'rename_file', 'run_command',
    'create_asset', 'seed_database', 'create_dedicated_server', 'batch', 'update_plan']) {
    assert.equal(modeAllowsTool('explain', no), false, `${no} must be refused`);
  }
  // build mode is unrestricted
  for (const ok of ['write_file', 'edit_file', 'run_command']) {
    assert.equal(modeAllowsTool('build', ok), true);
  }
});

test('the mode prompts match their mode', () => {
  const build = systemPrompt();
  assert.ok(/>>>tool/.test(build), 'build prompt documents the tool protocol');

  const ask = askSystemPrompt();
  assert.ok(/never/i.test(ask));
  assert.ok(/>>>tool/.test(ask), 'ask prompt explicitly names the syntax it must not emit');
  assert.ok(!/read_file —/.test(ask), 'ask mode must not advertise file tools');

  const explain = explainSystemPrompt();
  assert.ok(/read_file/.test(explain) && /search_files/.test(explain));
  assert.ok(/read-only/i.test(explain));
  assert.ok(/never modify|never changes/i.test(explain));
  // The write tools may only appear as things it must not call.
  assert.ok(!/write_file — /.test(explain), 'explain mode must not document a writer tool');
});
