'use strict';

// Shared state and file handling for the coordination board.
// Every command and every editor hook goes through this module, so thresholds
// and claim matching have exactly one implementation.

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

const EVENTS_HEADER = '# Coordination events (append-only; newest last)';

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, COORD_DIR, 'intents'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function coordPath(root, ...rest) {
  return path.join(root, COORD_DIR, ...rest);
}

function loadConfig(root) {
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(coordPath(root, 'config.json'), 'utf8'));
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
  return process.env.COORD_MACHINE || os.hostname();
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
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { handle, file, data, malformed: false };
    } catch (err) {
      return { handle, file, data: null, malformed: true, error: String(err.message || err) };
    }
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
  const expanded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + expanded + '$', 'i');
}

function normalizeClaim(claim) {
  return String(claim).replace(/\\/g, '/').replace(/^\/+/, '');
}

function isResourceToken(claim) {
  return normalizeClaim(claim).startsWith('#');
}

function claimMatches(relPath, claim) {
  if (isResourceToken(claim)) return false;
  return globToRegex(normalizeClaim(claim)).test(relPath);
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

    const lock = (d.exclusive || []).find((c) => claimMatches(relPath, c));
    if (lock) {
      hits.exclusive.push({ intent, claim: lock });
      continue;
    }
    const claim = (d.claims || []).find((c) => claimMatches(relPath, c));
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

function writeEventsFile(root, header, events) {
  const body = header.join('\n').replace(/\s+$/, '') + '\n\n' + events.join('\n') + '\n';
  fs.writeFileSync(coordPath(root, 'events.md'), body, 'utf8');
}

function appendEvent(root, handle, text) {
  const { header, events } = splitEvents(readEventsFile(root));
  const who = handle ? `[${handle}@${machine()}]` : `[${machine()}]`;
  events.push(`- ${stamp()} ${who} ${String(text).replace(/\r?\n/g, ' ').trim()}`);
  writeEventsFile(root, header, events);
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
  fs.writeFileSync(archivePath, existing + archived.join('\n') + '\n', 'utf8');
  writeEventsFile(root, header, keep);
  return archived.length;
}

function tailEvents(root, count) {
  const { events } = splitEvents(readEventsFile(root));
  return events.slice(-count);
}

function saveIntent(root, handle, intent) {
  fs.writeFileSync(
    coordPath(root, 'intents', `${handle}.json`),
    JSON.stringify(intent, null, 2) + '\n',
    'utf8'
  );
}

function deleteIntent(root, handle) {
  try {
    fs.unlinkSync(coordPath(root, 'intents', `${handle}.json`));
    return true;
  } catch (_) {
    return false;
  }
}

function sessionId(explicit) {
  return (
    explicit ||
    process.env.COORD_SESSION_ID ||
    process.env.CLAUDE_SESSION_ID ||
    ''
  );
}

module.exports = {
  COORD_DIR,
  DEFAULTS,
  EVENTS_HEADER,
  findRoot,
  coordPath,
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
  relFromRoot,
  overlapsFor,
  appendEvent,
  rotateEvents,
  tailEvents,
  saveIntent,
  deleteIntent,
  sessionId,
};
