# Agent Coordination Board

A coordination board for parallel AI coding agents working in the same repo.

Run three or four agent sessions on one codebase and they cannot see each other. Two of them
refactor the same function, a third reverts a fix a fourth just landed, and none of them
knows until you read the diff. This is a small protocol, plus a CLI to keep it well formed,
that lets them declare what they are touching and read what everyone else is touching.

It is deliberately not a lock manager. **Overlap notifies; it does not block.** Two agents in
one file is normal, and an agent that stalls because a file "is taken" is worse than a merge.
Hard locks exist as a separate, narrow tier for the cases that genuinely serialize.

## Install

```
npm install -g agent-coordination-board
```

Node 18 or newer, no dependencies.

## Quickstart

In the repo you want coordinated:

```
coordboard init
```

That creates `.coord/` and adds it to `.gitignore`. Coordination state stays on your machine.

Then teach your agents three commands. Before their first edit:

```
coordboard register --handle auth-refactor \
  --task "Split the session middleware out of auth.ts" \
  --claims "src/auth/*,src/middleware/session.ts"
```

Any time they want to know what else is live:

```
coordboard check                    # everyone's intents plus the recent events
coordboard check --path src/auth.ts # who else claims this one file
```

And when they finish:

```
coordboard wrap --handle auth-refactor --summary "Session middleware now lives in src/middleware/session.ts; auth.ts re-exports for one release."
```

`coordboard sweep` clears stale intents, forgotten locks, and an overgrown events bulletin.

## How agents learn to use it

Put a short section in whatever instructions file your agent reads (`CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, a system prompt) telling it to register before editing and to run
`coordboard check` when it wants to know who else is in a file.
[`docs/PROTOCOL.md`](docs/PROTOCOL.md) is written to be pasted or linked directly.

## Enforcement, and where it stops

The CLI works with any agent that can run a shell command, but it is **cooperative**: an
agent that never calls it is invisible to everyone else.

Claude Code can do better, because it can intercept a write. Wire up the hooks:

```
coordboard hooks claude-code
```

and paste the result into `~/.claude/settings.json` (details in
[`integrations/claude-code`](integrations/claude-code)). Then:

- **SessionStart** injects the live intents and the recent events into every session.
- **PreToolUse** on `Edit`/`Write`/`NotebookEdit` attaches a notice when a claimed path is
  about to be written, and denies a write into an exclusive lock.
- **SessionEnd** releases the session's intent, prunes stale ones, and rotates the bulletin.

No other agent CLI can currently intercept a write, so on those the board is advisory only.
If your tool grows a pre-write hook, the adapter is one command and a pull request.

## What is in `.coord/`

```
.coord/
  config.json         thresholds and mode
  events.md           the bulletin; its tail is read into every session
  events-archive.md   older events, rotated out
  intents/
    <handle>.json     one per live session
```

## The design

The protocol is the interesting half, and it is short:
[**docs/PROTOCOL.md**](docs/PROTOCOL.md).

The three ideas worth stealing even if you never install this:

1. **Two tiers of claim.** Advisory by default, hard locks as a narrow exception. Agents that
   are blocked by default stop doing work you asked for.
2. **The bulletin is a signal channel, not a log.** Only a few lines reach each new session,
   so an event has to earn its slot: would another session, live right now, act differently
   because of this? If not, it belongs in an auto-loading rule file instead.
3. **An event is a report, not a source of truth.** One session's account at one moment.
   Verify against the source before acting on it.

## Status

`0.1.0`. The protocol has been in daily use on one large repo with several concurrent agent
sessions; this package is that protocol extracted and rewritten as a single portable
implementation. Interfaces may still move. Issues and pull requests welcome, particularly
adapters for other agent CLIs.

## License

MIT
