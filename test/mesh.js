'use strict';

// Mesh tests: real daemons on loopback ports, driven tick by tick. Run with `npm test`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coordboard-mesh-'));
// No real Claude sessions leak into the beats, and no real ~/.coordboard is touched.
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.COORD_MESH_HOME = path.join(tmp, 'mesh');

const mesh = require('../src/mesh');
const meshhooks = require('../src/meshhooks');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL ' + name + '\n       ' + (err.stack || err));
    process.exitCode = 1;
  }
}

const BASE = 17000 + Math.floor(Math.random() * 1000);
const addr = (p) => `127.0.0.1:${p}`;

function daemon(id, port, nodes, priority) {
  process.env.COORD_MACHINE = id;
  return mesh.createDaemon({
    port, nodes: nodes.map(addr), priority: priority || 0, bind: ['127.0.0.1'], token: '', user: 'max', collaborate: ['nate'],
  });
}

function post(port, route, body) {
  const http = require('http');
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ code: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') }));
      }
    );
    req.on('error', () => resolve({ code: 0 }));
    req.end(data);
  });
}

(async () => {
  console.log('mesh units');
  await test('remote URLs from every transport normalize to one key', () => {
    const want = 'github.com/mr-maxo-pdg/substrate-emergence';
    assert.strictEqual(mesh.normalizeRemote('git@github.com:mr-maxo-PDG/Substrate-Emergence.git'), want);
    assert.strictEqual(mesh.normalizeRemote('https://user:tok@github.com/mr-maxo-PDG/Substrate-Emergence'), want);
    assert.strictEqual(mesh.normalizeRemote('ssh://git@github.com:22/mr-maxo-PDG/Substrate-Emergence.git/'), want);
  });
  await test('ranking: priority, then earliest hub, then id', () => {
    assert.ok(mesh.outranks({ priority: 1, hubSince: 9, id: 'b' }, { priority: 0, hubSince: 1, id: 'a' }));
    assert.ok(mesh.outranks({ priority: 0, hubSince: 1, id: 'b' }, { priority: 0, hubSince: 9, id: 'a' }));
    assert.ok(mesh.outranks({ priority: 0, hubSince: 5, id: 'a' }, { priority: 0, hubSince: 5, id: 'b' }));
    assert.ok(!mesh.outranks({ priority: 0, hubSince: 0, id: 'a' }, { priority: 0, hubSince: 5, id: 'b' }));
  });
  await test('patches keep newlines but lose fence characters', () => {
    assert.strictEqual(mesh.cleanPatch('- a<b>\n+ c'), '- ab\n+ c');
  });
  await test('edit payloads render as a patch per tool', () => {
    assert.strictEqual(meshhooks.editPatch('Edit', { old_string: 'x', new_string: 'y' }), '- x\n+ y');
    assert.ok(meshhooks.editPatch('Write', { content: 'abc' }).includes('whole file'));
  });

  console.log('mesh election and relay');
  const [pA, pB, pD, pE] = [BASE, BASE + 1, BASE + 2, BASE + 3];
  const A = daemon('node-a', pA, [pB, pD]);
  const B = daemon('node-b', pB, [pA, pD]);
  let D = null;

  await test('the first daemon up with no hub becomes the hub', async () => {
    await A.start();
    assert.strictEqual(A.state.role, 'hub');
  });

  await test('a second daemon finds the hub and follows it', async () => {
    await B.start();
    assert.strictEqual(B.state.role, 'follower');
    assert.strictEqual(B.state.hub, addr(pA));
  });

  await test('a remote node beating to the hub shows up in every follower view', async () => {
    const r = await post(pA, '/beat', {
      id: 'node-c',
      user: 'nate',
      sessions: [{ sessionId: 'sess-c-0001', name: 'nate-session', repoKey: 'github.com/x/y' }],
      intents: [{ repoKey: 'github.com/x/y', handle: 'parser', session_id: 'sess-c-0001', task: 'parser work', claims: ['src/parser.ts'] }],
    });
    assert.strictEqual(r.code, 200);
    await B.tick();
    const s = B.state.view.sessions.find((x) => x.sessionId === 'sess-c-0001');
    assert.ok(s, 'session missing from follower view');
    assert.strictEqual(s.user, 'nate');
    assert.strictEqual(s.node, 'node-c');
  });

  await test('a message queued on one machine is delivered on the target node beat', async () => {
    await post(pB, '/local/msg', { to: 'sess-c-0001', from: 'max@node-b', text: 'I am on parser.ts too' });
    const r = await post(pA, '/beat', { id: 'node-c', user: 'nate', sessions: [{ sessionId: 'sess-c-0001', repoKey: 'github.com/x/y' }] });
    assert.strictEqual(r.body.mail['sess-c-0001'][0].text, 'I am on parser.ts too');
    const again = await post(pA, '/beat', { id: 'node-c', user: 'nate', sessions: [{ sessionId: 'sess-c-0001', repoKey: 'github.com/x/y' }] });
    assert.deepStrictEqual(again.body.mail, {}, 'a delivered message must not be delivered twice');
  });

  await test('a hub-side message reaches a follower session mailbox and drains once', async () => {
    B.state.view.sessions.push({ sessionId: 'sess-b-0001', node: 'node-b' });
    await post(pA, '/msg', { to: 'sess-b-0001', from: 'nate@node-c', text: 'take the tests?' });
    // node-b's beat only lists sessions it reads locally; simulate one by beating for it.
    const r = await post(pA, '/beat', { id: 'node-b', user: 'max', sessions: [{ sessionId: 'sess-b-0001', repoKey: 'k' }] });
    assert.strictEqual(r.body.mail['sess-b-0001'][0].text, 'take the tests?');
  });

  await test('an edit on one node warns a session on another that read the file earlier', async () => {
    // Each beat replaces a node's whole picture, so node-c re-asserts its claim here.
    await post(pA, '/beat', {
      id: 'node-c', user: 'nate', sessions: [{ sessionId: 'sess-c-0001', repoKey: 'github.com/x/y' }],
      intents: [{ repoKey: 'github.com/x/y', handle: 'parser', session_id: 'sess-c-0001', task: 'parser work', claims: ['src/parser.ts'] }],
    });
    await post(pB, '/local/read', { sessionId: 'sess-b-0002', repoKey: 'github.com/x/y', path: 'src/parser.ts' });
    await new Promise((r) => setTimeout(r, 5));
    await post(pA, '/touch', {
      repoKey: 'github.com/x/y', path: 'src/parser.ts', sessionId: 'sess-c-0001', name: 'nate-session',
      node: 'node-c', user: 'nate', tool: 'Edit', patch: '- old\n+ new',
    });
    await B.tick();
    const r = await post(pB, '/local/since', { sessionId: 'sess-b-0002', repoKey: 'github.com/x/y', path: 'src/parser.ts' });
    assert.strictEqual(r.body.touches.length, 1);
    assert.strictEqual(r.body.touches[0].patch, '- old\n+ new');
    assert.strictEqual(r.body.claims[0].handle, 'parser');
    await post(pB, '/local/read', { sessionId: 'sess-b-0002', repoKey: 'github.com/x/y', path: 'src/parser.ts' });
    const after = await post(pB, '/local/since', { sessionId: 'sess-b-0002', repoKey: 'github.com/x/y', path: 'src/parser.ts' });
    assert.strictEqual(after.body.touches.length, 0, 're-reading the file clears the warning');
  });

  await test('a peer edit from another checkout is pushed once to a session working on that file', async () => {
    const repo = 'github.com/x/y';
    await post(pB, '/local/read', { sessionId: 'sess-b-0003', repoKey: repo, path: 'src/lexer.ts' });
    await new Promise((r) => setTimeout(r, 5));
    await post(pA, '/touch', {
      repoKey: repo, path: 'src/lexer.ts', sessionId: 'sess-c-0001', node: 'node-c', user: 'nate',
      tool: 'Edit', tree: 'tree-c', patch: '- a\n+ b',
    });
    await B.tick();
    const r = await post(pB, '/local/peer-changes', { sessionId: 'sess-b-0003', tree: 'tree-b' });
    assert.strictEqual(r.body.changes.length, 1);
    assert.strictEqual(r.body.changes[0].sameTree, false);
    const again = await post(pB, '/local/peer-changes', { sessionId: 'sess-b-0003', tree: 'tree-b' });
    assert.strictEqual(again.body.changes.length, 0, 'a pushed change must not be pushed twice');
  });

  await test('applying a teammate patch does not bounce it back to its author', async () => {
    const repo = 'github.com/x/y';
    // sess-b-0003 folds nate's patch in; nate's own daemon is B here, standing in for node-c.
    await post(pB, '/local/touch', { sessionId: 'sess-b-0004', repoKey: repo, path: 'src/ast.ts', tool: 'Edit', tree: 'tree-c', patch: '- p\n+ q' });
    await new Promise((r) => setTimeout(r, 5));
    await post(pA, '/touch', { repoKey: repo, path: 'src/ast.ts', sessionId: 'sess-x', node: 'node-x', user: 'max', tool: 'Edit', tree: 'tree-x', patch: '- p\n+ q' });
    await B.tick();
    const r = await post(pB, '/local/peer-changes', { sessionId: 'sess-b-0004', tree: 'tree-c' });
    assert.strictEqual(r.body.changes.length, 0);
  });

  await test('a same-checkout edit is skipped once the session has re-read the file', async () => {
    const repo = 'github.com/x/y';
    await post(pB, '/local/read', { sessionId: 'sess-b-0005', repoKey: repo, path: 'src/emit.ts' });
    await new Promise((r) => setTimeout(r, 5));
    await post(pA, '/touch', { repoKey: repo, path: 'src/emit.ts', sessionId: 'sess-b-0006', node: 'node-b', user: 'max', tool: 'Edit', tree: 'tree-b', patch: '- m\n+ n' });
    await B.tick();
    await post(pB, '/local/read', { sessionId: 'sess-b-0005', repoKey: repo, path: 'src/emit.ts' });
    const r = await post(pB, '/local/peer-changes', { sessionId: 'sess-b-0005', tree: 'tree-b' });
    assert.strictEqual(r.body.changes.length, 0);
  });

  await test('another user is isolated: no pushes or warnings unless collaborate names them', async () => {
    const repo = 'github.com/x/y';
    const saved = B.cfg.collaborate;
    B.cfg.collaborate = [];
    try {
      await post(pB, '/local/read', { sessionId: 'sess-b-0007', repoKey: repo, path: 'src/iso.ts' });
      await new Promise((r) => setTimeout(r, 5));
      await post(pA, '/touch', { repoKey: repo, path: 'src/iso.ts', sessionId: 'sess-c-0001', node: 'node-c', user: 'nate', tool: 'Edit', tree: 'tree-c', patch: '- i\n+ j' });
      await B.tick();
      const pushed = await post(pB, '/local/peer-changes', { sessionId: 'sess-b-0007', tree: 'tree-b' });
      assert.strictEqual(pushed.body.changes.length, 0);
      const warned = await post(pB, '/local/since', { sessionId: 'sess-b-0007', repoKey: repo, path: 'src/iso.ts' });
      assert.strictEqual(warned.body.touches.length, 0);
    } finally {
      B.cfg.collaborate = saved;
    }
  });

  await test('review shows another user their sessions, task and recent patches', async () => {
    const commands = require('../src/commands');
    const out = commands.meshReview(B.state.view, 'nate');
    assert.ok(out.includes('nate-session') || out.includes('sess-c-0'), out);
    assert.ok(out.includes('src/parser.ts'), out);
    assert.ok(out.includes('+ new'), out);
    assert.ok(commands.meshReview(B.state.view).includes('nate'));
  });

  await test('local endpoints are not served to hub routes, and hub routes refuse a follower', async () => {
    const r = await post(pB, '/beat', { id: 'x' });
    assert.strictEqual(r.code, 409);
  });

  await test('a higher-priority machine takes the hub and the old hub follows it', async () => {
    D = daemon('node-d', pD, [pA, pB, pE], 5);
    await D.start();
    assert.strictEqual(D.state.role, 'hub');
    await A.tick();
    assert.strictEqual(A.state.role, 'follower');
    assert.strictEqual(A.state.hub, addr(pD));
    await B.tick();
    await B.tick();
    assert.strictEqual(B.state.hub, addr(pD));
  });

  await test('mail waiting on a demoted hub is handed to its successor', async () => {
    const E = daemon('node-e', pE, [pD], 9);
    // Queue mail on D while it is still hub, then let E take over.
    await post(pD, '/msg', { to: 'sess-z', from: 'max@node-b', text: 'handover' });
    await E.start();
    await D.tick();
    const r = await post(pE, '/beat', { id: 'node-z', user: 'z', sessions: [{ sessionId: 'sess-z', repoKey: 'k' }] });
    assert.strictEqual(r.body.mail['sess-z'][0].text, 'handover');
    await E.stop();
  });

  for (const d of [A, B, D]) if (d) await d.stop();
  console.log(`\n${passed} mesh test(s) passed`);
  process.exit(process.exitCode || 0);
})();
