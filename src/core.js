'use strict';

// Shared state and file handling for the coordination board.
// Every command and every editor hook goes through this module, so thresholds
// and claim matching have exactly one implementation.
//
// Everything read out of .coord/ is UNTRUSTED. Intent files are written by other
// agent sessions, and in shared mode they arrive over git from other people. They
// reach two dangerous places: a filesystem path (the handle) and an LLM's context
// (task, machine, claims, events). Both are contained here at read time so no
// caller can forget.

const fs = require('fs');
const path = require('path');
const os = require('os');

const COORD_DIR = '.coord';

const DEFAULTS = {
  // 'local'  : .coord/ is gitignored, one machine, sessions share a live directory
  // 'shared' : .coord/ is committed and syncs between machines through git
  mode: 'local',
  staleHours: 8,
  startupTailLines: 8,
  rotateWhenLines: 60,
  rotateKeepLines: 30,
};

const LIMITS = {
  handle: 64,
  task: 200,
  machine: 64,
  claim: 256,
  claims: 64,
  // Each '*' becomes an unbounded '.*'. Adjacent ones backtrack exponentially, and
  // the guard runs this on every write, so a hostile claim could hang the editor.
  globStars: 4,
};

const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const EVENTS_HEADER = '# Coordination events (append-only; newest last)';

// Walks up for .coord/, but stops at a repo boundary so a stray .coord/ in a
// parent directory (or $HOME) cannot capture every repo underneath it.
function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, COORD_DIR, 'intents'))) return dir;
    if (fs.existsSync(path.join(dir, '.git'))) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function coordPath(root, ...rest) {
  return path.join(root, COORD_DIR, ...rest);
}

function isValidHandle(handle) {
  return typeof handle === 'string' && HANDLE_RE.test(handle);
}

// path.join normalizes '..', so an unchecked handle escapes the board and writes
// or deletes anywhere on disk. Every path built from a handle goes through here.
function intentPath(root, handle) {
  if (!isValidHandle(handle)) {
    throw new Error(
      `Invalid handle '${String(handle).slice(0, 64)}'. Use letters, digits, '.', '-' or '_', up to 64 characters.`
    );
  }
  const dir = coordPath(root, 'intents');
  const file = path.resolve(dir, `${handle}.json`);
  if (!file.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`Refusing to write outside ${dir}`);
  }
  return file;
}

function loadConfig(root) {
  let onDisk = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(coordPath(root, 'config.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) onDisk = parsed;
  } catch (_) {
    // A missing or unreadable config is not an error: defaults are the contract.
  }
  return Object.assign({}, DEFAULTS, onDisk);
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stamp() {
  return new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, 'Z');
}

function machine() {
  return sanitize(process.env.COORD_MACHINE || os.hostname(), LIMITS.machine);
}

// Anything that will be interpolated into an agent's context. Newlines and control
// characters are how injected text escapes its line and impersonates the harness.
function sanitize(value, max) {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function sanitizeClaims(value) {
  if (!Array.isArray(value)) return null;
  if (value.length > LIMITS.claims) return null;
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const clean = sanitize(entry, LIMITS.claim);
    if (clean.length !== entry.trim().length) return null;
    if (!isResourceToken(clean) && globStarCount(clean) > LIMITS.globStars) return null;
    out.push(clean);
  }
  return out;
}

function globStarCount(pattern) {
  const collapsed = String(pattern).replace(/\*+/g, '*');
  return (collapsed.match(/\*/g) || []).length;
}

function readIntents(root) {
  const dir = coordPath(root, 'intents');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch (_) {
    return [];
  }
  return names.map((name) => {
    const file = path.join(dir, name);
    const handle = name.replace(/\.json$/, '');
    const bad = (error) => ({ handle: sanitize(handle, LIMITS.handle), file, data: null, malformed: true, error });

    if (!isValidHandle(handle)) return bad('filename is not a valid handle');

    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return bad(String(err.message || err));
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not a JSON object');

    const claims = sanitizeClaims(raw.claims === undefined ? [] : raw.claims);
    const exclusive = sanitizeClaims(raw.exclusive === undefined ? [] : raw.exclusive);
    // A string where an array belongs used to throw inside the guard, and the hook
    // swallowed it: one malformed intent silently disabled every lock in the repo.
    if (claims === null || exclusive === null) {
      return bad('claims/exclusive must be arrays of short glob strings');
    }

    return {
      handle,
      file,
      malformed: false,
      data: {
        session_id: sanitize(raw.session_id, LIMITS.handle),
        handle,
        machine: sanitize(raw.machine, LIMITS.machine),
        task: sanitize(raw.task, LIMITS.task),
        claims,
        exclusive,
        started: sanitize(raw.started, 40),
        updated: sanitize(raw.updated, 40),
      },
    };
  });
}

function ageHours(intent) {
  const raw = intent.data && intent.data.updated;
  if (!raw) return Infinity;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 3600000;
}

function isFresh(intent, cfg) {
  return !intent.malformed && ageHours(intent) <= cfg.staleHours;
}

// Claim globs deliberately let '*' cross '/', so 'src/ui/*' covers the subtree.
// Matching is case-insensitive because two of the three common platforms are.
function globToRegex(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\*+/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + expanded + '$', 'i');
}

