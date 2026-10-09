'use strict';

// The mesh: one daemon per machine, joining every machine (and every user) on a tailnet
// into one board. Each daemon is either the HUB, which holds the shared view, or a
// FOLLOWER, which beats its local sessions and intents to the hub and caches the view.
//
// The hub is elected, not configured: the first daemon up with no hub reachable becomes
// it, and a later daemon with a higher `priority` takes over. Hub state is SOFT: every
// follower re-sends its whole picture on each beat, so a hand-off loses only messages
// in flight, and a demoting hub forwards those to its successor before it lets go.
//
// Everything that arrives from another node is untrusted in exactly the way intent files
// are, so it is sanitized here on receipt and again by whoever prints it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const core = require('./core');
const peers = require('./peers');

const PROTO = 1;
const DEFAULT_PORT = 7717;
const BEAT_MS = 5000;
// A node missing three beats is gone. Long enough to ride out one slow probe round.
const EXPIRE_MS = 3 * BEAT_MS + 2000;
const PROBE_TIMEOUT_MS = 800;
const BODY_LIMIT = 512 * 1024;
const TOUCH_TTL_MS = 60 * 60 * 1000;
const TOUCH_CAP = 500;
const EVENT_CAP = 40;
const MSG_TTL_MS = 60 * 60 * 1000;
const PATCH_CAP = 4000;
const VIEW_FRESH_MS = 3 * BEAT_MS;

const ADDR_RE = /^[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/;

function meshHome() {
  const o = process.env.COORD_MESH_HOME;
  return o && o.trim() ? path.resolve(o.trim()) : path.join(os.homedir(), '.coordboard');
}

function intIn(v, dflt, lo, hi) {
  const n = typeof v === 'number' ? Math.floor(v) : NaN;
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

function osUser() {
  try {
    return os.userInfo().username;
  } catch (_) {
    return 'unknown';
  }
}

function loadMeshConfig() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(meshHome(), 'mesh.json'), 'utf8'));
  } catch (_) {
    // No config is a single-machine mesh: still useful, and the default contract.
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const port = intIn(Number(process.env.COORD_MESH_PORT) || raw.port, DEFAULT_PORT, 1, 65535);
  const envNodes = String(process.env.COORD_MESH_NODES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : [])
    .concat(envNodes)
    .filter((s) => typeof s === 'string' && ADDR_RE.test(s))
    .map((s) => (s.includes(':') ? s : `${s}:${port}`));
  const bind = Array.isArray(raw.bind) ? raw.bind.filter((s) => typeof s === 'string' && ADDR_RE.test(s)) : null;
  return {
    port,
    nodes: [...new Set(nodes)],
    priority: intIn(Number(process.env.COORD_MESH_PRIORITY) || raw.priority, 0, -1000, 1000),
    bind,
    token: typeof raw.token === 'string' ? raw.token : '',
    user: core.sanitize(process.env.COORD_USER || (typeof raw.user === 'string' ? raw.user : '') || osUser(), 64),
  };
}

// Tailscale hands out addresses from the CGNAT block 100.64.0.0/10. Reading interfaces
// beats shelling out to `tailscale ip`, which is not on PATH on every install.
function tailnetAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const [p, q] = a.address.split('.').map(Number);
      if (p === 100 && q >= 64 && q <= 127) out.push(a.address);
    }
  }
  return out;
}

// --- repo identity -----------------------------------------------------------------
// The same repo sits at a different path on every machine, so the mesh keys it on the
// normalized origin URL, the one name every checkout of it agrees on.

function gitTop(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitConfigFile(top) {
  const dotgit = path.join(top, '.git');
  try {
    if (fs.statSync(dotgit).isDirectory()) return path.join(dotgit, 'config');
    // A worktree or submodule: .git is a file pointing at the real git dir.
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'));
    if (!m) return null;
    const gitdir = path.resolve(top, m[1].trim());
    let common = gitdir;
    try {
      common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim());
    } catch (_) {
      // Submodules have no commondir; their gitdir holds the config itself.
    }
    return path.join(common, 'config');
  } catch (_) {
    return null;
  }
}

