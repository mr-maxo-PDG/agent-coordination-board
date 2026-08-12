'use strict';

const fs = require('fs');
const path = require('path');
const core = require('./core');

function requireRoot(opts) {
  const root = core.findRoot(opts.cwd || process.cwd());
  if (!root) {
    throw new Error(
      'No .coord/ directory found in this directory or any parent. Run `coordboard init` at the repo root first.'
    );
  }
  return root;
}

function list(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function describeIntent(intent) {
  if (intent.malformed) return `${intent.handle}: MALFORMED (${intent.error})`;
  const d = intent.data;
  const age = core.ageHours(intent);
  const claims = (d.claims || []).join(', ') || 'none';
  const locks = (d.exclusive || []).join(', ');
  const lockNote = locks ? ` | EXCLUSIVE: ${locks}` : '';
  return `${intent.handle} [${d.machine || '?'}]: ${d.task || '(no task)'} | claims: ${claims}${lockNote} | updated ${age.toFixed(1)}h ago`;
}

// ---------------------------------------------------------------- init

function init(opts) {
  const root = path.resolve(opts.cwd || process.cwd());
  const dir = path.join(root, core.COORD_DIR);
  fs.mkdirSync(path.join(dir, 'intents'), { recursive: true });

  const eventsFile = path.join(dir, 'events.md');
  if (!fs.existsSync(eventsFile)) {
    fs.writeFileSync(eventsFile, core.EVENTS_HEADER + '\n\n', 'utf8');
  }

  const mode = opts.shared ? 'shared' : 'local';
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) {
    fs.writeFileSync(
      configFile,
      JSON.stringify(Object.assign({}, core.DEFAULTS, { mode }), null, 2) + '\n',
      'utf8'
    );
  }

  const gitignore = path.join(root, '.gitignore');
  let ignoreNote;
  if (mode === 'local') {
    let text = '';
    try {
      text = fs.readFileSync(gitignore, 'utf8');
    } catch (_) {}
    if (/^\.coord\/?\s*$/m.test(text)) {
      ignoreNote = '.gitignore already excludes .coord/';
    } else {
      const prefix = text && !text.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(gitignore, `${prefix}\n# agent coordination board (local, not shared)\n.coord/\n`, 'utf8');
      ignoreNote = 'added .coord/ to .gitignore';
    }
  } else {
    ignoreNote = 'shared mode: .coord/ is meant to be committed, check .gitignore does not exclude it';
  }

  return [
    `Initialized ${core.COORD_DIR}/ at ${root} in ${mode} mode.`,
    ignoreNote,
    '',
    'Next: each agent session runs `coordboard register` before its first edit.',
  ].join('\n');
}

// ------------------------------------------------------------ register

function register(opts) {
  const root = requireRoot(opts);
  if (!opts.handle) throw new Error('register needs --handle (short kebab-case name for this task)');
  if (!opts.task) throw new Error('register needs --task "one line describing what this session is doing"');

  const claims = list(opts.claims);
  if (claims.some((c) => core.normalizeClaim(c) === '*')) {
    throw new Error('Refusing to claim the repo root (*). Claim the paths you will actually edit.');
  }

  const now = core.nowIso();
  const existingFile = core.coordPath(root, 'intents', `${opts.handle}.json`);
  let started = now;
  try {
    started = JSON.parse(fs.readFileSync(existingFile, 'utf8')).started || now;
  } catch (_) {}

  const intent = {
    session_id: core.sessionId(opts.sessionId),
    handle: opts.handle,
    machine: core.machine(),
    task: String(opts.task).replace(/\r?\n/g, ' ').trim(),
    claims,
    exclusive: list(opts.exclusive),
    started,
    updated: now,
  };
  core.saveIntent(root, opts.handle, intent);

  const out = [`Registered intent '${opts.handle}'.`];
  const others = core.readIntents(root).filter((i) => i.handle !== opts.handle);
  const cfg = core.loadConfig(root);
  const live = others.filter((i) => core.isFresh(i, cfg));
  if (live.length === 0) {
    out.push('No other live sessions.');
  } else {
    out.push('', 'Other live sessions:');
    live.forEach((i) => out.push('  - ' + describeIntent(i)));
    const collisions = [];
    for (const i of live) {
      for (const mine of claims) {
        const theirs = [...(i.data.claims || []), ...(i.data.exclusive || [])];
        if (theirs.some((t) => core.normalizeClaim(t) === core.normalizeClaim(mine))) {
          collisions.push(`${i.handle} also claims ${mine}`);
        }
      }
    }
    if (collisions.length) {
      out.push('', 'Overlap with your claims (advisory, not a block):');
      collisions.forEach((c) => out.push('  - ' + c));
      out.push('Read their intent and the events tail before editing shared paths.');
    }
  }
  return out.join('\n');
}

