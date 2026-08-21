'use strict';

// Claude Code peer-session adapter.
//
// Claude Code keeps a machine-local registry of live sessions, one JSON file per
// process, holding the session's id, its working directory, and the NAME that its
// sibling sessions use to message it. That is the join this board could not make on
// its own: an intent knows a session_id, and direct messaging needs a name.
//
// THIS READS UNDOCUMENTED INTERNALS of another program. The layout is not a public
// interface and will move. Every function here fails to an empty result rather than
// throwing, so the board degrades to exactly its pre-messaging behaviour when the
// registry is absent, renamed, or reshaped. Nothing in core.js may depend on it.
//
// Two properties of the registry drive the design:
//
//   1. A session's name is DERIVED and can change (`nameSource`, `nameSince`). Storing
//      one in an intent file would hand out a stale address. So an intent stores only
//      the session_id, and the name is resolved at read time, here.
//   2. The files are rewritten in place on a heartbeat, so a read can catch one torn.
//      Every field is required rather than defaulted: a half-written record must look
//      malformed, not look like a session with no name.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Same override Claude Code itself honours, so a relocated config dir still resolves.
function claudeDir() {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  const home = os.homedir();
  return home ? path.join(home, '.claude') : null;
}

function sessionsDir() {
  const base = claudeDir();
  return base ? path.join(base, 'sessions') : null;
}

// The registry format this adapter was written against. A record announcing a protocol
// from the future is skipped rather than guessed at.
const SUPPORTED_PROTOCOL = 1;

// A record whose process is gone but whose file survives (a crash, a kill -9) would
// otherwise advertise an address that silently swallows messages. Liveness is the pid,
// with the heartbeat as a backstop against pid reuse handing us a stranger's process.
const HEARTBEAT_CEILING_MS = 24 * 60 * 60 * 1000;

// Names and statuses are interpolated into an agent's context and a name is used as a
// message address, so the same containment the board applies to intent files applies
// here. Deliberately stricter than a general sanitize: an address is a short token.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUS_RE = /^[a-z]{1,16}$/;
const UUID_RE = /^[A-Za-z0-9-]{8,64}$/;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else, which is still alive.
    return err && err.code === 'EPERM';
  }
}

// Returns null for anything not positively well formed. Callers treat null as "not a
// peer", never as "a peer with missing fields".
function parseRecord(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    // Torn mid-heartbeat, or not JSON at all. Either way it is not a peer this pass.
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.peerProtocol !== SUPPORTED_PROTOCOL) return null;

  const pid = raw.pid;
  const name = raw.name;
  const cwd = raw.cwd;
  const sessionId = raw.sessionId;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  if (typeof cwd !== 'string' || !cwd) return null;
  if (typeof sessionId !== 'string' || !UUID_RE.test(sessionId)) return null;

  const heartbeat = typeof raw.updatedAt === 'number' ? raw.updatedAt : null;
  if (heartbeat !== null && Date.now() - heartbeat > HEARTBEAT_CEILING_MS) return null;
  if (!processAlive(pid)) return null;

  const features = Array.isArray(raw.peerFeatures)
    ? raw.peerFeatures.filter((f) => typeof f === 'string' && STATUS_RE.test(f.replace(/_/g, '')))
    : [];

  return {
    pid,
    sessionId,
    name,
    cwd: path.resolve(cwd),
    status: typeof raw.status === 'string' && STATUS_RE.test(raw.status) ? raw.status : 'unknown',
    kind: typeof raw.kind === 'string' && STATUS_RE.test(raw.kind) ? raw.kind : 'unknown',
    features,
    heartbeat,
  };
}

// True when the registry exists at all. Distinguishes "no peers" from "this is not
// Claude Code, so peer discovery does not apply here", which read very differently in
// a report: the first is a fact about the repo, the second about the tool.
function available() {
  const dir = sessionsDir();
  if (!dir) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function readPeers() {
  const dir = sessionsDir();
  if (!dir) return [];
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const n of names) {
    const rec = parseRecord(path.join(dir, n));
    if (rec) out.push(rec);
  }
  return out;
}

function withinRoot(root, dir) {
  const a = path.resolve(root);
  const b = path.resolve(dir);
  if (a === b) return true;
  return b.startsWith(a + path.sep);
}

// Every live session whose working directory sits inside this repo. This is the filter
// that keeps the board from pointing an agent at a session in an unrelated project:
// message addressing is machine-wide, but coordination is per-repo.
function forRoot(root) {
  if (!root) return [];
  return readPeers()
    .filter((p) => withinRoot(root, p.cwd))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// This session's own record, found by pid. A session can therefore learn the address
// its peers would use for it without contacting any of them.
function self() {
  const pid = Number(process.env.CLAUDE_PID);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const dir = sessionsDir();
  if (!dir) return null;
  return parseRecord(path.join(dir, `${pid}.json`));
}

// The current address for a session_id, or null when that session is gone. Resolved on
// every read precisely because a stored name goes stale when a session is renamed.
function addressFor(sessionId, peers) {
  if (!sessionId) return null;
  const list = Array.isArray(peers) ? peers : readPeers();
  return list.find((p) => p.sessionId === sessionId) || null;
}

module.exports = {
  available,
  readPeers,
  forRoot,
  self,
  addressFor,
  withinRoot,
  SUPPORTED_PROTOCOL,
};
