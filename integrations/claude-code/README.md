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
| `SessionStart` | Injects the live intents and the recent events into the session's context. |
| `PreToolUse` on `Edit\|Write\|NotebookEdit` | Attaches a notice when writing to an advisory claim. Denies a write into an exclusive lock. |
| `SessionEnd` | Deletes the ending session's own intent, prunes stale ones, rotates the bulletin. |

`SessionEnd` is a safety net, not a substitute for `coordboard wrap`. It cannot summarize the
work, and it does not fire on a crash. The staleness threshold covers the crash case on the
next session's sweep.

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
receive the coord notice before the write lands.