function normalizeRemote(url) {
  let u = String(url).trim();
  u = u.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '');
  u = u.replace(/^([^/:]+):(?!\d+\/)/, '$1/');
  u = u.replace(/:\d+\//, '/').replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  return u.toLowerCase();
}

const repoKeyCache = new Map();

function repoInfo(cwd) {
  const top = gitTop(cwd);
  if (!top) return null;
  if (repoKeyCache.has(top)) return repoKeyCache.get(top);
  let key = null;
  const cfg = gitConfigFile(top);
  if (cfg) {
    try {
      const text = fs.readFileSync(cfg, 'utf8');
      const m = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(text);
      if (m) key = normalizeRemote(m[1]);
    } catch (_) {
      // Unreadable config: fall through to the folder name.
    }
  }
  const info = { top, key: core.sanitize(key || `local/${path.basename(top).toLowerCase()}`, 200) };
  repoKeyCache.set(top, info);
  return info;
}

function relPath(top, file) {
  const rel = path.relative(top, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

// --- sanitizing what crosses the wire ----------------------------------------------

const ID_RE = /^[A-Za-z0-9._@-]{1,128}$/;
const cleanId = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : '');
const cleanText = (v, max) => core.sanitize(typeof v === 'string' ? v : '', max);
const cleanPath = (v) => (typeof v === 'string' && v.length <= 512 && !/[\u0000-\u001f<>]/.test(v) ? v : '');

// Patches keep their newlines, unlike every other field: a diff flattened to one line
// is unreadable. Everything else sanitize() strips still goes.
function cleanPatch(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ').replace(/[<>]/g, '');
  return s.length > PATCH_CAP ? s.slice(0, PATCH_CAP - 1) + '…' : s;
}

function cleanSession(s, node, user) {
  if (!s || typeof s !== 'object') return null;
  const sessionId = cleanId(s.sessionId);
  if (!sessionId) return null;
  return {
    node,
    user,
    sessionId,
    name: cleanId(s.name),
    handle: cleanId(s.handle),
    repoKey: cleanText(s.repoKey, 200),
    status: cleanText(s.status, 16),
  };
}

function cleanIntent(i, node, user) {
  if (!i || typeof i !== 'object') return null;
  const claims = core.sanitizeClaims(i.claims || []);
  if (claims === null || !cleanId(i.handle)) return null;
  return {
    node,
    user,
    repoKey: cleanText(i.repoKey, 200),
    handle: cleanId(i.handle),
    session_id: cleanId(i.session_id),
    task: cleanText(i.task, 200),
    claims,
  };
}

// --- http plumbing -----------------------------------------------------------------

function request(addr, method, route, body, token, timeoutMs) {
  return new Promise((resolve) => {
    const [host, port] = addr.split(':');
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host,
        port: Number(port) || DEFAULT_PORT,
        method,
        path: route,
        timeout: timeoutMs || PROBE_TIMEOUT_MS,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          data ? { 'content-length': data.length } : {},
          token ? { 'x-coord-token': token } : {}
        ),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > BODY_LIMIT) req.destroy();
          else chunks.push(c);
        });
        res.on('end', () => {
          try {
            resolve(res.statusCode === 200 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null);
          } catch (_) {
            resolve(null);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    if (data) req.write(data);
    req.end();
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        resolve(null);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (_) {
        resolve(null);
      }
    });
  });
}

const isLoopback = (addr) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// --- ranking -----------------------------------------------------------------------
// One total order every node computes the same way, so two hubs that meet always agree
// on which one stays: priority first, then whoever became hub earliest, then id.
function outranks(a, b) {
  if (a.priority !== b.priority) return a.priority > b.priority;
  if (a.hubSince !== b.hubSince) return (a.hubSince || Infinity) < (b.hubSince || Infinity);
  return String(a.id) < String(b.id);
}

// --- the daemon --------------------------------------------------------------------

