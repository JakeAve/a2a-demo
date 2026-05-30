# Web UI Monitor — Design

**Date:** 2026-05-28 **Status:** Approved (brainstorm), pending implementation
plan

## Goal

Give a human visibility into what a multi-agent A2A run is doing. Today the only
interaction surface is the REPL, which streams the depth-0 agent but hides
everything below it: when an agent delegates, the peer's work happens over a
synchronous `/message/send` and is invisible. The result is that a multi-agent,
multi-directional delegation tree is hard to reason about.

This design adds an **optional, isolated monitor service** plus a **web UI**
that visualizes a run as a swimlane/sequence diagram — one lane per agent, every
delegation and reply an arrow over time.

## Principles

- **Optional.** The app runs exactly as today with the monitor off. Turning it
  on is purely additive.
- **Isolated.** Agents gain one thin instrumentation seam (`emit()`), nothing
  more. They never read or write the monitor's storage. The monitor never reads
  agents' private `ContextStore` / `ThreadStore`.
- **Self-describing events.** Correlation rides on ids propagated through the
  call tree, not on reconstructing relationships from agents' internal state.

## Non-goals (deferred)

- **Chat-to-agents from the web UI.** v1 is read-only visibility. The driver is
  still the REPL. (Planned next.)
- **Live token streaming.** v1 captures milestones. The event envelope is
  designed so a `message.delta` type can be added later with no reshaping.
- **The graph (option C) view.** A future secondary "live topology" overview;
  not v1.
- **MCP wrapping.** Out of scope here, but this work is the prerequisite — once
  the tree is observable, an MCP-driven run correlates identically because it
  reuses the same propagated ids.
- **Multi-machine / TLS / auth beyond a shared bearer.** Local-dev posture for
  now (consistent with the rest of the prototype).

## Concepts & ids

- **`sessionId`** — one driver run (today's REPL `contextId` lifetime). Minted
  once per REPL run. The thing you "link into."
- **`requestId`** — one top-level prompt within a run (e.g.
  `@coordinator do X`). Minted per REPL line.

Both are **propagated unchanged** through every delegation hop as HTTP headers
(`x-session`, `x-request`), mirroring the existing `x-depth` pattern in
`delegate()` (`src/agent/tools.ts`). Every agent at every depth stamps its
events with the same `sessionId`/`requestId`, so the monitor correlates the
whole tree trivially — no stitching, no out-of-order races.

> **Why propagation over stitching:** events are emitted as best-effort
> fire-and-forget POSTs, which can arrive out of order or drop. Stitching
> (walking `ThreadStore.parentContextId` to a root) would require buffering
> orphans until the parent `delegate.start` arrives. Propagated ids avoid that
> entirely, cross process/machine boundaries for free (future multi-machine),
> are essential for future live token routing, and keep the monitor decoupled
> from `ThreadStore` internals. Cost is small and harmless when no monitor runs.

## Architecture

```
┌─ orchestrator (+ agents) ─────────────┐         ┌─ monitor (standalone) ─┐
│  REPL mints sessionId + requestId     │  POST   │  POST /ingest          │
│  agents run as today                  │ events  │   → in-mem fan-out      │
│  each agent has emit() ───────────────┼────────▶│   → own Deno KV         │
│  (no-op unless A2A_MONITOR_URL set)   │         │  GET /api/sessions      │
└───────────────────────────────────────┘         │  GET /api/sessions/:id  │
                                                    │  GET /stream (SSE)      │
   browser ◀─────── SSE / fetch ───────────────────│  GET / (static UI)      │
   swimlane UI                                      └─────────────────────────┘
```

Three independently understandable units:

1. **Emit shim** (in the agent process) — fire-and-forget event export.
2. **Monitor service** (standalone) — ingest + fan-out + persistence + serves
   UI.
3. **Web UI** (static, served by the monitor) — the swimlane session view.

## Event model

One envelope for every event:

```ts
type A2AEvent = {
  // correlation (propagated, never re-minted downstream)
  sessionId: string; // driver run
  requestId: string; // top-level prompt
  seq: number; // monitor-assigned ingest order — the stable sort key
  ts: number; // emitter epoch-ms — for display & durations
  // origin
  agent: string; // emitting agent name
  depth: number;
  threadId?: string; // the delegation thread this belongs to, if any
  // payload
  type: EventType;
  data: Record<string, unknown>; // type-specific; previews truncated at emitter
};
```

**Two clocks:** `ts` is the emitter's wall clock (good for durations) but skews
across processes; the **monitor assigns `seq` on ingest** as the authoritative
ordering the UI sorts by.

**Event types (v1 milestones)** and their swimlane rendering:

| type                | data (previewed)                               | swimlane rendering             |
| ------------------- | ---------------------------------------------- | ------------------------------ |
| `request.started`   | `target, prompt`                               | REPL → agent arrow             |
| `turn.started`      | `model, backend`                               | lane activity begins           |
| `delegate.start`    | `peer, threadId, title, prompt`                | solid arrow out                |
| `delegate.continue` | `peer, threadId, turn, prompt`                 | solid arrow out (turn n)       |
| `delegate.return`   | `peer, threadId, ok, durationMs, preview`      | dashed arrow back              |
| `tool.call`         | `tool, argsPreview, resultPreview, durationMs` | self-loop                      |
| `spawn`             | `role, name, model, ok`                        | self-loop → activates new lane |
| `message.completed` | `text, tokensIn?, tokensOut?`                  | top agent → REPL return        |
| `turn.completed`    | `durationMs, status`                           | lane settles                   |
| `error`             | `message, where`                               | red marker                     |
| `request.completed` | `durationMs`                                   | request closes                 |

**Reply arrows — avoiding double-draw:** every agent emits `message.completed`
when it finishes a turn, but the inbound arrow from a peer is drawn by the
_caller's_ `delegate.return` (the caller is the one that knows the thread and
timing). So a peer's `message.completed` is informational (it enriches the
detail panel); only the **depth-0** agent's `message.completed` renders as a
visible arrow — the final return to the REPL lane. The UI keys off `depth` to
decide.