function normalizeClaim(claim) {
  return String(claim).replace(/\\/g, '/').replace(/^\/+/, '');
}

function isResourceToken(claim) {
  return normalizeClaim(claim).startsWith('#');
}

function claimMatches(relPath, claim) {
  if (typeof claim !== 'string') return false;
  if (isResourceToken(claim)) return false;
  const normalized = normalizeClaim(claim);
  // Defence in depth: readIntents already rejects these, but claimMatches is exported.
  if (normalized.length > LIMITS.claim || globStarCount(normalized) > LIMITS.globStars) return false;
  return globToRegex(normalized).test(relPath);
}

function relFromRoot(root, target) {
  const abs = path.resolve(target);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, '/');
}

// Returns every fresh intent from another session that claims this path.
function overlapsFor(root, cfg, relPath, ownSessionId) {
  const hits = { exclusive: [], advisory: [] };
  for (const intent of readIntents(root)) {
    if (!isFresh(intent, cfg)) continue;
    const d = intent.data;
    if (ownSessionId && d.session_id && d.session_id === ownSessionId) continue;

    const lock = d.exclusive.find((c) => claimMatches(relPath, c));
    if (lock) {
      hits.exclusive.push({ intent, claim: lock });
      continue;
    }
    const claim = d.claims.find((c) => claimMatches(relPath, c));
    if (claim) hits.advisory.push({ intent, claim });
  }
  return hits;
}

function splitEvents(text) {
  const lines = text.split(/\r?\n/);
  const header = [];
  let i = 0;
  while (i < lines.length && !lines[i].startsWith('- ')) {
    header.push(lines[i]);
    i += 1;
  }
  const events = lines.slice(i).filter((l) => l.trim().length > 0);
  return { header, events };
}

function readEventsFile(root) {
  try {
    return fs.readFileSync(coordPath(root, 'events.md'), 'utf8');
  } catch (_) {
    return EVENTS_HEADER + '\n\n';
  }
}

function writeEventsFileAtomic(root, header, events) {
  const body = header.join('\n').replace(/\s+$/, '') + '\n\n' + events.join('\n') + '\n';
  const target = coordPath(root, 'events.md');
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, target);
}

function endsWithNewline(file) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    if (size === 0) return true;
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(1);
    fs.readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } catch (_) {
    return true;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// O_APPEND, not read-modify-write: concurrent sessions posting at once is the
// entire premise of this tool, and a rewrite would drop one of the two events.
function appendEvent(root, handle, text) {
  const file = coordPath(root, 'events.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, EVENTS_HEADER + '\n\n', 'utf8');
  const who = handle ? `[${sanitize(handle, LIMITS.handle)}@${machine()}]` : `[${machine()}]`;
  const line = `- ${stamp()} ${who} ${sanitize(String(text), 2000)}`;
  fs.appendFileSync(file, (endsWithNewline(file) ? '' : '\n') + line + '\n', 'utf8');
}

// Keeps the bulletin small: its tail is injected into every session's startup.
function rotateEvents(root, cfg) {
  const { header, events } = splitEvents(readEventsFile(root));
  if (events.length <= cfg.rotateWhenLines) return 0;
  const keep = events.slice(-cfg.rotateKeepLines);
  const archived = events.slice(0, events.length - cfg.rotateKeepLines);
  const archivePath = coordPath(root, 'events-archive.md');
  let existing = '';
  try {
    existing = fs.readFileSync(archivePath, 'utf8').replace(/\s+$/, '') + '\n';
  } catch (_) {
    existing = '# Archived coordination events (rotated out of events.md)\n\n';
  }
  // Archive first: a crash between the two leaves a duplicate, never a hole.
  fs.writeFileSync(archivePath, existing + archived.join('\n') + '\n', 'utf8');
  writeEventsFileAtomic(root, header, keep);
  return archived.length;
}

function tailEvents(root, count) {
  const { events } = splitEvents(readEventsFile(root));
  return events.slice(-count).map((line) => sanitize(line, 2000));
}

function saveIntent(root, handle, intent) {
  fs.writeFileSync(intentPath(root, handle), JSON.stringify(intent, null, 2) + '\n', 'utf8');
}

function deleteIntent(root, handle) {
  let file;
  try {
    file = intentPath(root, handle);
  } catch (_) {
    return false;
  }
  try {
    fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function sessionId(explicit) {
  return sanitize(
    (typeof explicit === 'string' && explicit) ||
      process.env.COORD_SESSION_ID ||
      process.env.CLAUDE_SESSION_ID ||
      '',
    LIMITS.handle
  );
}

module.exports = {
  COORD_DIR,
  DEFAULTS,
  LIMITS,
  EVENTS_HEADER,
  findRoot,
  coordPath,
  intentPath,
  isValidHandle,
  sanitize,
  loadConfig,
  nowIso,
  stamp,
  machine,
  readIntents,
  ageHours,
  isFresh,
  claimMatches,
  isResourceToken,
  normalizeClaim,
  globStarCount,
  relFromRoot,
  overlapsFor,
  appendEvent,
  rotateEvents,
  tailEvents,
  saveIntent,
  deleteIntent,
  sessionId,
};