function createDaemon(cfgOverride) {
  const cfg = Object.assign(loadMeshConfig(), cfgOverride || {});
  const me = { id: core.machine(), user: cfg.user, priority: cfg.priority, hubSince: 0, startedAt: Date.now() };
  const st = {
    role: 'follower',
    hub: null,
    // hub tables
    nodes: new Map(),
    events: new Map(),
    touches: [],
    inbox: new Map(),
    // follower side
    view: null,
    mailbox: new Map(),
    outbox: [],
    reads: new Map(),
    notified: new Map(),
    sent: new Map(),
    eventOffsets: new Map(),
  };
  const servers = [];
  let timer = null;
  let stopping = false;

  const log = (line) => {
    try {
      fs.mkdirSync(meshHome(), { recursive: true });
      fs.appendFileSync(path.join(meshHome(), 'mesh.log'), `${new Date().toISOString()} ${line}\n`);
    } catch (_) {
      // Logging must never take the daemon down.
    }
  };

  const hello = () => ({ proto: PROTO, id: me.id, user: me.user, role: st.role, priority: me.priority, hubSince: me.hubSince });

  // ---- hub operations (called locally when this node is hub, or over http) ----

  function hubPrune() {
    const now = Date.now();
    for (const [id, n] of st.nodes) if (now - n.at > EXPIRE_MS) st.nodes.delete(id);
    st.touches = st.touches.filter((t) => now - t.at < TOUCH_TTL_MS).slice(-TOUCH_CAP);
    for (const [sid, list] of st.inbox) {
      const kept = list.filter((m) => now - m.at < MSG_TTL_MS);
      if (kept.length) st.inbox.set(sid, kept);
      else st.inbox.delete(sid);
    }
  }

  function hubView() {
    hubPrune();
    const sessions = [];
    const intents = [];
    const nodes = [];
    for (const n of st.nodes.values()) {
      nodes.push({ id: n.id, user: n.user, priority: n.priority, at: n.at });
      sessions.push(...n.sessions);
      intents.push(...n.intents);
    }
    const events = {};
    for (const [k, list] of st.events) events[k] = list.slice(-EVENT_CAP);
    return { hub: me.id, at: Date.now(), nodes, sessions, intents, events, touches: st.touches };
  }

  function hubBeat(b) {
    if (!b || typeof b !== 'object') return null;
    const id = cleanId(b.id);
    if (!id) return null;
    const user = cleanText(b.user, 64);
    const sessions = (Array.isArray(b.sessions) ? b.sessions : []).map((s) => cleanSession(s, id, user)).filter(Boolean);
    const intents = (Array.isArray(b.intents) ? b.intents : []).map((i) => cleanIntent(i, id, user)).filter(Boolean);
    st.nodes.set(id, { id, user, priority: intIn(b.priority, 0, -1000, 1000), at: Date.now(), sessions, intents });
    const mail = {};
    for (const s of sessions) {
      const list = st.inbox.get(s.sessionId);
      if (list && list.length) {
        mail[s.sessionId] = list;
        st.inbox.delete(s.sessionId);
      }
    }
    return { view: hubView(), mail };
  }

  function hubEvent(e) {
    const repoKey = cleanText(e && e.repoKey, 200);
    const text = cleanText(e && e.text, 2000);
    if (!repoKey || !text) return null;
    const list = st.events.get(repoKey) || [];
    list.push({ at: Date.now(), node: cleanId(e.node), user: cleanText(e.user, 64), text });
    st.events.set(repoKey, list.slice(-EVENT_CAP));
    return { ok: true };
  }

  function hubTouch(t) {
    if (!t || typeof t !== 'object') return null;
    const entry = {
      at: Date.now(),
      repoKey: cleanText(t.repoKey, 200),
      path: cleanPath(t.path),
      sessionId: cleanId(t.sessionId),
      name: cleanId(t.name),
      node: cleanId(t.node),
      user: cleanText(t.user, 64),
      tool: cleanText(t.tool, 24),
      tree: cleanId(t.tree),
      patch: cleanPatch(t.patch),
    };
    if (!entry.repoKey || !entry.path || !entry.sessionId) return null;
    st.touches.push(entry);
    return { ok: true };
  }

  function hubMsg(m) {
    const to = cleanId(m && m.to);
    const text = cleanText(m && m.text, 2000);
    if (!to || !text) return null;
    const list = st.inbox.get(to) || [];
    list.push({ at: Number(m.at) || Date.now(), from: cleanText(m.from, 160), text });
    st.inbox.set(to, list.slice(-50));
    return { ok: true };
  }

  const HUB_OPS = { '/beat': hubBeat, '/event': hubEvent, '/touch': hubTouch, '/msg': hubMsg };

  // Every write a follower makes goes through here, so one path owns both "the hub is
  // me" and "the hub is elsewhere and might be down".
  async function toHub(route, body) {
    if (st.role === 'hub') return HUB_OPS[route](body);
    if (!st.hub) return null;
    return request(st.hub, 'POST', route, body, cfg.token, 2000);
  }

  async function flushOutbox() {
    const pending = st.outbox;
    st.outbox = [];
    for (const item of pending) {
      const ok = await toHub(item.route, item.body);
      if (!ok && Date.now() - item.at < MSG_TTL_MS) st.outbox.push(item);
    }
  }

  function queue(route, body) {
    st.outbox.push({ route, body, at: Date.now() });
    flushOutbox();
  }

  // ---- what this machine contributes ----

  function collectLocal() {
    const sessions = [];
    const intents = [];
    const roots = new Map();
    for (const p of peers.readPeers()) {
      const info = repoInfo(p.cwd);
      if (!info) continue;
      sessions.push({ sessionId: p.sessionId, name: p.name, status: p.status, repoKey: info.key });
      const board = core.findRoot(p.cwd);
      if (board) roots.set(board, info.key);
    }
    for (const [root, repoKey] of roots) {
      const cfgBoard = core.loadConfig(root);
      for (const i of core.readIntents(root)) {
        if (!core.isFresh(i, cfgBoard)) continue;
        intents.push({ repoKey, handle: i.data.handle, session_id: i.data.session_id, task: i.data.task, claims: i.data.claims });
        const s = sessions.find((x) => x.sessionId === i.data.session_id);
        if (s) s.handle = i.data.handle;
      }
      forwardNewEvents(root, repoKey);
    }
    return { sessions, intents };
  }

  // The bulletin stays a file, so every existing writer keeps working unchanged; the
  // daemon forwards lines appended since it last looked. Starts at the end of the file
  // so a fresh daemon does not replay history to every other machine.
  function forwardNewEvents(root, repoKey) {
    const file = core.coordPath(root, 'events.md');
    let size;
    try {
      size = fs.statSync(file).size;
    } catch (_) {
      return;
    }
    const seen = st.eventOffsets.get(file);
    st.eventOffsets.set(file, size);
    if (seen === undefined || size <= seen) return;
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(Math.min(size - seen, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, seen);
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (line.startsWith('- ')) queue('/event', { repoKey, node: me.id, user: me.user, text: line.slice(2) });
      }
    } catch (_) {
      // A torn read loses at most one event, and the file still holds it.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function writeViewSnapshot() {
    try {
      fs.mkdirSync(meshHome(), { recursive: true });
      const file = path.join(meshHome(), 'view.json');
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ self: hello(), hubAddr: st.hub, view: st.view }));
      fs.renameSync(tmp, file);
    } catch (_) {
      // The snapshot is a convenience for synchronous readers; the daemon does not need it.
    }
  }

  // ---- election ----

  async function probe() {
    const results = await Promise.all(
      cfg.nodes.map(async (addr) => ({ addr, h: await request(addr, 'GET', '/hello', undefined, cfg.token) }))
    );
    return results.filter((r) => r.h && r.h.proto === PROTO && r.h.id !== me.id && r.h.role === 'hub');
  }

  function promote() {
    st.role = 'hub';
    st.hub = null;
    me.hubSince = Date.now();
    log(`promoted to hub (priority ${me.priority})`);
  }

  async function demote(addr) {
    log(`demoting: ${addr} outranks this hub`);
    const handover = [];
    for (const [to, list] of st.inbox) for (const m of list) handover.push({ to, at: m.at, from: m.from, text: m.text });
    st.role = 'follower';
    st.hub = addr;
    me.hubSince = 0;
    st.nodes.clear();
    st.events.clear();
    st.touches = [];
    st.inbox.clear();
    for (const m of handover) await request(addr, 'POST', '/msg', m, cfg.token, 2000);
  }

  async function tick() {
    const hubs = await probe();
    let best = null;
    for (const h of hubs) if (!best || outranks(h.h, best.h)) best = h;
    if (st.role === 'hub') {
      if (best && outranks(best.h, hello())) await demote(best.addr);
    } else if (!best) {
      promote();
    } else if (me.priority > best.h.priority) {
      // A preferred machine takes over: become hub, and the old one demotes on its
      // next tick when it sees this one outrank it.
      promote();
    } else {
      if (st.hub !== best.addr) log(`following hub ${best.h.id} at ${best.addr}`);
      st.hub = best.addr;
    }

    const local = collectLocal();
    const res = await toHub('/beat', Object.assign({ id: me.id, user: me.user, priority: me.priority }, local));
    if (res && res.view) {
      st.view = res.view;
      for (const [sid, list] of Object.entries(res.mail || {})) {
        st.mailbox.set(sid, (st.mailbox.get(sid) || []).concat(list));
      }
    } else if (st.role === 'follower') {
      // The hub went away mid-term. Drop it so the next tick re-elects.
      st.hub = null;
    }
    await flushOutbox();
    writeViewSnapshot();
  }

  // ---- local endpoints, for this machine's hooks and CLI only ----

  function sinceFor(q) {
    const sid = cleanId(q.sessionId);
    const repoKey = cleanText(q.repoKey, 200);
    const p = cleanPath(q.path);
    const last = (st.reads.get(sid) || new Map()).get(`${repoKey}|${p}`) || 0;
    const view = st.view || { touches: [], intents: [] };
    const touches = view.touches.filter((t) => t.repoKey === repoKey && t.path === p && t.sessionId !== sid && t.at > last);
    const claims = view.intents.filter(
      (i) => i.repoKey === repoKey && i.node !== me.id && i.session_id !== sid && i.claims.some((c) => core.claimMatches(p, c))
    );
    return { touches, claims };
  }

  function markRead(b) {
    const sid = cleanId(b.sessionId);
    if (!sid) return;
    const m = st.reads.get(sid) || new Map();
    m.set(`${cleanText(b.repoKey, 200)}|${cleanPath(b.path)}`, Date.now());
    st.reads.set(sid, m);
    // Pushes start from a session's first engagement, so it is not handed the last
    // hour of everyone's edits the first time it opens a file.
    if (!st.notified.has(sid)) st.notified.set(sid, Date.now());
  }

  // Peer edits to files this session has read or edited, not yet pushed to it. An edit
  // from another checkout (another machine, or another worktree here) is not on this
  // session's disk, so the session must fold the patch in itself. One from the same
  // checkout is already on disk, and is skipped once the session has re-read the file.
  function peerChanges(b) {
    const sid = cleanId(b.sessionId);
    const tree = cleanId(b.tree);
    const engaged = st.reads.get(sid);
    if (!sid || !engaged || !st.view) return { changes: [] };
    const since = st.notified.get(sid) || Date.now();
    const changes = st.view.touches
      .filter((t) => t.sessionId !== sid && t.at > since && !(st.sent.get(sid) || new Set()).has(t.patch))
      .filter((t) => {
        const readAt = engaged.get(`${t.repoKey}|${t.path}`);
        if (readAt === undefined) return false;
        return t.tree !== tree || t.at > readAt;
      })
      .map((t) => Object.assign({}, t, { sameTree: t.tree === tree }));
    if (changes.length) st.notified.set(sid, Math.max(...changes.map((t) => t.at)));
    return { changes };
  }

  const LOCAL_OPS = {
    '/local/view': () => ({ self: hello(), hubAddr: st.hub, view: st.view, outbox: st.outbox.length }),
    '/local/read': (b) => (markRead(b), { ok: true }),
    '/local/touch': (b) => {
      markRead(b);
      // An agent folding in a teammate's patch re-broadcasts that same patch; remembering
      // what each session sent keeps it from bouncing back to its author as news.
      const sid = cleanId(b.sessionId);
      if (sid) {
        const set = st.sent.get(sid) || new Set();
        set.add(cleanPatch(b.patch));
        if (set.size > 200) set.delete(set.values().next().value);
        st.sent.set(sid, set);
      }
      queue('/touch', Object.assign({}, b, { node: me.id, user: me.user }));
      return { ok: true };
    },
    '/local/msg': (b) => (queue('/msg', { to: b.to, from: b.from, text: b.text, at: Date.now() }), { ok: true }),
    '/local/inbox': (b) => {
      const sid = cleanId(b.sessionId);
      const list = st.mailbox.get(sid) || [];
      st.mailbox.delete(sid);
      return { messages: list };
    },
    '/local/since': sinceFor,
    '/local/peer-changes': peerChanges,
    '/local/stop': () => (setImmediate(stop), { ok: true }),
  };

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const route = url.pathname;
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (route === '/hello') return send(200, hello());
    const local = isLoopback(req.socket.remoteAddress);
    if (route.startsWith('/local/')) {
      if (!local || !LOCAL_OPS[route]) return send(404, { error: 'not found' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (body === null) return send(400, { error: 'bad body' });
      return send(200, LOCAL_OPS[route](body));
    }
    if (cfg.token && req.headers['x-coord-token'] !== cfg.token) return send(403, { error: 'token' });
    if (!HUB_OPS[route] || req.method !== 'POST') return send(404, { error: 'not found' });
    if (st.role !== 'hub') return send(409, { error: 'not hub' });
    const body = await readBody(req);
    const out = body && HUB_OPS[route](body);
    return out ? send(200, out) : send(400, { error: 'rejected' });
  }

  function listen(host) {
    return new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        handle(req, res).catch(() => {
          try {
            res.writeHead(500);
            res.end();
          } catch (_) {
            // Socket already gone.
          }
        });
      });
      srv.once('error', reject);
      srv.listen(cfg.port, host, () => {
        servers.push(srv);
        resolve();
      });
    });
  }

  async function start() {
    // The loopback bind doubles as the single-instance lock: a second daemon on this
    // machine fails here with EADDRINUSE and exits without touching anything.
    await listen('127.0.0.1');
    for (const host of cfg.bind || tailnetAddresses()) {
      if (host === '127.0.0.1') continue;
      try {
        await listen(host);
      } catch (err) {
        log(`could not bind ${host}:${cfg.port}: ${err.code || err.message}`);
      }
    }
    log(`daemon up as ${me.id} (${me.user}), port ${cfg.port}, nodes [${cfg.nodes.join(', ')}]`);
    await tick();
    const loop = async () => {
      if (stopping) return;
      try {
        await tick();
      } catch (err) {
        log(`tick failed: ${err.message || err}`);
      }
      timer = setTimeout(loop, BEAT_MS);
    };
    timer = setTimeout(loop, BEAT_MS);
  }

  async function stop() {
    stopping = true;
    clearTimeout(timer);
    // Hand queued mail to whoever outranks us before going, or it dies with this process.
    if (st.role === 'hub') {
      const hubs = await probe();
      if (hubs.length) await demote(hubs[0].addr);
    }
    for (const s of servers) s.close();
    log('daemon stopped');
  }

  return { start, stop, tick, state: st, me, cfg };
}

