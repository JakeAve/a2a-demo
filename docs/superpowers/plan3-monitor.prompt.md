# Kickoff prompt — Plan 3 of 3: Monitor room view

**Branch:** `agent-rooms-monitor` (stacked on `agent-rooms-human` = Plan 2, which is
itself stacked on `agent-rooms` = Plan 1). **Plan 2 is now complete** on
`agent-rooms-human` (kept, not merged — 134 tests passing). Make sure that branch
has no uncommitted changes, then create the new branch off it
(`git checkout agent-rooms-human && git checkout -b agent-rooms-monitor`) and paste
the prompt below into a fresh Claude Code session.

> Tip: stop any leftover Plan-1/2 demo processes first (`pkill -f src/main.ts;
> pkill -f src/mcp.ts`); the monitor on :7891 must be (re)started from THIS branch
> to accept `room.*` events.

> This is the plan that makes rooms actually *visible* in the monitor. Today the
> broker emits all `room.*` events and they're stored, but `monitor/web/layout.js`
> only draws arrows for delegate/tool/spawn/message.completed and silently skips
> everything else — so room sessions render empty.

---

```
We're building "Plan 3 of 3" of the agent-rooms feature in this Deno/TypeScript
A2A repo (/Users/jacob/Repos/a2a). You are on branch `agent-rooms-monitor`,
stacked on `agent-rooms-human` (Plan 2) which is stacked on `agent-rooms` (Plan 1).
Plans 1 and 2 are complete. Stay on this branch.

Read these first:
- docs/superpowers/specs/2026-05-29-agent-rooms-design.md  (approved design; the
  "Observability" section IS the Plan 3 design — already approved, do NOT
  re-brainstorm)
- docs/superpowers/plans/2026-05-29-agent-rooms-core.md     (Plan 1; its scope
  notes defer the monitor room view to this plan)

Plan 3 goal: make rooms visible in the monitor UI. Room events already flow and
are stored — this plan renders them.

Background — the exact gap to close:
- The broker (src/rooms/server.ts) emits all room.* events to the monitor with
  `requestId === roomId`, `roomId` set, `sessionId` = the room's session, and
  `agent` = the speaker (for room.post/ack/left/invited) or "room-broker" (for
  idle/capped/turn_timeout/delivery_failed/closed/created system events).
- Event types & payloads (src/observability/events.ts, all already defined):
    room.created       { roomId, title, members[], maxTurns }
    room.invited       { roomId, agent }
    room.post          { roomId, from, to[], seq, text }   ← the actual message
    room.ack           { roomId, from, turnId }
    room.left          { roomId, agent }
    room.idle          { roomId }
    room.capped        { roomId, turnCount }
    room.turn_timeout  { roomId, turnId, member }
    room.delivery_failed { roomId, turnId, member }
    room.closed        { roomId }
- THE BUG TO FIX: monitor/web/layout.js (around lines 30-41) builds swimlane
  arrows only for delegate.start/continue/return, tool.call, spawn, and
  message.completed(depth 0); every other event type hits `continue; // no arrow`
  and is dropped from the visualization. monitor/web/swimlane.js has a per-type
  label() switch that also lacks room cases.

What this plan must add:
1. Render room.post as an arrow from `from` → each member in `to` (or "*" =
   all), with the text preview as the label — analogous to how delegate.start
   renders. Add the case in monitor/web/layout.js and a label case in
   monitor/web/swimlane.js.
2. Render room lifecycle as markers/badges on the timeline: room.created
   (title + members), room.idle, room.capped, room.left, room.invited,
   room.turn_timeout, room.closed. Keep it "minimal but complete" per the spec
   (a transcript timeline + lifecycle badges; no force-directed graph).
3. Because room events use `requestId === roomId`, a whole room conversation
   already collapses into one logical "request" — make sure the session view
   groups/reads them sensibly. Check monitor/store.ts + monitor/server.ts; they
   likely need no change (events are already validated and stored), but verify
   the session/request grouping surfaces rooms cleanly. Only change the store if
   needed.
4. (Recommended, optional — closes a spec "Observability" gap from Plan 1) Make
   agent-side room-turn events flow so each agent's room activity shows in its
   lane. In Plan 1, src/agent/room-turn.ts sets `ctx.sessionId = ""` for the
   synthesized room turn, so the agent's turn.started/turn.completed for room
   turns are dropped by the emitter (which requires a non-empty sessionId). To
   fix: add `sessionId` to the InboxDelivery type (src/rooms/types.ts), have the
   broker's fanOut put `room.sessionId` into the pushed payload
   (src/rooms/server.ts), and have makeRoomTurnProcessor use it for
   `ctx.sessionId` (src/agent/room-turn.ts). This touches Plan-1 files but you're
   on a stacked branch so that's fine. If you include it, render those agent
   turn events under the room session too.

