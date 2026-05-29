# Agent Rooms — async peer-to-peer conversation via a central broker

**Date:** 2026-05-29
**Status:** Design approved, ready for implementation plan

## Problem

A2A today has exactly one inter-agent primitive: **delegation** (`delegate_start` /
`delegate_continue` in `src/agent/tools.ts`). Delegation is a synchronous,
hierarchical **RPC** — the caller POSTs `/message/send`, blocks, and gets one final
text back (`src/protocol/client.ts`, `src/agent/base.ts`). A "thread" is owned by a
single `parentContextId` and bound to a single peer (`src/store/threads.ts`), and
loop-safety is the **call-stack depth** carried in the `x-depth` header and capped in
`base.ts`.

That shape makes genuine peer-to-peer conversation impossible. When the user asked
for "two agents talking to each other," the only way to express it was a coordinator
manually relaying each line between two leaf agents — every word passing through a
central Claude agent that pastes A's output into B's next prompt (observed in session
`3851f637`). The agents never address each other; one is always the caller (up the
stack) and the other always the responder (down the stack). A sustained back-and-forth
A→B→A→B is a *flat* ping-pong, but the call-stack model can only express it as
ever-deeper nesting, which the depth cap (correctly) refuses.

We want a second, **additive** primitive: a **room** — an async, multi-party
conversation where any member can address any other, nobody blocks on a return value,
and the interaction itself (not a returned result) is the point.

## Goals

- **N-party rooms** as the data model. A 2-agent chat is just a room of size 2.
- **Addressed (@mention) turn-taking:** each post names its recipient(s); only
  addressed members are woken to respond. No combinatorial broadcast storms.
- **Idle + explicit-leave termination,** backed by a hard turn-count backstop. A
  conversation ends when agents stop addressing each other (idle), when a member
  leaves, or when the backstop trips.
- **The human (REPL) is a first-class room member** — addressable, can post and reply
  inline, not just an observer.
- **Additive and complementary to delegation.** `delegate_*` stays unchanged as the
  task-RPC primitive. Rooms are for open-ended conversation. System-prompt guidance
  tells agents which to reach for.
- **Observable:** the existing monitor renders rooms as first-class activity.
- Fits the refactored `setupOrchestrator` / `OrchestratorContext` (and the planned
  MCP-embeddable mode) without regressing it.

## Non-goals (YAGNI)

- **Replacing or unifying delegation.** We keep two distinct primitives on purpose
  (see "Relationship to delegation"). We do *not* re-express delegation as a room.
- **Redelivery / retry of failed pushes.** v1: a push lost to a crash times out and
  the room goes idle. Retry is a documented future enhancement.
- **Transcript delta sync.** v1 delivers a full transcript snapshot per push (fine at
  small N). A "since-seq" delta is a later optimization.
- **Token/cost budgets as the primary bound.** v1 bounds by turn count + idle; token
  budgeting is out of scope.
- **Fancy room graph UI.** The monitor gets a minimal-but-complete transcript +
  lifecycle view, not a force-directed graph.
- **Cross-process room durability guarantees beyond best-effort KV reload.**

## Relationship to delegation

Rooms and delegation are **complementary**, answering different questions:

| | Delegation (`delegate_*`) | Room |
|---|---|---|
| Shape | Synchronous RPC (`await fn()`) | Async conversation (group chat) |
| Returns a value? | Yes — caller blocks on it | No — members participate |
| Topology | Hierarchical (parent → child) | Peer, multi-party |
| Loop safety | `x-depth` call-stack cap | Idle + turn-count backstop |
| Use when | "Do this task, give me the result" | "Let's discuss / debate / collaborate" |

Both remain available to every tool-capable agent. The system prompt gains guidance of
the form: **need a value back → delegate; want an open-ended exchange → open a room.**
The original "two personas talking" use case is squarely a room; "researcher, summarize
this doc" stays delegation.

## Architecture & components

The model shifts from a **call stack** to an **actor mailbox**: an agent drops a
message in a peer's inbox and moves on; the peer wakes, takes a turn, and drops a reply.
Five components — four new:

1. **Room Broker service** (new — `src/rooms/server.ts`, `src/rooms/client.ts`).
   A third central service alongside the registry (7890) and monitor (7891), on a
   configurable port (default 7892), with its own Deno KV. Single source of truth for
   room membership, the canonical transcript, idle/turn state, **and delivery**. Started
   by `setupOrchestrator` so it is part of the embeddable `OrchestratorContext`; its URL
   is handed to agents the way the registry URL is (a `--broker` flag /
   `ROOM_BROKER_URL` env). Emits all room events to the monitor.

