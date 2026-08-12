# The coordination protocol

This is the part that matters. The CLI is only a way to keep the files well formed.

## The stance: coordinate, do not defer

Two agent sessions editing the same file is normal and expected. A path claim tells you
*someone else is also in here* so you can check whether your changes collide. It does not
hand them the file.

Most coordination schemes for parallel agents are pure locks, and pure locks make agents
stall: the second session sees a claim, decides the file is taken, and either stops to ask
or quietly abandons work the user asked for. Both outcomes are worse than a merge.

So claims come in two tiers, and the split is the whole design:

| Tier | Effect | Use for |
|---|---|---|
| `claims[]` | **Advisory.** Overlap notifies, never blocks. | Everything, by default. |
| `exclusive[]` | **Hard lock.** Overlap is denied. | Work a parallel edit would corrupt: a wholesale file rewrite, generated or checked-in artifacts, a migration mid-flight. |

Default to an empty `exclusive` list. Most work needs none.

## Registering

Before the first edit, a session declares what it is doing:

```
coordboard register --handle membrane-perf \
  --task "Profile and fix the membrane draw path" \
  --claims "src/render/membrane*.ts,src/render/shaders/*"
```

Claim rules:

- Claim what you will actually edit. Narrow claims are the point: a claim so broad that it
  overlaps everyone signals nothing. Claiming the repo root is refused.
- Paths are repo-relative with forward slashes. `*` matches anything **including** `/`, so
  `src/ui/*` covers that whole subtree. Matching is case-insensitive.
- `#`-prefixed tokens claim non-file resources: `#port-3000`, `#gpu`, `#db-migrations`. The
  guard does not enforce these, so check other intents for them before taking the resource.
- Subagents share their parent's session id, so an orchestrator claims the union of what its
  agents will touch.
- When your scope changes, run `register` again with the same handle.
- Intents older than the stale threshold (default 8 hours) stop blocking and stop notifying.
- **`task` is one line, and it is not free.** Every live intent is injected into every
  session's startup, so a paragraph here is a tax on every other agent.

## On overlap

An advisory overlap is a prompt to think, not a stop sign:

1. Read the other session's intent and the recent events to see what they are doing there.
2. Decide whether your change actually collides:
   - **Independent** (different function, region or feature, which is the common case):
     proceed. Post a one-line event so they are not surprised by the diff. No permission
     needed, no waiting.
   - **Genuine conflict** (same region, or an incompatible refactor of shared code): do not
     clobber their work and do not silently drop yours. Reconcile the two changes, ideally in
     a subagent handed both intents and the current file state, and post an event describing
     what you reconciled.
3. Escalate to the human only when the two directions genuinely cannot coexist and picking
   one is their call. Say precisely what clashes.

An exclusive denial is different: that path is serialized on purpose. Do not route around it
with shell writes. Post to the bulletin, prepare a merge-ready change for when the lock
lifts, or switch to unclaimed work. If the owning session is confirmed dead, `coordboard
sweep` clears it.

## The bulletin

`.coord/events.md` is a **live signal channel, not a log**. Only the last few lines are read
into each session's startup, so every event competes for one of a small number of slots.
Anything posted that is not a live signal evicts something that is.

The admission test, before you append: **would another session, live right now, act
differently because of this?** If not, route it somewhere durable instead:

| What you have | Where it goes |
|---|---|
| A durable technical fact about the codebase | a rule or instructions file that auto-loads for anyone who opens that code |
| A decision or ruling | the doc that owns it, with the ruling quoted |
| What you built | the commit message |
| A live signal: a shared config or build change, a blocker others will hit, a handoff, a lock taken or released, a broken tree that is not theirs | the bulletin |

An auto-loading rule file beats the bulletin for anything durable and it is not close. The
bulletin reaches a handful of sessions by recency; a rule reaches every session that opens a
matching file, indefinitely. If a fact has no rule file to land in, that is a reason to
create one, not a reason to post it here.

If a handoff genuinely needs depth, put the depth in a doc and post the pointer.

## An event is a report, not a source of truth

Every event is one session's account at one moment, and the tree moves underneath it.
Sessions retract findings, supersede each other, and re-add things they removed. Before
acting on a factual claim in an event, or copying one into a doc, verify it against the
current source. Cite the symbol, not the line number: line numbers in a bulletin rot fast.

Treat "@handle says X is gone" as a lead to check, never as the check.

## Wrapping

```
coordboard wrap --handle membrane-perf --summary "Fixed the membrane draw path; the shader cache key changed, rebuild before profiling."
```

That posts the summary, releases the intent, prunes stale intents, and rotates the bulletin
if it has grown past its threshold. The SessionEnd hook does the mechanical half
automatically, but it cannot summarize your work, and it will not fire on a crash.

Leave the intents folder empty unless other sessions are genuinely live.

## Modes

**Local (default).** `.coord/` is gitignored and never leaves the machine. Every session
reads the same live directory, so state is always current, and there is no coordination
metadata in version control to conflict over. This is the mode to use unless you have a
specific reason not to.

**Shared** (`coordboard init --shared`). `.coord/` is committed and syncs between machines
through git. This buys cross-machine coordination and costs you two things: the state is
only as fresh as the last pull, and intent files and the bulletin can themselves conflict on
merge. Worth it only when agents genuinely run on more than one machine against the same
repo.
