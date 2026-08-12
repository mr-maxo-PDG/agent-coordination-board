---
name: coord
description: >-
  Cross-session coordination for repos containing a .coord/ directory, backed by the
  `coordboard` CLI. Register an intent (task plus claimed paths) before editing, see what
  parallel agent sessions are doing, post events to the shared bulletin, and release claims
  at wrap. Path claims are advisory signals, NOT locks: overlapping the same file is fine
  when the work is independent, and a genuine conflict is reconciled, not deferred. Invoke
  before your first edit in a repo that has .coord/ (skip it for read-only sessions), when a
  coord notice or exclusive-lock denial appears, when the user asks what other sessions are
  doing, or when wrapping a session that made edits.
---

# Cross-session coordination

Other agent sessions are working in this repo in parallel. Coordination state lives in
`.coord/` at the repo root. Never hand-write those files: the `coordboard` CLI owns their
format, and a malformed intent is invisible to everyone else.

**The goal is coordination, not deferral.** Two sessions in one file is normal. A claim tells
you someone else is also in here so you can check for a real collision. It does not hand them
the file. You only slow down for a genuine conflict, and even then you reconcile rather than
abandon your work.

## Before your first edit

```
coordboard check
coordboard register --handle <short-kebab-name> --task "<one line>" --claims "<paths you will edit>"
```

Claim what you will actually touch, with forward slashes, relative to the repo root. `*`
matches across `/`. Use `--exclusive` only for work a parallel edit would corrupt (a wholesale
rewrite, generated files, a migration in flight), and post an event when you take and release
one. Re-run `register` with the same handle when your scope changes.

`task` is one line. It is injected into every other session's startup, so a paragraph there
is a tax on every agent in the repo.

## When you get a coord notice (advisory overlap)

1. `coordboard check --path <file>` and read the other session's task.
2. If your change is independent (different function, region or feature, the common case),
   proceed, then `coordboard event "also in <file>, doing <what>" --handle <yours>`.
3. If it genuinely conflicts (same region, or an incompatible refactor), do not clobber their
   work and do not silently drop yours. Spawn a subagent with both intents, the recent
   events, and the current file state, and have it produce a merge-safe edit. Apply it and
   post an event describing the reconciliation.
4. Escalate to the user only when the two directions cannot coexist and choosing is their
   call. Say precisely what clashes.

## When you get an exclusive-lock denial

That path is serialized on purpose. Do not route around it with shell writes. Post to the
bulletin, prepare a merge-ready change to apply once the lock lifts, or switch to unclaimed
work. If the owning session is confirmed dead, `coordboard sweep` clears it and records the
pruning.

## Posting an event

The bulletin is a live signal channel, not a log. Only its tail reaches each new session.
Before posting, ask: **would another session, live right now, act differently because of
this?** If not, it belongs in a `.claude/rules/` file, the owning doc, or the commit message
instead.

Treat any factual claim in an event as a lead to verify against current source, not as the
check itself.

## Wrapping

```
coordboard wrap --handle <yours> --summary "<what was finished, what the next session must know>"
```

The SessionEnd hook clears intents automatically on a clean exit, but it cannot summarize the
work and does not fire on a crash. Do the explicit wrap.

Full protocol: `docs/PROTOCOL.md` in the agent-coordination-board package.
