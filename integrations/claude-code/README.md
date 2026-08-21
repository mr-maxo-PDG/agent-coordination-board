# Claude Code integration

Claude Code is the one agent CLI that can enforce the board rather than merely cooperate
with it, because its hooks can intercept a write before it happens.

## Wire the hooks

```
coordboard hooks claude-code
```

Merge the printed object into the `hooks` block of `~/.claude/settings.json` (user level, so
it applies to every repo) or `.claude/settings.json` (this repo only). The hooks are inert in
any directory without a `.coord/`, so user level is usually right.

What each one does:

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the live intents and the recent events, plus how many sessions are live in this repo with no intent at all. |
| `PreToolUse` on `Edit\|Write\|NotebookEdit` | Attaches a notice when writing to an advisory claim, naming the address of whoever claims it. Denies a write into an exclusive lock. |
| `SessionEnd` | Deletes the ending session's own intent, prunes stale ones, rotates the bulletin. |

`SessionEnd` is a safety net, not a substitute for `coordboard wrap`. It cannot summarize the
work, and it does not fire on a crash. `coordboard sweep` covers the crash case: where the
session registry is readable it releases intents whose process is actually gone, so a crashed
session's exclusive lock lifts immediately instead of after the staleness threshold.

## Peer session discovery

Claude Code maintains a machine-local registry of its live sessions under
`~/.claude/sessions/` (or `$CLAUDE_CONFIG_DIR/sessions/`), holding each session's id, working
directory, status, and the **name** its siblings use to message it. `src/peers.js` reads it,
which is what makes three things possible:

- `coordboard who` resolves a claim, or a file, to the name you can `SendMessage`.
- `coordboard check` lists sessions editing this repo that never registered. The write guard
  cannot warn anyone about those, because they declared no claims.
- `coordboard sweep` releases intents whose session has exited, on evidence rather than a
  clock.

Addresses are resolved on every read and never stored in an intent, because a session's name
is derived and can change while it runs.

**This reads another program's private state.** The layout is not a public interface. Every
record is validated and every failure path returns empty, so if the format moves the board
degrades to exactly its pre-messaging behaviour: intents, claims, locks and the bulletin all
keep working, and only the addresses disappear. The adapter is pinned to `peerProtocol: 1`
and skips records announcing anything else. `test/run.js` builds a fake registry, so a shape
change surfaces as a red test rather than as a board that quietly reports no sessions.

## Install the skill

Copy `skills/coord/` into `~/.claude/skills/` so Claude invokes the protocol on its own:

```
cp -r skills/coord ~/.claude/skills/coord
```

Without the skill, Claude will see the hook output but has no instructions for what to do
about an overlap. With it, the whole protocol is one `Skill` call away.

## Verify

In a repo where you have run `coordboard init`, from two sessions:

```
# session one
coordboard register --handle demo-a --task "editing the parser" --claims "src/parser.ts"

# session two
coordboard check --path src/parser.ts
```

Session two should report the advisory claim. Have it edit `src/parser.ts` and Claude should
receive the coord notice before the write lands, with session one's address in it.

Then check the directory resolves:

```
coordboard who --path src/parser.ts
```

That should name `demo-a` and print an address. If it says the session has exited while
session one is plainly still running, the intent was registered without a session id: re-run
`register` from inside that session.