// -------------------------------------------------------------- check

function check(opts) {
  const root = requireRoot(opts);
  const cfg = core.loadConfig(root);
  const intents = core.readIntents(root);
  const fresh = intents.filter((i) => core.isFresh(i, cfg));
  const stale = intents.filter((i) => !core.isFresh(i, cfg));
  const own = core.sessionId(opts.sessionId);

  let pathReport = null;
  if (opts.path) {
    const rel = core.relFromRoot(root, opts.path);
    if (rel === null) throw new Error(`${opts.path} is outside the coordinated repo at ${root}`);
    pathReport = { path: rel, ...core.overlapsFor(root, cfg, rel, own) };
  }

  if (opts.json) {
    return JSON.stringify(
      {
        root,
        mode: cfg.mode,
        live: fresh.map((i) => i.data),
        stale: stale.map((i) => ({ handle: i.handle, malformed: i.malformed })),
        events: core.tailEvents(root, cfg.startupTailLines),
        path: pathReport && {
          path: pathReport.path,
          exclusive: pathReport.exclusive.map((h) => ({ handle: h.intent.handle, claim: h.claim })),
          advisory: pathReport.advisory.map((h) => ({ handle: h.intent.handle, claim: h.claim })),
        },
      },
      null,
      2
    );
  }

  const out = [`Coordination board at ${root} (${cfg.mode} mode)`];
  out.push('', fresh.length ? 'Live sessions:' : 'Live sessions: none');
  fresh.forEach((i) => out.push('  - ' + describeIntent(i)));
  if (stale.length) {
    out.push('', `Stale or malformed (ignored, > ${cfg.staleHours}h or unparseable):`);
    stale.forEach((i) => out.push('  - ' + i.handle));
    out.push('Clear them with `coordboard sweep`.');
  }
  if (pathReport) {
    out.push('', `Claims on ${pathReport.path}:`);
    if (!pathReport.exclusive.length && !pathReport.advisory.length) {
      out.push('  none');
    }
    pathReport.exclusive.forEach((h) =>
      out.push(`  - EXCLUSIVE LOCK by ${h.intent.handle} (${h.claim}). Do not edit; coordinate first.`)
    );
    pathReport.advisory.forEach((h) =>
      out.push(`  - advisory claim by ${h.intent.handle} (${h.claim}). Not a block; check for real conflict.`)
    );
  }
  const tail = core.tailEvents(root, cfg.startupTailLines);
  if (tail.length) {
    out.push('', 'Recent events:');
    tail.forEach((e) => out.push('  ' + e));
  }
  if (cfg.mode === 'shared') {
    out.push('', 'Shared mode: this state is only as fresh as the last git pull.');
  }
  return out.join('\n');
}

// -------------------------------------------------------------- event

function event(opts) {
  const root = requireRoot(opts);
  const text = opts.message || opts._[0];
  if (!text) throw new Error('event needs a message');
  core.appendEvent(root, opts.handle, text);
  const archived = core.rotateEvents(root, core.loadConfig(root));
  return archived
    ? `Posted. Rotated ${archived} older events into events-archive.md.`
    : 'Posted.';
}

// --------------------------------------------------------------- wrap

function wrap(opts) {
  const root = requireRoot(opts);
  const cfg = core.loadConfig(root);
  const out = [];

  if (opts.summary) {
    core.appendEvent(root, opts.handle, opts.summary);
    out.push('Posted wrap event.');
  } else {
    out.push('No --summary given, so nothing was posted. The hook cannot summarize your work; only you can.');
  }

  if (opts.handle && core.deleteIntent(root, opts.handle)) {
    out.push(`Released intent '${opts.handle}'.`);
  }

  const pruned = pruneStale(root, cfg);
  if (pruned.length) out.push(`Pruned stale intents: ${pruned.join(', ')}.`);

  const archived = core.rotateEvents(root, cfg);
  if (archived) out.push(`Rotated ${archived} older events into events-archive.md.`);

  const left = core.readIntents(root);
  out.push(left.length ? `${left.length} intent(s) still registered.` : 'Intents folder is now empty.');
  return out.join('\n');
}

function pruneStale(root, cfg) {
  const pruned = [];
  for (const intent of core.readIntents(root)) {
    if (core.isFresh(intent, cfg)) continue;
    if (core.deleteIntent(root, intent.handle)) pruned.push(intent.handle);
  }
  if (pruned.length) {
    core.appendEvent(root, 'coordboard', `pruned stale intents: ${pruned.join(', ')}`);
  }
  return pruned;
}

// -------------------------------------------------------------- sweep