2. **Agent inbox** (new endpoint on the existing agent server — `src/agent/base.ts`).
   `POST /inbox` accepts a delivery `{roomId, turnId, transcript, newSeq}`, returns
   `202` **immediately** (the break from synchronous request/response), and enqueues it
   into an in-process FIFO. A single-consumer loop drains the queue **one delivery at a
   time**, runs the room-turn, and posts any reply via the broker.

3. **Room tools** (new entries in `src/agent/tools.ts`, gated on a `RoomBrokerClient`
   being present in `ToolDeps` — exactly how `spawn_agent` is gated on `spawnAgent`).
   Available to all tool-capable backends via the shared tool runner.

4. **REPL inbox + human participation** (new — small server in `src/repl.ts`). When a
   human joins a room, the REPL starts a tiny `/inbox` server, registers as a
   `kind:"human"` member, prints addressed messages, and turns typed lines into posts.

5. **Registry** (unchanged). Still pure name→card discovery. The broker uses it to
   resolve an agent member's inbox URL before pushing. Clean separation: registry =
   *who exists*, broker = *who's talking*.

## Data model

The broker owns three record types in its **own** KV (it never touches an agent's KV —
the discipline the monitor follows).

**`RoomRecord`** — keyed `["room", roomId]`:

```
roomId:         string
title:          string
createdBy:      string                 // member name
status:         "open" | "closed"
members:        Member[]               // small N, stored inline
turnCount:      number                 // total posts so far (backstop counter)
maxTurns:       number                 // hard cap; broker rejects posts past it
lastActivityAt: number
sessionId:      string                 // monitor-session that owns this room
```

**`Member`** (inline):

```
name:     string
inboxUrl: string                       // where the broker pushes deliveries
kind:     "agent" | "human"
active:   boolean                      // false after leave()
joinedAt: number
```

Agent inbox URLs are resolved from the registry at join time and cached here; the human
supplies its own at join (it is not in the registry).

**`TranscriptMessage`** — append-only, keyed `["room_msg", roomId, seq]` (broker
assigns `seq`, like the monitor assigns event seq):

```
seq, roomId, from, to: string[], text, ts
```

**`Delivery`** — the unit of work and of idle-accounting; keyed
`["room_delivery", roomId, turnId]`:

```
turnId:      string                    // == the delivery id
roomId:      string
member:      string                    // who it was pushed to
addressedBy: string
createdAt:   number
deadline:    number                    // sweep resolves past this
status:      "pending" | "resolved"
```

Plus a `["room_by_member", memberName, roomId]` index so `list_rooms` is cheap.

**Idle accounting:** the room is **idle ⇔ no `Delivery` with `status:"pending"`**. A
post addressing `[X, Y]` creates two pending deliveries; each resolves when X / Y posts
back or acks. A turn addressing no one creates none, so a chain dies on its own.
Deliveries are persisted (not a fragile in-memory counter) so a sweep can recover
stalled ones.

**Consistency:** the broker serializes all mutations **per room** (the per-key
promise-chain pattern from `monitor/store.ts`) so `seq`, `turnCount`, and delivery
state never race under concurrent posts.

## Broker HTTP API

Bearer-authed, like the other services. `RoomBrokerClient` wraps these for
agents/REPL/tools.

| Endpoint | Purpose |
|---|---|
| `POST /rooms` | create: `{title, members[], maxTurns?, createdBy, sessionId}` → `{roomId, unresolved[]}`. Resolves agent inbox URLs from the registry; human members supply their own. Unresolvable members are skipped and reported. |
| `POST /rooms/:id/post` | speak: `{from, text, to[], turnId?}` → append transcript, `turnCount++`, check backstop, resolve the sender's own pending delivery (if `turnId`), push a delivery to each addressed member. Returns `{seq}` or a capped error. |
| `POST /rooms/:id/ack` | `{from, turnId}` — sender finished a delivery **without** speaking; resolve that delivery. Keeps idle accounting honest. |
| `POST /rooms/:id/invite` | `{agent}` → resolve inbox URL, add member, emit event. |
| `POST /rooms/:id/leave` | `{agent}` → mark inactive, resolve any pending delivery; auto-close if < 2 active members remain (of any kind — a human + one agent is still a valid room). |
| `GET /rooms/:id` | room record + transcript (for `room_history`). |
| `GET /rooms?member=X` | rooms X belongs to (for `list_rooms`). |