**Deferred, additive:** `message.delta { chunk }` — fan-out only, not persisted.
The envelope already carries it; nothing else changes.

The envelope type and its zod schema live in `src/observability/events.ts` as
the single source of truth, imported by both the emit shim and the monitor.

## Monitor service

Hono app (same stack as `src/registry/server.ts`). Its own entry point, port,
and **named** Deno KV (`a2a-monitor.db`) — never the agents' default KV.

| route                     | purpose                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /ingest`            | accept one event or a batch; optional bearer (`AGENT_BEARER_TOKEN`) so stray local processes can't spam |
| `GET /api/sessions`       | session summaries, newest first                                                                         |
| `GET /api/sessions/:id`   | summary + all events for initial load / replay                                                          |
| `GET /stream?session=:id` | SSE live feed; `session=*` for the sessions-list page                                                   |
| `GET /` + assets          | serve the static web UI                                                                                 |

**Ingest flow:** validate envelope (zod) → assign `seq` (per-session counter,
rehydrated from the session summary's `lastSeq` after a restart) → write KV row
→ update session summary → push to in-memory subscribers for that session.

**In-memory fan-out:** `Map<sessionId, Set<sseController>>` plus a wildcard set
for the sessions-list page. KV is used only for history/replay; live updates
never touch KV watch.

**KV layout (monitor-owned):**

- `["evt", sessionId, requestId, seq]` → `A2AEvent`. Range-read a whole session
  (`prefix ["evt", sessionId]`) or one request
  (`prefix ["evt", sessionId, requestId]`); numeric `seq` sorts correctly as a
  KV key part.
- `["session", sessionId]` → summary
  `{ startedAt, lastEventAt, agents[], requestCount, lastSeq, status }`, updated
  incrementally on ingest so the sessions list never scans all events.
- Optional `expireIn` on event rows (e.g. 7-day retention) as a config knob;
  default deferred.

**Monitor file layout:**

```
monitor/
  main.ts        # entry point (deno task monitor)
  server.ts      # Hono routes
  store.ts       # KV reads/writes + summary maintenance
  bus.ts         # in-memory fan-out
  web/
    index.html   # sessions list + session view shell
    app.js       # routing, fetch, SSE subscription
    swimlane.js  # event-stream → SVG layout + render
    styles.css
