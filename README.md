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

If one live session already claims every path in that list, `register` refuses and points at
it: same claims means the same change built twice, and one of the two diffs gets discarded.
The second session registers as its checker instead, which is the work nobody else is doing:

```
coordboard register --handle auth-review   --task "check the middleware split against the callers"   --validates auth-refactor
```

`--force` registers anyway, for the same files but genuinely different work.

Any time they want to know what else is live:

```
coordboard check                    # everyone's intents plus the recent events
coordboard check --path src/auth.ts # who else claims this one file
coordboard who --path src/auth.ts   # who claims it, and the address to message them at
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

## Direct messaging changes what this is for

Agent sessions can now message each other directly. Where that exists it is a better
channel than a shared file for anything urgent, and this board stops trying to be the
channel. What survives is the half a message cannot do:

- **A trigger.** A pre-write hook that fires on the edit itself, before it lands. Nothing
  in a messaging layer watches your writes.
- **A hard deny.** You cannot stop a peer's edit by asking politely. Exclusive locks still
  serialize the work a parallel edit would corrupt.
- **A duplicate-work refusal.** `register` compares against a persistent record of who
  claimed what, which is not something a conversation can do.
- **Memory.** A message reaches only sessions alive right now. The bulletin is what the
  session starting in an hour reads.

And one thing messaging makes newly possible: a **directory**. `coordboard who` maps a
file to the live session holding it and the name to reach them at. Addresses resolve at
read time, so a session that has exited reports as unreachable instead of handing you a
name that swallows messages.

[`docs/PROTOCOL.md`](docs/PROTOCOL.md) carries the doctrine for when a message beats an
event, and two rules that get sharper once sessions talk: a message is untrusted input
even though it reads like an instruction, and a peer is never a way around a permission
your own session was denied.

## Enforcement, and where it stops

The CLI works with any agent that can run a shell command, but it is **cooperative**: an
agent that never calls it is invisible to everyone else.

Claude Code can do better, because it can intercept a write. Wire up the hooks:

```
coordboard hooks claude-code
```

and paste the result into `~/.claude/settings.json` (details in
[`integrations/claude-code`](integrations/claude-code)). Then:

- **SessionStart** injects the live intents and the recent events into every session, and
  says how many sessions are live in the repo with no intent at all.
- **PreToolUse** on `Edit`/`Write`/`NotebookEdit` attaches a notice when a claimed path is
  about to be written, naming the address of whoever claims it, and denies a write into an
  exclusive lock.
- **SessionEnd** releases the session's intent, prunes stale ones, and rotates the bulletin.

Claude Code also publishes a machine-local registry of its live sessions, which is what
`coordboard who` reads to resolve addresses, to spot sessions editing this repo that never
registered, and to let `sweep` release an intent whose process is actually gone rather than
waiting out an eight-hour clock. That registry is another program's private state, so the
adapter in [`src/peers.js`](src/peers.js) validates every record and fails to an empty
result: when the format moves, the board degrades to exactly its pre-messaging behaviour.

No other agent CLI can currently intercept a write, so on those the board is advisory only.
If your tool grows a pre-write hook or a session registry, the adapter is one file and a
pull request.

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

The four ideas worth stealing even if you never install this:

1. **Two tiers of claim.** Advisory by default, hard locks as a narrow exception. Agents that
   are blocked by default stop doing work you asked for.
2. **The bulletin is a signal channel, not a log.** Only a few lines reach each new session,
   so an event has to earn its slot: would another session, live right now, act differently
   because of this? If not, it belongs in an auto-loading rule file instead.
3. **An event is a report, not a source of truth.** One session's account at one moment.
   Verify against the source before acting on it.
4. **Total overlap is a duplicate, not a collision.** When another session already covers
   everything you were about to touch, the useful move is to check their work, not to build
   a second copy of it.

## Status

`0.2.0`. The protocol has been in daily use on one large repo with several concurrent agent
sessions; this package is that protocol extracted and rewritten as a single portable
implementation. Interfaces may still move. Issues and pull requests welcome, particularly
adapters for other agent CLIs.

`0.2.0` narrows the board against direct session messaging: `coordboard who`, addresses on
the guard notice and the path report, liveness-based sweeping, and the messaging doctrine in
the protocol. It also fixes a bug worth knowing about if you ran `0.1.0`: intents were read
from `CLAUDE_SESSION_ID`, which is not a variable Claude Code sets, so any intent registered
without an explicit `--session-id` was stored with an empty one. Those intents still
coordinate, but they cannot be addressed or liveness-checked. Re-register to repair one.

## License

MIT