**Delivery push** (broker → member): `POST {inboxUrl}/inbox` with
`{roomId, turnId, transcript, newSeq}`. Carries a **full transcript snapshot** so the
agent's turn has complete context without a second round-trip (v1 simplification).

## Agent-facing tools

New in `tools.ts`, gated on `ToolDeps.rooms` (a `RoomBrokerClient`):

- `create_room(title, members[], maxTurns?)` → `{roomId}`
- `post(roomId, text, to[])` — speak. Empty `to` = address no one = let the chain end;
  `to: ["*"]` = everyone active.
- `invite(roomId, agent)`
- `leave(roomId)`
- `list_rooms()` / `room_history(roomId)`

A `ROOMS_SUFFIX` (sibling to `DELEGATION_SUFFIX` / `SPAWN_SUFFIX`) documents these in the
system prompt and gives the delegate-vs-room guidance, gated the same way.

**The model's job stays trivial.** An agent *speaks* only by calling `post`; it never
manages `turnId` or `ack`. When the inbox consumer runs a delivery-triggered turn, the
runtime threads the current `turnId` into whatever `post` the model emits, and if the
turn ends with **no** `post`, the runtime auto-sends `ack`. Contract from the model's
side: *"you were addressed — reply with `post(...)`, or say nothing."*

## Message lifecycle

A **delivery** is the unit of work; `turnId` *is* the delivery id.

Happy path (room of Alvy + Bex, Alvy starts):

1. Alvy `create_room("hotdog debate", ["Alvy","Bex"])` then `post(room, "...", to:["Bex"])`
   (no `turnId` — originating). Broker: append (seq 0), `turnCount=1`, create delivery
   `T1` for Bex (`pending`, `deadline=now+120s`), push to Bex's `/inbox`.
2. Bex `/inbox` returns `202`, enqueues `T1`; the single-consumer loop picks it up.
3. The loop builds a room-turn: transcript snapshot → messages (Bex's own lines =
   `assistant`, others = `user` prefixed `[from Alvy]`), system prompt = Bex's persona +
   `ROOMS_SUFFIX` + *"You're in room 'hotdog debate' with Alvy. Alvy addressed you. Reply
   with `post(...)`, or `leave`, or stay silent."* Runs the **existing backend
   tool-loop** with room tools available.
4. Bex's model calls `post(room, "...", to:["Alvy"])`. `runTool` attaches `turnId=T1`
   → broker resolves `T1` and creates delivery `T2` for Alvy. The cycle continues.
5. A turn ending with **no `post`** → runtime auto-`ack(turnId)` → delivery resolves, no
   new delivery → the chain dies there.

Three ways it ends:

- **Natural idle** — a turn addresses no one → no new delivery → no pending deliveries →
  `room.idle`. Room stays **open** (members may post again later).
- **Explicit leave** — `leave(room)` deactivates the member and resolves any pending
  delivery; auto-close when < 2 active members remain (any kind).
- **Hard backstop** — `turnCount >= maxTurns` (default 24): reject further posts, emit
  `room.capped`, push a final system notice. The only guard against a healthy ping-pong
  that never goes idle.

**Per-agent serialization:** the inbox consumer runs one delivery at a time. An agent in
three rooms processes deliveries sequentially — never two concurrent model calls
(critical for a single local Ollama and for API rate limits). Trade-off: a slow turn in
one room delays another room's turn for that agent. Accepted.

**Self-delivery guard:** the broker never delivers a post back to its sender; addressing
yourself is dropped.

## Observability

The broker is the single authority on ordering, so **it emits all room events** (it
already gets the monitor URL from `setupOrchestrator`).

**Envelope change** (`src/observability/events.ts`): add optional `roomId` alongside
`threadId`, and add event types:

```
room.created       { roomId, title, members[], maxTurns }
room.invited       { roomId, agent }
room.post          { roomId, from, to[], seq, text }     // the actual message
room.ack           { roomId, from, turnId }
room.left          { roomId, agent }
room.idle          { roomId }
room.capped        { roomId, turnCount }
room.turn_timeout  { roomId, turnId, member }
room.delivery_failed { roomId, turnId, member }
room.closed        { roomId }
```

**Correlation:** room events use the room's captured `sessionId`, and
**`requestId = roomId`** — satisfying the schema's non-empty requirement and collapsing
a whole room conversation into one logical "request" in the monitor regardless of
duration. `agent` = the speaker for `post`/`ack`/`left`, `"room-broker"` for system
events.

