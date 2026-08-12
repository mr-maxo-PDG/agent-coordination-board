'use strict';

// Zero-dependency smoke tests. Run with `npm test`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'coordboard.js');
const core = require('../src/core');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + '\n       ' + (err.message || err));
    process.exitCode = 1;
  }
}

function run(cwd, args, stdin) {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    input: stdin === undefined ? '' : stdin,
    encoding: 'utf8',
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coordboard-test-'));
fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'src', 'parser.ts'), '// test\n');

console.log('claim matching');
test('* crosses a path separator', () => {
  assert.ok(core.claimMatches('src/ui/panels/main.ts', 'src/ui/*'));
});
test('matching is case-insensitive', () => {
  assert.ok(core.claimMatches('Src/Parser.ts', 'src/parser.ts'));
});
test('a non-matching sibling does not match', () => {
  assert.ok(!core.claimMatches('src/other.ts', 'src/parser.ts'));
});
test('resource tokens never match a path', () => {
  assert.ok(!core.claimMatches('src/parser.ts', '#unity-editor'));
});

console.log('cli');
test('init creates the board and gitignores it', () => {
  run(tmp, ['init']);
  assert.ok(fs.existsSync(path.join(tmp, '.coord', 'intents')));
  assert.ok(fs.existsSync(path.join(tmp, '.coord', 'events.md')));
  assert.match(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8'), /^\.coord\/$/m);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, '.coord', 'config.json'), 'utf8')).mode, 'local');
});

test('register writes an intent', () => {
  run(tmp, [
    'register', '--handle', 'demo-a', '--task', 'editing the parser',
    '--claims', 'src/parser.ts', '--session-id', 'sess-a',
  ]);
  const intent = JSON.parse(fs.readFileSync(path.join(tmp, '.coord', 'intents', 'demo-a.json'), 'utf8'));
  assert.deepStrictEqual(intent.claims, ['src/parser.ts']);
  assert.strictEqual(intent.session_id, 'sess-a');
});

test('register refuses a repo-root claim', () => {
  assert.throws(() =>
    run(tmp, ['register', '--handle', 'greedy', '--task', 'everything', '--claims', '*'])
  );
});

test('check --path reports the advisory claim', () => {
  const out = run(tmp, ['check', '--path', path.join(tmp, 'src', 'parser.ts'), '--session-id', 'sess-b']);
  assert.match(out, /advisory claim by demo-a/);
});

test('check hides your own claim from you', () => {
  const out = run(tmp, ['check', '--path', path.join(tmp, 'src', 'parser.ts'), '--session-id', 'sess-a']);
  assert.doesNotMatch(out, /advisory claim by demo-a/);
});

console.log('hook adapters');
const hookInput = (sessionId) =>
  JSON.stringify({
    session_id: sessionId,
    cwd: tmp,
    tool_input: { file_path: path.join(tmp, 'src', 'parser.ts') },
  });

test('guard notifies on an advisory overlap without denying', () => {
  const out = run(tmp, ['guard'], hookInput('sess-b'));
  const parsed = JSON.parse(out);
  assert.match(parsed.hookSpecificOutput.additionalContext, /coord notice/);
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, undefined);
});

test('guard stays silent for the claiming session', () => {
  assert.strictEqual(run(tmp, ['guard'], hookInput('sess-a')).trim(), '');
});

test('guard denies an exclusive lock', () => {
  run(tmp, [
    'register', '--handle', 'demo-a', '--task', 'rewriting the parser',
    '--exclusive', 'src/parser.ts', '--session-id', 'sess-a',
  ]);
  const parsed = JSON.parse(run(tmp, ['guard'], hookInput('sess-b')));
  assert.strictEqual(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /exclusive lock/);
});

test('a stale intent neither blocks nor notifies', () => {
  const file = path.join(tmp, '.coord', 'intents', 'demo-a.json');
  const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
  intent.updated = new Date(Date.now() - 9 * 3600 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(intent, null, 2));
  assert.strictEqual(run(tmp, ['guard'], hookInput('sess-b')).trim(), '');
});

test('session-end clears the ending session and prunes', () => {
  run(tmp, ['session-end'], JSON.stringify({ session_id: 'sess-a', cwd: tmp }));
  assert.strictEqual(fs.readdirSync(path.join(tmp, '.coord', 'intents')).length, 0);
});

console.log('bulletin');
test('events append with a timestamp and handle', () => {
  run(tmp, ['event', 'regenerated the lockfile, reinstall before building', '--handle', 'demo-b']);
  const text = fs.readFileSync(path.join(tmp, '.coord', 'events.md'), 'utf8');
  assert.match(text, /^- \d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z \[demo-b@.+\] regenerated the lockfile/m);
});

test('rotation archives past the threshold and keeps the newest', () => {
  for (let i = 0; i < 65; i += 1) run(tmp, ['event', `filler ${i}`, '--handle', 'demo-b']);
  const cfg = core.loadConfig(tmp);
  const kept = fs.readFileSync(path.join(tmp, '.coord', 'events.md'), 'utf8')
    .split('\n').filter((l) => l.startsWith('- '));
  assert.ok(kept.length <= cfg.rotateWhenLines, `kept ${kept.length} lines`);
  assert.ok(fs.existsSync(path.join(tmp, '.coord', 'events-archive.md')));
  assert.match(kept[kept.length - 1], /filler 64/);
});

test('wrap releases the intent and posts the summary', () => {
  run(tmp, ['register', '--handle', 'demo-c', '--task', 'x', '--claims', 'src/x.ts', '--session-id', 'sess-c']);
  run(tmp, ['wrap', '--handle', 'demo-c', '--summary', 'done with x']);
  assert.strictEqual(fs.readdirSync(path.join(tmp, '.coord', 'intents')).length, 0);
  assert.match(fs.readFileSync(path.join(tmp, '.coord', 'events.md'), 'utf8'), /done with x/);
});

console.log(`\n${passed} passed`);
fs.rmSync(tmp, { recursive: true, force: true });
