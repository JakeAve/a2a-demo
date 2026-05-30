# Kickoff prompt — Plan 2 of 3: Human participation in rooms

**Branch:** `agent-rooms-human` (stacked on `agent-rooms` = Plan 1). Check out
that branch, then paste the prompt below into a fresh Claude Code session.

> Tip: stop any leftover Plan-1 demo processes first (`pkill -f src/main.ts`);
> the monitor on :7891 can stay running.

---

```
We're building "Plan 2 of 3" of the agent-rooms feature in this Deno/TypeScript
A2A repo (/Users/jacob/Repos/a2a). You are on branch `agent-rooms-human`, which
is stacked on `agent-rooms` (Plan 1, already complete — broker + agent inboxes +
room tools + the full async room loop, 115 tests passing). Stay on this branch.

Read these first:
- docs/superpowers/specs/2026-05-29-agent-rooms-design.md  (the approved design;
  the "REPL & human participation" section IS the Plan 2 design — already
  brainstormed and approved, so do NOT re-brainstorm)
- docs/superpowers/plans/2026-05-29-agent-rooms-core.md     (Plan 1, whose scope
  notes explicitly defer human participation to this plan)

Plan 2 goal: make the human (via the REPL) a first-class room member who can
join rooms, get @addressed, and post/reply inline — not just observe.

What it must add (per the spec's "REPL & human participation" section):
- A small inbox HTTP server in src/repl.ts (Hono, dynamic port). On first room
  join the REPL starts it and registers itself with the broker as a
  kind:"human" member whose inboxUrl points at that server.
- Incoming deliveries to that inbox print as `[room: <title>] <from> → you: <text>`
  and then re-draw the prompt.
- New REPL commands (keep the existing `@agent <prompt>` direct-send working):
  `:room new <title> <a,b,...>` (create + focus; human auto-added as creator),
  `:room join <roomId>`, `:room leave`, `:rooms` (list), `:room log` (history).
  With a room "focused", a plain typed line posts to it; `@Name ...` in the line
  sets the `to` recipients, otherwise it replies to whoever last addressed you
  (`["*"]` if nobody). `@agent <prompt>` still escapes to a direct send.
- Human turn accounting: the REPL threads the delivery's turnId into the human's
  reply post (exactly like an agent). Human deliveries already get a long
  deadline (humanDeadlineMs, default 1h) — confirm that path.

Seams already in place from Plan 1 (use them, don't rebuild):
- RoomBrokerClient (src/rooms/client.ts): `createRoom` already accepts
  `humanMembers: [{name, inboxUrl}]`; plus `post`, `ack`, `invite`, `leave`,
  `get`, `listByMember`.
- Broker (src/rooms/server.ts) resolves agent members via the registry and adds
  humanMembers with their supplied inboxUrl; it pushes deliveries (InboxDelivery
  = {roomId, turnId, addressedBy, title, members, transcript}) to each member's
  `${inboxUrl}/inbox`.
- The agent /inbox contract (src/agent/base.ts + src/agent/inbox.ts): POST /inbox
  returns 202 and a serialized InboxQueue drains one delivery at a time. The
  human inbox should mirror this contract (202 + don't block the broker).
- The orchestrator (src/orchestrator.ts, setupOrchestrator/OrchestratorContext)
  exposes `roomBrokerUrl` and runs the REPL via runRepl(...). You'll likely
  thread the broker URL + bearer token + the human's identity/name into runRepl
  so it can build a RoomBrokerClient and register its inbox.
- Config: src/config.ts has roomBrokerPort / humanDeadlineMs etc.
- Event types (src/observability/events.ts) already include all room.* events
  with optional roomId. (Visualizing them in the monitor is Plan 3 — NOT this
  plan. This plan does NOT touch monitor/.)

Process to follow:
1. Skip brainstorming (design is approved in the spec). Use the
   superpowers:writing-plans skill to write a TDD, bite-sized, task-by-task
   implementation plan to docs/superpowers/plans/2026-05-29-agent-rooms-human.md
   with complete code in each step, mirroring the style/granularity of the Plan 1
   doc. Run its self-review against the spec, then ask me to review the plan.
2. After I approve the plan, execute it with superpowers:subagent-driven-development
   (fresh implementer per task; spec-compliance then code-quality review after
   each; fix loops; keep the full suite green via `deno task test`).
3. End with superpowers:finishing-a-development-branch (I'll choose "keep" so we
   can stack Plan 3 — agent-rooms-monitor — on top of this branch).

Testing notes: the REPL inbox + human flow should be testable offline like Plan 1
was — drive a real broker + a real REPL inbox server with a stubbed/scripted
"human" input, assert a human delivery prints and a human reply posts back with
the correct turnId. Avoid real LLMs in tests.

Watch for: the REPL's stdin loop is line-oriented and currently has no server;
adding an async inbox that prints while the user may be mid-type is the trickiest
UX bit (the spec flags it) — keep it simple and note rough edges rather than
over-engineering.
```