**Agent-side turn events:** the `/inbox` consumer emits `turn.started` /
`message.completed` / `turn.completed` (with `roomId`), reusing the `base.ts` pattern, so
each agent's room activity shows up like its delegation activity. The room tools
(`post`, `create_room`, `invite`, `leave`) are **excluded from the generic `tool.call`
emit** (the existing exclusion list that skips `delegate_*` / `spawn_agent`), since the
broker emits richer `room.*` events.

**Monitor web UI** (`monitor/web/`): add a **room view** — events carrying a `roomId`
render as an ordered transcript timeline (`from → to[]`, text) with lifecycle badges
(created / idle / capped / left / timeout). The per-agent swimlane + delegation arrows
are unchanged; the rooms view is additive. Largest single UI chunk; scoped as
minimal-but-complete.

## REPL & human participation

`repl.ts` today is a stdin line-reader with **no server**.

- **Inbox:** on first room join, start a tiny Hono `/inbox` server (dynamic port),
  register with the broker as a `kind:"human"` member with that URL.
- **Incoming deliveries** print as `[room: <title>] <from> → you: <text>`, then re-draw
  the prompt. (A line printing mid-type is the one rough edge; acceptable for a
  prototype.)
- **Commands** (existing `@agent <prompt>` direct-send unchanged):
  - `:room new <title> <a,b,...>` → create + focus (human auto-added).
  - `:room join <roomId>` / `:room leave` / `:rooms` / `:room log`.
  - With a room focused, a plain typed line **posts** to it; `@Name ...` in the line sets
    `to`, else it replies to whoever last addressed you (`["*"]` if nobody).
- **Human turn accounting:** the REPL threads the delivery's `turnId` into the human's
  reply `post`, like an agent. Human deliveries get a **long deadline** (default 1h) — the
  120s sweep is for crashed agents, not slow humans.
- **Kickoff flows:** human-driven (`:room new …` then type) and agent-driven
  (`@coordinator set up a debate …` → coordinator uses room tools; human watches and can
  jump in). Both supported.

The focused-room input model is the most likely thing to iterate on.

## Error handling

| Failure | Behavior |
|---|---|
| Push to inbox fails (down / non-202) | Resolve delivery immediately, emit `room.delivery_failed`. |
| Member never resolves (crash mid-turn) | Per-delivery `deadline` + broker sweep → `room.turn_timeout`. Humans get a long deadline. |
| `turnCount >= maxTurns` | Reject post, emit `room.capped`, push final system notice. |
| Post to unknown/closed room, or by non-member | Tool returns `{error}` (the `delegate_*` shape); turn ends cleanly. |
| `create_room`/`invite` names an unresolvable member | Skip + report; partial create succeeds. |
| Self-address | Silently dropped. |
| Inbox queue overflow | Bounded queue; excess rejected as `delivery_failed` (back-pressure). |

**Crash recovery (v1):** broker state in KV, so rooms survive a broker restart; the
sweep cleans stalled deliveries. **No redelivery/retry** — a lost push times out and the
room goes idle.

## Testing

Follows the repo's `deno test` + injected-stub style, kept fully offline.

- **Broker store units** (`:memory:` KV, injectable push fn like `emit.ts` injects
  `PostFn`): seq ordering, membership, pending accounting, idle detection, backstop,
  `leave` + auto-close, timeout sweep via an **injected clock** (no real sleeps).
- **Room tools units:** `post`/`create`/`leave` dispatch; `turnId` threading; auto-`ack`
  when a turn emits no post; room tools excluded from generic `tool.call` emit.
- **Inbox units:** returns `202`; queue drains one-at-a-time (serialization).
- **End-to-end integration (key test):** real broker + two real agent servers
  (`startAgent` with a *stub* deterministic handler that posts a canned reply — no LLM).
  Create a room, seed a post, assert the chain runs, accounting stays correct, and it
  terminates on both idle and backstop. Exercises real HTTP delivery + queue +
  accounting without any model.
- **Manual:** the FIFO-driven run pattern, now `:room new` (or coordinator-driven),
  watched live in the monitor room view.

## Configuration

- `ROOM_BROKER_PORT` — default 7892.
- `--broker` flag / `ROOM_BROKER_URL` — broker URL handed to spawned agents.
- `A2A_ROOM_MAX_TURNS` — default 24 (per-room backstop, overridable at `create_room`).
- Human-delivery deadline — default 1h; agent-delivery deadline — default 120s.

## Open questions / likely iteration points

- The REPL focused-room input UX (addressing model, mid-type prints).
- Default `maxTurns` (24 is a guess; tune against real debates).
- Whether `to: ["*"]` should exclude the sender only, or also skip currently-inactive
  members (planned: address all `active` members except sender).
