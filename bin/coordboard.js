#!/usr/bin/env node
'use strict';

const commands = require('../src/commands');

const USAGE = `coordboard - coordination board for parallel AI coding agents

  coordboard init [--shared] [--force]
      Create .coord/ here. Default is local mode: .coord/ is added to .gitignore
      and never leaves this machine. --shared commits it so it syncs via git.
      Refuses a directory with no .git in it unless --force.

  coordboard register --handle <name> --task "<one line>"
                      [--claims "a/*,b.ts"] [--exclusive "gen/*"] [--session-id <id>]
                      [--validates <handle>] [--force]
      Declare what this session is doing and which paths it will touch, before
      the first edit. Run again with the same handle to update the claims.
      Refuses to register when one live session already claims every path you
      named: that is the same work twice, so it prints the --validates command
      to check their work instead. --force registers anyway when the overlap is
      real files but different work.

      --validates <handle> registers this session as the checker of a live
      session's work. It posts an event so they know, and their claims stop
      reading as a conflict for you.

  coordboard check [--path <file>] [--json]
      Who else is live, what they claim, and the recent events. With --path,
      also reports the claims on that one file.

  coordboard who [--path <file>]
      Which live sessions are in this repo, and the address to message each one at.
      With --path, who claims that one file and how to reach them. Addresses are
      resolved live, so a session that has exited reports as unreachable rather than
      handing you a name that swallows messages.

  coordboard event "<one line>" [--handle <name>]
      Post a live signal other sessions should act on.

  coordboard wrap --handle <name> [--summary "<what you did>"]
      Post the wrap event, release your intent, prune stale ones, rotate.

  coordboard sweep
      Maintenance: prune stale intents, list held locks, rotate the bulletin,
      report scratch files that do not belong in .coord/.

  coordboard hooks claude-code
      Print the settings.json snippet that wires the enforcing hooks.

  coordboard mesh up | status | down
      The cross-machine mesh: one daemon per machine, hub elected among them.
      Configure peers in ~/.coordboard/mesh.json: {"nodes": ["laptop", "bot"],
      "port": 7717, "priority": 0, "user": "max"}. Highest priority hosts the hub;
      at equal priority the first machine up keeps it.

  coordboard mesh send --to <session name|handle|session id> "<text>"
      Message a session on any machine; it arrives on that session's next hook.

  coordboard mesh review [user|session]
      Read another user's or session's work: task, claims, and the last hour's
      patches. Sessions get pushed edits, claim warnings and the startup roster
      only from their own user, plus any user named in mesh.json "collaborate".

Hook adapters (read hook JSON on stdin, not for humans):
  coordboard guard | coordboard session-start | coordboard session-end | coordboard mesh-hook
`;

const HOOK_SNIPPET = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: 'command', command: 'coordboard session-start' }] },
      { hooks: [{ type: 'command', command: 'coordboard mesh-hook' }] },
    ],
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|NotebookEdit',
        hooks: [
          { type: 'command', command: 'coordboard guard' },
          { type: 'command', command: 'coordboard mesh-hook' },
        ],
      },
    ],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'coordboard mesh-hook' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'coordboard mesh-hook' }] }],
    SessionEnd: [
      { hooks: [{ type: 'command', command: 'coordboard session-end' }] },
    ],
  },
};

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  try {
    switch (command) {
      case 'init':
        return console.log(commands.init(opts));
      case 'register':
        return console.log(commands.register(opts));
      case 'check':
        return console.log(commands.check(opts));
      case 'event':
        return console.log(commands.event(opts));
      case 'wrap':
        return console.log(commands.wrap(opts));
      case 'sweep':
        return console.log(commands.sweep(opts));
      case 'who':
        return console.log(commands.who(opts));
      case 'guard':
        return process.stdout.write(commands.guard());
      case 'session-start':
        return process.stdout.write(commands.sessionStart());
      case 'session-end':
        return process.stdout.write(commands.sessionEnd());
      case 'mesh':
        return commands
          .mesh(opts)
          .then((out) => out && console.log(out))
          .catch((err) => {
            console.error(String(err.message || err));
            process.exit(1);
          });
      case 'mesh-hook':
        // Async, so the sync catch below cannot see its failures: swallow them here.
        return require('../src/meshhooks')
          .run()
          .then((out) => process.stdout.write(out))
          .catch(() => process.exit(0));
      case 'hooks': {
        if (opts._[0] !== 'claude-code') {
          console.error('Usage: coordboard hooks claude-code');
          process.exit(1);
        }
        return console.log(JSON.stringify(HOOK_SNIPPET, null, 2));
      }
      case 'help':
      case '--help':
      case '-h':
      case undefined:
        return console.log(USAGE);
      default:
        console.error(`Unknown command '${command}'.\n\n${USAGE}`);
        process.exit(1);
    }
  } catch (err) {
    // Hook adapters must never break the editor: fail silent, exit clean.
    if (['guard', 'session-start', 'session-end'].includes(command)) process.exit(0);
    console.error(String(err.message || err));
    process.exit(1);
  }
}

main();