// --- client side: what hooks and the CLI call --------------------------------------

function localAddr() {
  return `127.0.0.1:${loadMeshConfig().port}`;
}

function local(route, body, timeoutMs) {
  return request(localAddr(), body === undefined ? 'GET' : 'POST', route, body, '', timeoutMs || 600);
}

// Fire and forget: a hook must not wait on a daemon booting. The next hook finds it up.
function spawnDaemon() {
  const bin = path.join(__dirname, '..', 'bin', 'coordboard.js');
  const child = spawn(process.execPath, [bin, 'mesh', 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function ensureDaemon() {
  const h = await request(localAddr(), 'GET', '/hello', undefined, '', 400);
  if (h) return h;
  spawnDaemon();
  return null;
}

function readSnapshot() {
  try {
    const snap = JSON.parse(fs.readFileSync(path.join(meshHome(), 'view.json'), 'utf8'));
    if (!snap || !snap.view || Date.now() - snap.view.at > VIEW_FRESH_MS) return null;
    return snap;
  } catch (_) {
    return null;
  }
}

module.exports = {
  PROTO,
  DEFAULT_PORT,
  BEAT_MS,
  meshHome,
  loadMeshConfig,
  tailnetAddresses,
  normalizeRemote,
  repoInfo,
  relPath,
  outranks,
  createDaemon,
  local,
  ensureDaemon,
  spawnDaemon,
  readSnapshot,
  cleanPatch,
};