```

## Agent instrumentation (the emit seam)

- **`src/observability/emit.ts` (new):** `createEmitter(monitorUrl?, token?)` →
  `emit(event)`. No URL → no-op. Otherwise fire-and-forget
  (`void fetch(...).catch(() => {})`); never blocks or throws into the agent
  path. Sourced from config (`A2A_MONITOR_URL`) and threaded through the
  existing deps objects — no new globals.
- **`src/repl.ts`:** mint `sessionId` per run, `requestId` per line; emit
  `request.started` / `request.completed`; pass ids into `streamMessage`.
- **`src/protocol/client.ts`:** `sendMessage` / `streamMessage` gain `sessionId`
  / `requestId` params, sent as `x-session` / `x-request` headers next to
  `x-depth`. `delegate()` forwards them unchanged.
- **`src/agent/base.ts`:** read `x-session` / `x-request` / `x-depth` off the
  incoming request onto the handler ctx; emit `turn.started` / `turn.completed`
  / `error` around the handler.
- **`src/agent/tools.ts` (`runTool` + `delegate`):** emit `delegate.start` /
  `delegate.continue` / `delegate.return`, `tool.call`, `spawn`. Adds `emit` +
  ids to `ToolDeps`. `delegate()` forwards the propagation headers.
- **Backend handlers** (`src/agent/claude.ts`, `claude-code.ts`, `ollama.ts`):
  emit `message.completed` with token usage (each backend exposes it). Tool
  events stay centralized in `runTool`, so backends barely change.

## Web UI (option B — swimlanes)

Static files served by the monitor. No build step / bundler, consistent with the
project's minimalist Deno style; the swimlane is custom SVG, so a framework adds
little. Vanilla TS/HTML/SVG.

**Pages:**

1. **Sessions list** — from `GET /api/sessions`; rows show session id, start
   time, agent count, request count, status. Subscribes to
   `GET /stream?session=*` so new/changed sessions appear live. Click a row to
   open it. This is the "link into a session" entry point (`/#/session/<id>`).
2. **Session view (swimlanes)** — the B mockup:
   - Top bar: session summary + per-request tabs.
   - Canvas: one lane per agent (header shows backend/model); time runs top-down
     (left gutter); arrows per the rendering table above. Solid amber =
     delegation out, dashed green = reply, loops = self tool-calls; spawns
     activate a new lane mid-session; errors show a red marker.
   - Detail panel: selected arrow's full content (thread id, turn, timing,
     model, status, depth, prompt/reply text).
   - Loads history via `GET /api/sessions/:id`, then subscribes to
     `GET /stream?session=:id`; live events append in place.

**Rendering:** `swimlane.js` takes the ordered event stream and computes a
layout (assign each agent a lane/column x; assign each event a row y by `seq`;
draw arrows between source/target lanes). Pure function of the event list, so a
late-joining browser renders identically from history then continues live.

## Configuration

Emitter side (in `.env`, read by `src/config.ts`):

| var               | default   | purpose                                       |
| ----------------- | --------- | --------------------------------------------- |
| `A2A_MONITOR_URL` | — (unset) | where to POST events; unset → emit is a no-op |

Monitor side (its own flags/env):

| var                  | default            | purpose                             |
| -------------------- | ------------------ | ----------------------------------- |
| `MONITOR_PORT`       | `7891`             | monitor HTTP port                   |
| `MONITOR_KV_PATH`    | `./a2a-monitor.db` | monitor's named KV file             |
| `AGENT_BEARER_TOKEN` | `local-dev-secret` | optional shared secret on `/ingest` |

`deno.json` gains a `monitor` task:
`deno run -A --unstable-kv --env-file=.env monitor/main.ts`.

## Testing

Follow existing `deno test` patterns under `tests/`.

- **`emit`:** no-op when `A2A_MONITOR_URL` unset; POSTs a well-formed envelope
  when set; swallows fetch errors without throwing into the caller.
- **propagation:** `sendMessage` / `streamMessage` send `x-session` /
  `x-request`; `base` reads them onto ctx; `delegate()` forwards them unchanged.
- **monitor store:** `seq` is monotonic per session and rehydrates after a
  simulated restart; session summary updates incrementally; range reads return a
  session and a single request correctly.
- **monitor server:** `/ingest` validates and rejects malformed envelopes;
  `/api/sessions` and `/api/sessions/:id` return expected shapes; `/stream`
  delivers a posted event to a subscribed client.
- **e2e:** run a small orchestrator with `A2A_MONITOR_URL` pointed at a test
  monitor; drive one fan-out request (delegate to two peers + a continue);
  assert the persisted events reconstruct the expected tree (agents, arrows,
  ordering). Mirror `scripts/smoke.ts` style.

## Out-of-the-box flow

```
# terminal 1
deno task monitor                       # http://localhost:7891

# terminal 2
A2A_MONITOR_URL=http://localhost:7891 \
  deno task start --agents="coordinator,scout,analyst"

# browser
open http://localhost:7891             # watch sessions appear and drill in
```

With `A2A_MONITOR_URL` unset, everything behaves exactly as it does today.