What Plan 2 added that THIS plan must account for (Plan 2 is complete on
agent-rooms-human — these are facts on the ground now, not predictions):
- The human (REPL) is a first-class room member, named by cfg.humanName
  (default "human", kind:"human"). So room.post events now legitimately have
  from/agent = "human" and "human" can appear in `to`. CRITICAL: the human is
  NOT in the registry and has NO agent swimlane — do NOT assume every
  room.post `from`/`to` name maps to a registered agent lane. The room view
  must render a participant/speaker that has no agent card (render "human" as
  a participant). This is the single most likely place naive layout code
  breaks.
- The human emits NO turn.* events (the REPL inbox just prints deliveries; it
  does not emit turn.started/turn.completed). The human shows up ONLY via the
  broker's room.post / room.ack events. (Optional item 4 below adds AGENT-side
  room-turn events only — it does not give the human a lane.)
- The broker emits room.invited for BOTH /invite (agent, registry-resolved)
  AND the new /join endpoint the REPL uses when the human joins an existing
  room (src/rooms/server.ts). Both carry data {agent: <name>} — the event does
  NOT distinguish a human join from an agent invite. If you want distinct
  badges, either (a) read members[].kind from the room record (broker
  GET /rooms/:id), or (b) add `kind` to the room.invited data in the broker
  (one line, a Plan-1 file — fine on a stacked branch). Decide in the plan.
- room.capped does NOT close the room: status stays "open"; the broker just
  rejects further posts (verified live — a chatty room rode to maxTurns=24 and
  capped while staying open). So "capped" is a state badge, not terminal.
  room.closed only fires when <2 active members remain after a leave.
- InboxDelivery (src/rooms/types.ts) is now consumed by the REPL inbox too
  (src/repl.ts startReplInbox), not just agents. Optional item 4's plan to add
  `sessionId` to InboxDelivery is still clean — the REPL inbox ignores the
  extra field. (room-turn.ts still sets ctx.sessionId = "" exactly as item 4
  describes — untouched by Plan 2.)

Verified live in the Plan-2 smoke test (use for manual verification + test data):
- A room of "analyst" + "code-reviewer" + the human rode to maxTurns=24,
  producing room.created → ~24 room.post (mix of `→ *` broadcast and direct
  `→ <name>`) → room.capped. The human posted and was addressed back by both
  agents. Reproduce with the Plan-2 REPL: `:room new <title> analyst,code-reviewer`
  then `@analyst @code-reviewer <prompt>`.
- room.idle rarely fires with chatty local models (they broadcast to "*", so
  the chain never goes quiet — it hits the cap instead). To exercise the idle /
  left / turn_timeout badges deliberately, drive a scripted/stub scenario (see
  tests/rooms/e2e.test.ts and tests/repl-e2e.test.ts for the stub-agent
  pattern) or have an agent fall silent / `:room leave`.

Baseline: `deno task test` = 134 passing on agent-rooms-human. Keep it green;
do not regress Plan 1/2 tests. New pure helpers (event → arrow descriptor,
event → label) are the easily-unit-testable surface — bias the plan toward those.

Process to follow:
1. Skip brainstorming (design approved in the spec's Observability section). Use
   superpowers:writing-plans to write a TDD, bite-sized plan to
   docs/superpowers/plans/2026-05-29-agent-rooms-monitor.md, mirroring the Plan 1
   doc's style. Note that UI rendering is harder to unit-test than backend logic:
   prefer small pure helper functions (event → arrow descriptor, event → label)
   that you CAN unit-test with deno test, and keep the DOM glue thin. Run the
   self-review, then ask me to review the plan.
2. After I approve, execute with superpowers:subagent-driven-development (fresh
   implementer per task; spec then quality review each; keep `deno task test`
   green).
3. Manual verification: with Plans 1-2 running (orchestrator on this branch +
   `deno task monitor` ON THIS BRANCH so it accepts room.* events), spawn two
   analyst agents, open a room (via the REPL `:room new` from Plan 2, or by
   POSTing to the broker), and confirm the monitor now renders the room.post
   arrows between the agents plus lifecycle badges. Give me a session link.
4. End with superpowers:finishing-a-development-branch. This is the top of the
   stack (Plan 1+2+3); I'll decide then whether to merge the whole stack down to
   main.

Reminder: the monitor must be RUN from this branch to accept room.* events — a
monitor started from an older commit returns HTTP 400 on /ingest for room events
and silently drops them.
```