function sweep(opts) {
  const root = requireRoot(opts);
  const cfg = core.loadConfig(root);
  const out = [`Sweeping ${root}.`];

  const pruned = pruneStale(root, cfg);
  out.push(pruned.length ? `Pruned: ${pruned.join(', ')}.` : 'No stale intents.');

  const locks = core
    .readIntents(root)
    .filter((i) => !i.malformed && (i.data.exclusive || []).length);
  if (locks.length) {
    out.push('', 'Exclusive locks still held (these block other sessions, confirm each is still needed):');
    locks.forEach((i) => out.push(`  - ${i.handle}: ${i.data.exclusive.join(', ')}`));
  }

  const archived = core.rotateEvents(root, cfg);
  out.push('', archived ? `Rotated ${archived} events into events-archive.md.` : 'Bulletin under the rotation threshold.');

  const sanctioned = new Set(['README.md', 'events.md', 'events-archive.md', 'config.json', 'intents']);
  let strays = [];
  try {
    strays = fs
      .readdirSync(core.coordPath(root))
      .filter((n) => !sanctioned.has(n));
  } catch (_) {}
  if (strays.length) {
    out.push('', 'Unsanctioned entries in .coord/ (scratch files belong elsewhere, review before deleting):');
    strays.forEach((s) => out.push('  - ' + s));
  }
  return out.join('\n');
}

// ------------------------------------------------- editor hook adapters

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function parseHookInput() {
  try {
    return JSON.parse(readStdin()) || {};
  } catch (_) {
    return {};
  }
}

// PreToolUse on Edit/Write/NotebookEdit. Exclusive locks deny; claims notify.
function guard() {
  const input = parseHookInput();
  const target =
    (input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || null;
  if (!target) return '';

  const root = core.findRoot(path.dirname(path.resolve(target)));
  if (!root) return '';
  const rel = core.relFromRoot(root, target);
  if (rel === null) return '';

  const cfg = core.loadConfig(root);
  const hits = core.overlapsFor(root, cfg, rel, input.session_id);

  if (hits.exclusive.length) {
    const h = hits.exclusive[0];
    const reason =
      `coord guard (exclusive lock): '${rel}' is exclusively locked by session '${h.intent.handle}' ` +
      `on machine '${h.intent.data.machine}' for serialized work (task: ${h.intent.data.task}; lock: '${h.claim}'). ` +
      `This is a genuine block, not an overlap. Do not route around it with shell writes. Options: post to ` +
      `.coord/events.md, prepare a merge-ready change to apply once the lock lifts, or switch to unclaimed work. ` +
      `If that session is confirmed dead, run \`coordboard sweep\` and retry.`;
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    });
  }

  if (hits.advisory.length) {
    const who = hits.advisory
      .map((h) => `'${h.intent.handle}' (@${h.intent.data.machine}, task: ${h.intent.data.task}; claim: '${h.claim}')`)
      .join('; ');
    const note =
      `coord notice: '${rel}' is also claimed (advisory, not a lock) by ${who}. This does NOT block you. ` +
      `If your change is independent of theirs (different function, region or feature), proceed and post a one-line ` +
      `event so they are not surprised by the diff. If it genuinely conflicts, reconcile the two changes rather than ` +
      `clobbering or stopping.`;
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note },
    });
  }
  return '';
}

function sessionStart() {
  const input = parseHookInput();
  const root = core.findRoot(input.cwd || process.cwd());
  if (!root) return '';
  const cfg = core.loadConfig(root);
  const intents = core.readIntents(root).filter((i) => core.isFresh(i, cfg));

  const lines = [
    'This repo uses .coord/ cross-session coordination. If this session will EDIT files here, run',
    '`coordboard register --handle <name> --task "<one line>" --claims "<paths>"` before your first edit.',
    'Read-only sessions need no intent.',
  ];
  if (input.session_id) lines.push(`Your session_id: ${input.session_id}`);
  lines.push('', intents.length ? 'Current intents:' : 'Current intents: none');
  intents.forEach((i) => lines.push('- ' + describeIntent(i)));
  const tail = core.tailEvents(root, cfg.startupTailLines);
  if (tail.length) {
    lines.push('', 'Recent events:');
    tail.forEach((e) => lines.push(e));
  }
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
  });
}

function sessionEnd() {
  const input = parseHookInput();
  const root = core.findRoot(input.cwd || process.cwd());
  if (!root) return '';
  const cfg = core.loadConfig(root);

  if (input.session_id) {
    for (const intent of core.readIntents(root)) {
      if (!intent.malformed && intent.data.session_id === input.session_id) {
        core.appendEvent(root, intent.handle, 'session ended - intent auto-cleared on exit');
        core.deleteIntent(root, intent.handle);
      }
    }
  }
  pruneStale(root, cfg);
  core.rotateEvents(root, cfg);
  return '';
}

module.exports = { init, register, check, event, wrap, sweep, guard, sessionStart, sessionEnd };
