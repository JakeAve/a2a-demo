# Agent Rooms Monitor View — Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rooms visible in the monitor UI — render `room.post` events as swimlane arrows between participants and room lifecycle events as inline badges, keeping existing delegation/tool views intact.

**Architecture:** Room events already flow from the broker → monitor `/ingest` → KV (Plan 1). The gap is purely in the frontend: `monitor/web/layout.js` and `monitor/web/swimlane.js` silently skip all `room.*` events. This plan adds a pure-function helpers module (`room-helpers.js`) for labels and fanout expansion (unit-testable in deno), extends `computeLayout` to discover room participants as lanes and emit room arrow/badge descriptors, extends the swimlane renderer to draw them, and (optional but recommended) threads the room `sessionId` into agent-side room turns so those `turn.started`/`turn.completed` events reach the monitor session.

**Tech Stack:** Vanilla ES module JavaScript (`monitor/web/*.js`), Deno + `@std/assert` for tests. No new npm/jsr dependencies.

**Spec:** `docs/superpowers/specs/2026-05-29-agent-rooms-design.md` — "Observability" section

---

## File Structure

**Create:**
- `monitor/web/room-helpers.js` — pure helpers: `clip`, `expandRoomTo`, `roomPostLabel`, `roomBadgeLabel`. No DOM, no imports from the rest of the monitor. Importable by both `layout.js` and `swimlane.js` and directly by `deno test`.
- `tests/monitor/room-helpers.test.ts` — unit tests for every exported helper.

**Modify:**
- `monitor/web/layout.js` — (1) import `expandRoomTo` from `./room-helpers.js`; (2) lane discovery pass: add `room.post` `data.from`/`data.to` names and `room.created` `data.members` to the lane set; (3) pre-loop: build `roomMembers: Map<roomId, Set<name>>` from `room.created`/`room.invited` events; (4) arrow loop: `room.post` → one or more `kind:"room"` inter-lane arrows or a `kind:"room-self"` self-loop (for `to:[]`); all other `room.*` → `kind:"room-badge"` self-arrow on the `e.agent` lane.
- `monitor/web/styles.css` — add `--room` and `--room-badge` CSS custom properties to `:root`.
- `monitor/web/swimlane.js` — (1) import `roomBadgeLabel`, `roomPostLabel` from `./room-helpers.js`; (2) add `room`/`room-self`/`room-badge` to `COLOR`; (3) add `room.post` case to `preview()`; (4) update self-loop rendering branch to handle `room-badge` and `room-self` kinds with distinct label and icon; (5) add `roomId` to the inspector detail line.
- `tests/monitor/layout.test.ts` — append room-specific `computeLayout` tests.

**Modify (Task 4 — optional but recommended):**
- `src/rooms/types.ts` — add `sessionId?: string` to `InboxDelivery`.
- `src/rooms/server.ts` — set `sessionId: room.sessionId` in the `fanOut` delivery payload.
- `src/agent/room-turn.ts` — change `sessionId: ""` to `sessionId: d.sessionId ?? ""` in the `AgentHandlerCtx`.
- `tests/agent/room-turn.test.ts` — append one test verifying `ctx.sessionId` is populated from `d.sessionId`.

---

## Task 1: `monitor/web/room-helpers.js` — pure label + fanout helpers

**Files:**
- Create: `monitor/web/room-helpers.js`
- Create: `tests/monitor/room-helpers.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/monitor/room-helpers.test.ts`:

```typescript
import { assertEquals } from "@std/assert";
import {
  clip, expandRoomTo, roomBadgeLabel, roomPostLabel,
} from "../../monitor/web/room-helpers.js";

// ── clip ──────────────────────────────────────────────────────────────────────

Deno.test("clip truncates long strings and appends ellipsis", () => {
  assertEquals(clip("hello world", 8), "hello w…");
  assertEquals(clip("short", 20), "short");
  assertEquals(clip("  extra   spaces  ", 20), "extra spaces");
});

// ── expandRoomTo ──────────────────────────────────────────────────────────────

Deno.test("expandRoomTo expands * to all members except sender", () => {
  const members = new Set(["Alvy", "Bex", "human"]);
  assertEquals(expandRoomTo(["*"], "Alvy", members), ["Bex", "human"]);
});

Deno.test("expandRoomTo returns named recipients filtered to non-sender non-wildcard", () => {
  const members = new Set(["Alvy", "Bex", "human"]);
  assertEquals(expandRoomTo(["Bex", "human"], "Alvy", members), ["Bex", "human"]);
});

Deno.test("expandRoomTo skips * tokens in named lists and excludes self", () => {
  const members = new Set(["Alvy", "Bex"]);
  assertEquals(expandRoomTo(["Alvy", "*"], "Alvy", members), []);
});

Deno.test("expandRoomTo returns empty for empty to", () => {
  assertEquals(expandRoomTo([], "Alvy", new Set(["Alvy", "Bex"])), []);
});

// ── roomPostLabel ─────────────────────────────────────────────────────────────

Deno.test("roomPostLabel builds from→to: text label", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: ["Bex"], text: "Hello there" } };
  assertEquals(roomPostLabel(e), "Alvy → Bex: Hello there");
});

Deno.test("roomPostLabel shows 'everyone' for broadcast", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: ["*"], text: "Hi all" } };
  assertEquals(roomPostLabel(e), "Alvy → everyone: Hi all");
});

Deno.test("roomPostLabel shows 'nobody' for empty to", () => {
  const e = { type: "room.post", agent: "Alvy", data: { from: "Alvy", to: [], text: "Done" } };
  assertEquals(roomPostLabel(e), "Alvy → nobody: Done");
});

Deno.test("roomPostLabel clips long text", () => {
  const long = "a".repeat(60);
  const e = { type: "room.post", agent: "x", data: { from: "x", to: ["y"], text: long } };
  assertEquals(roomPostLabel(e).length, 48);
  assertEquals(roomPostLabel(e).endsWith("…"), true);
});

// ── roomBadgeLabel ────────────────────────────────────────────────────────────

Deno.test("roomBadgeLabel handles each lifecycle event type", () => {
  const cases: [object, string][] = [
    [{ type: "room.created",          data: { title: "debate", members: ["Alvy", "Bex"] } }, 'created: "debate" (Alvy, Bex)'],
    [{ type: "room.invited",          data: { agent: "Bex" } },                              "invited Bex"],
    [{ type: "room.left",             data: { agent: "Bex" } },                              "Bex left"],
    [{ type: "room.idle",             data: {} } ,                                           "idle"],
    [{ type: "room.capped",           data: { turnCount: 24 } },                             "capped @24"],
    [{ type: "room.turn_timeout",     data: { member: "Bex" } },                             "timeout: Bex"],
    [{ type: "room.delivery_failed",  data: { member: "Bex" } },                             "failed: Bex"],
    [{ type: "room.closed",           data: {} },                                            "closed"],
    [{ type: "room.ack",              agent: "Bex", data: {} },                              "ack from Bex"],
  ];
  for (const [event, expected] of cases) {
    assertEquals(roomBadgeLabel(event as never), expected, `failed for ${(event as {type:string}).type}`);
  }
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
deno test --allow-read tests/monitor/room-helpers.test.ts
```
Expected: `error: Module not found "file:///Users/jacob/Repos/a2a/monitor/web/room-helpers.js"`

- [ ] **Step 3: Create `monitor/web/room-helpers.js`**

```javascript
// monitor/web/room-helpers.js
// Pure helpers for room event rendering. No DOM. Importable by deno test.

export const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};

// One-line label for a room.post event (used in self-loop labels + inspector).
export function roomPostLabel(event) {
  const d = event.data ?? {};
  const from = d.from ?? event.agent ?? "?";
  const to = Array.isArray(d.to) ? d.to : [];
  const toStr = to.includes("*") ? "everyone" : (to.join(", ") || "nobody");
  return clip(`${from} → ${toStr}: ${d.text ?? ""}`, 48);
}

// Short label for a room lifecycle badge.
export function roomBadgeLabel(event) {
  const d = event.data ?? {};
  switch (event.type) {
    case "room.created":         return `created: "${clip(d.title ?? "", 16)}" (${(d.members ?? []).join(", ")})`;
    case "room.invited":         return `invited ${d.agent ?? "?"}`;
    case "room.ack":             return `ack from ${event.agent ?? "?"}`;
    case "room.left":            return `${d.agent ?? "?"} left`;
    case "room.idle":            return "idle";
    case "room.capped":          return `capped @${d.turnCount ?? "?"}`;
    case "room.turn_timeout":    return `timeout: ${d.member ?? "?"}`;
    case "room.delivery_failed": return `failed: ${d.member ?? "?"}`;
    case "room.closed":          return "closed";
    default:                     return event.type;
  }
}

// Expand `to` against the current member set. Returns concrete recipient names,
// excluding the sender (`from`). The `"*"` wildcard is expanded to all members.
export function expandRoomTo(to, from, memberSet) {
  if (to.includes("*")) return [...memberSet].filter(n => n !== from);
  return to.filter(n => n !== "*" && n !== from);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
deno test --allow-read tests/monitor/room-helpers.test.ts
```
Expected: `ok | 10 passed | 0 failed`

- [ ] **Step 5: Commit**

```bash
git add monitor/web/room-helpers.js tests/monitor/room-helpers.test.ts
git commit -m "feat(monitor): room-helpers.js — pure label + fanout helpers"
```

---

## Task 2: Extend `computeLayout` for room participants and arrows

**Files:**
- Modify: `monitor/web/layout.js`
- Modify: `tests/monitor/layout.test.ts` (append)

- [ ] **Step 1: Write the failing tests**

Append to `tests/monitor/layout.test.ts`:

```typescript
// ── Room events ───────────────────────────────────────────────────────────────

const roomEvents = [
  { sessionId: "s1", requestId: "room-1", seq: 10, ts: 1, agent: "room-broker", depth: 0,
    roomId: "room-1", type: "room.created",
    data: { title: "debate", members: ["analyst", "code-reviewer", "human"], maxTurns: 24 } },
  { sessionId: "s1", requestId: "room-1", seq: 11, ts: 2, agent: "analyst", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "analyst", to: ["code-reviewer"], seq: 0, text: "What do you think?" } },
  { sessionId: "s1", requestId: "room-1", seq: 12, ts: 3, agent: "human", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "human", to: ["*"], seq: 1, text: "Great question!" } },
  { sessionId: "s1", requestId: "room-1", seq: 13, ts: 4, agent: "code-reviewer", depth: 0,
    roomId: "room-1", type: "room.post",
    data: { from: "code-reviewer", to: [], seq: 2, text: "I agree" } },
  { sessionId: "s1", requestId: "room-1", seq: 14, ts: 5, agent: "room-broker", depth: 0,
    roomId: "room-1", type: "room.idle", data: {} },
];

Deno.test("computeLayout adds room participants (including human) as lanes", () => {
  const { lanes } = computeLayout(roomEvents);
  const names = new Set(lanes.map((l) => l.agent));
  assertEquals(names.has("analyst"), true);
  assertEquals(names.has("code-reviewer"), true);
  assertEquals(names.has("human"), true);
  assertEquals(names.has("room-broker"), true);
});

Deno.test("computeLayout room.post with named recipient → kind:room arrow", () => {
  const { arrows } = computeLayout(roomEvents);
  const a = arrows.find((x) => x.kind === "room" && x.from === "analyst" && x.to === "code-reviewer");
  assertEquals(a !== undefined, true);
});

Deno.test("computeLayout room.post with to:* → kind:room arrows to all other members", () => {
  const { arrows } = computeLayout(roomEvents);
  // human → * should fan out to analyst and code-reviewer (from room.created members)
  const fans = arrows.filter((x) => x.kind === "room" && x.from === "human");
  const tos = new Set(fans.map((x) => x.to));
  assertEquals(tos.has("analyst"), true);
  assertEquals(tos.has("code-reviewer"), true);
  assertEquals(tos.has("human"), false); // sender excluded
});

Deno.test("computeLayout room.post with to:[] → kind:room-self self-loop", () => {
  const { arrows } = computeLayout(roomEvents);
  const a = arrows.find((x) => x.kind === "room-self" && x.from === "code-reviewer");
  assertEquals(a !== undefined, true);
  assertEquals(a!.to, "code-reviewer");
});

Deno.test("computeLayout room.created → kind:room-badge on room-broker lane", () => {
  const { arrows } = computeLayout(roomEvents);
  const badge = arrows.find((x) => x.kind === "room-badge" && x.event.type === "room.created");
  assertEquals(badge !== undefined, true);
  assertEquals(badge!.from, "room-broker");
});

Deno.test("computeLayout room.idle → kind:room-badge self-loop", () => {
  const { arrows } = computeLayout(roomEvents);
  const badge = arrows.find((x) => x.kind === "room-badge" && x.event.type === "room.idle");
  assertEquals(badge !== undefined, true);
  assertEquals(badge!.from, badge!.to);
});

Deno.test("computeLayout room events do not break existing delegation layout", () => {
  // Mix delegation events with room events — delegation arrows must still appear.
  const mixed = [
    ...events, // the delegation fixture at the top of this file
    ...roomEvents,
  ];
  const { arrows } = computeLayout(mixed);
  const hasDelegate = arrows.some((a) => a.kind === "delegate");
  const hasRoom = arrows.some((a) => a.kind === "room");
  assertEquals(hasDelegate, true);
  assertEquals(hasRoom, true);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
deno test --allow-read tests/monitor/layout.test.ts
```
Expected: `7 failed` (the new room tests all fail — `room` arrows are not produced yet)

- [ ] **Step 3: Update `monitor/web/layout.js`**

Replace the entire file with:

```javascript
// Pure function: ordered events -> { lanes, arrows }. No DOM, so it is unit
// testable under Deno. Lanes are ordered by first appearance, so the driver
// (REPL or mcp — whichever emits the first event) leads. We don't seed a REPL
// lane: MCP-driven sessions have no REPL events and shouldn't show an empty one.
import { expandRoomTo } from "./room-helpers.js";

export function computeLayout(events) {
  const order = [];
  const seen = new Set();
  const see = (a) => { if (a && !seen.has(a)) { seen.add(a); order.push(a); } };

  // roomMembers: roomId -> Set<memberName>. Seeded from room.created, updated on
  // room.invited — used to expand "to:["*"]" in room.post events.
  const roomMembers = new Map();

  for (const e of events) {
    see(e.agent);
    if (e.data && typeof e.data.peer === "string") see(e.data.peer);
    if (e.type === "spawn" && typeof e.data.name === "string") see(e.data.name);
    // Room participant lane discovery
    if (e.type === "room.post") {
      if (typeof e.data?.from === "string") see(e.data.from);
      if (Array.isArray(e.data?.to)) e.data.to.forEach(n => { if (n !== "*") see(n); });
    }
    if (e.type === "room.created" && Array.isArray(e.data?.members)) {
      e.data.members.forEach(n => see(n));
      roomMembers.set(e.roomId ?? "", new Set(e.data.members));
    }
    if (e.type === "room.invited" && typeof e.data?.agent === "string") {
      see(e.data.agent);
      const set = roomMembers.get(e.roomId ?? "");
      if (set) set.add(e.data.agent);
    }
  }

  const laneX = new Map();
  const lanes = order.map((agent, i) => {
    const x = 90 + i * 200;
    laneX.set(agent, x);
    return { agent, x };
  });

  const arrows = [];
  // Lane names live in a separate sticky header bar now, so the arrow body
  // starts near the top of its own SVG rather than below an in-canvas header.
  let y = 28;
  const rowH = 46;
  for (const e of events) {
    const row = { y, seq: e.seq, event: e };
    if (e.type === "request.started") {
      arrows.push({ ...row, kind: "request", from: "REPL", to: e.agent === "REPL" ? (e.data.target ?? "?") : e.agent });
    } else if (e.type === "delegate.start" || e.type === "delegate.continue") {
      arrows.push({ ...row, kind: "delegate", from: e.agent, to: e.data.peer });
    } else if (e.type === "delegate.return") {
      arrows.push({ ...row, kind: "return", from: e.data.peer, to: e.agent });
    } else if (e.type === "tool.call" || e.type === "spawn") {
      arrows.push({ ...row, kind: "self", from: e.agent, to: e.agent });
    } else if (e.type === "message.completed" && e.depth === 0) {
      arrows.push({ ...row, kind: "final", from: e.agent, to: "REPL" });
    } else if (e.type === "error") {
      arrows.push({ ...row, kind: "error", from: e.agent, to: e.agent });
    } else if (e.type === "room.post") {
      const from = e.data?.from ?? e.agent;
      const to = Array.isArray(e.data?.to) ? e.data.to : [];
      const members = roomMembers.get(e.roomId ?? "") ?? new Set();
      const recipients = expandRoomTo(to, from, members);
      if (recipients.length === 0) {
        // Addressing nobody (chain ends here) — render as a self-loop.
        arrows.push({ ...row, kind: "room-self", from, to: from });
      } else {
        for (const t of recipients) {
          // Skip recipients with no lane (defensive; shouldn't occur after discovery).
          if (laneX.has(t)) arrows.push({ ...row, kind: "room", from, to: t });
        }
      }
    } else if (e.type.startsWith("room.")) {
      // Lifecycle badge (room.created, room.ack, room.idle, room.left, etc.)
      arrows.push({ ...row, kind: "room-badge", from: e.agent, to: e.agent });
    } else {
      continue; // turn.started / turn.completed / non-depth0 message.completed: no arrow
    }
    y += rowH;
  }
  return { lanes, laneX: Object.fromEntries(laneX), arrows, height: y + 20 };
}
```

- [ ] **Step 4: Run all layout tests to verify they pass**

```bash
deno test --allow-read tests/monitor/layout.test.ts
```
Expected: `ok | 11 passed | 0 failed` (4 original + 7 new)

- [ ] **Step 5: Run the full test suite to verify no regressions**

```bash
deno task test
```
Expected: all previously-passing tests still pass; new tests pass too.

- [ ] **Step 6: Commit**

```bash
git add monitor/web/layout.js tests/monitor/layout.test.ts
git commit -m "feat(monitor): computeLayout — room participant lanes + room arrow/badge descriptors"
```

---

## Task 3: Render room events in `swimlane.js` + CSS color tokens

**Files:**
- Modify: `monitor/web/styles.css`
- Modify: `monitor/web/swimlane.js`

No new test file — the DOM-dependent rendering path is verified via manual smoke-test (Task 4 in the prompt's process section). The pure label functions are already tested in Task 1.

- [ ] **Step 1: Add room CSS custom properties to `monitor/web/styles.css`**

In `monitor/web/styles.css`, extend the `:root` block to add `--room` and `--room-badge`:

Old line:
```css
:root { color-scheme: dark; --bg:#0d0d0f; --fg:#e8e8ea; --mut:#9aa; --line:#333;
  --repl:#888; --coord:#2e6fff; --del:#e0a030; --ret:#7fd17f; }
```

New:
```css
:root { color-scheme: dark; --bg:#0d0d0f; --fg:#e8e8ea; --mut:#9aa; --line:#333;
  --repl:#888; --coord:#2e6fff; --del:#e0a030; --ret:#7fd17f;
  --room:#a78bfa; --room-badge:#7c5fbf; }
```

`--room` (soft violet `#a78bfa`) is used for room.post inter-lane arrows and room-self loops.
`--room-badge` (muted violet `#7c5fbf`) is used for lifecycle badge lobes.

- [ ] **Step 2: Update `monitor/web/swimlane.js`**

Replace the entire file with the updated version below. Changes are:
1. Add import of `roomBadgeLabel`, `roomPostLabel` from `./room-helpers.js` at top.
2. Add `room`/`room-self`/`room-badge` entries to `COLOR`.
3. Add `room.post` case to `preview()`.
4. Update the SVG body loop's self-loop branch to handle `room-badge` and `room-self` kinds with distinct labels and a `⊙` icon.
5. Add `roomId` to the inspector detail line.

```javascript
// monitor/web/swimlane.js
import { computeLayout } from "/layout.js";
import { roomBadgeLabel, roomPostLabel } from "./room-helpers.js";

const COLOR = { request: "var(--repl)", delegate: "var(--del)", continue: "var(--del)",
  return: "var(--ret)", final: "var(--ret)", self: "var(--del)", error: "#e05555",
  room: "var(--room)", "room-self": "var(--room)", "room-badge": "var(--room-badge)" };

const HEAD = 44; // height of the sticky lane-name bar

// Escape for safe inlining into SVG/HTML text nodes.
const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));

// Collapse whitespace and clip to a character budget, appending an ellipsis.
const clip = (s, n) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
};

// Render an inspector value. Tool args/results arrive as JSON strings; indent
// them so nested structure is readable. Plain strings pass through untouched.
const pretty = (v) => {
  if (typeof v !== "string") return JSON.stringify(v, null, 2);
  try {
    const parsed = JSON.parse(v);
    if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
  } catch { /* not JSON — show as-is */ }
  return v;
};

// The most useful one-line preview for each event kind, so the message is
// readable on the wire without clicking through to the detail panel.
function preview(e) {
  const d = e.data ?? {};
  switch (e.type) {
    case "request.started": return d.prompt ?? d.target ?? "";
    case "delegate.start": return d.prompt ?? d.title ?? "";
    case "delegate.continue": return d.prompt ?? "";
    case "delegate.return": return d.preview ?? (d.ok === false ? "failed" : "returned");
    case "message.completed": return d.text ?? "";
    case "tool.call": return d.tool ?? "";
    case "spawn": return d.name ?? d.role ?? "";
    case "error": return d.message ?? "error";
    case "room.post": return d.text ?? "";
    default: return e.type;
  }
}

export async function renderSwimlane(view, crumb, sessionId) {
  crumb.innerHTML = `/ <a href="#/">sessions</a> / ${sessionId.slice(0, 8)}`;
  const data = await (await fetch(`/api/sessions/${sessionId}`)).json();
  let events = data.events;
  // Collapse state for the inspector lives here so it survives the full
  // re-render that every redraw (selection, live SSE event) triggers.
  let collapsed = false;

  const draw = (selectedSeq) => {
    const { lanes, laneX, arrows, height } = computeLayout(events);
    const width = 90 + lanes.length * 200;
    const heads =
      `<rect x="0" y="0" width="${width}" height="${HEAD}" fill="var(--bg)"/>` +
      lanes.map((l) =>
        `<text x="${l.x}" y="27" text-anchor="middle" class="lane-head">${esc(l.agent)}</text>`).join("") +
      `<line x1="0" y1="${HEAD - 0.5}" x2="${width}" y2="${HEAD - 0.5}" stroke="var(--line)"/>`;
    const guides = lanes.map((l) =>
      `<line x1="${l.x}" y1="0" x2="${l.x}" y2="${height}" stroke="#fff2" stroke-dasharray="3 5"/>`).join("");
    const body = arrows.map((a) => {
      const x1 = laneX[a.from], x2 = laneX[a.to];
      const color = COLOR[a.kind] ?? "var(--repl)";
      const dash = (a.kind === "return" || a.kind === "final") ? `stroke-dasharray="5 4"` : "";
      const on = a.seq === selectedSeq;
      const sel = on ? `stroke-width="3.5"` : `stroke-width="2"`;
      const cls = on ? "msg sel" : "msg";
      if (a.from === a.to) {
        // Self-loop (tool call / spawn / error / room-badge / room-self): a small
        // lobe with its label. Room kinds use a ⊙ icon to distinguish from tool ·.
        const d = a.event.data ?? {};
        const label = clip(
          a.kind === "room-badge" ? roomBadgeLabel(a.event)
          : a.kind === "room-self" ? roomPostLabel(a.event)
          : a.event.type === "tool.call" ? (d.tool ?? "tool")
          : a.event.type === "spawn" ? `spawn ${d.name ?? d.role ?? ""}`.trim()
          : a.event.type === "error" ? `error: ${d.message ?? ""}`
          : a.event.type,
          32);
        const icon = (a.kind === "room-badge" || a.kind === "room-self") ? "⊙" : "·";
        return `<path d="M${x1},${a.y} q44,-6 44,8 q0,15 -44,8" fill="none" stroke="${color}" stroke-width="1.6" data-seq="${a.seq}" style="cursor:pointer"/>
                <text x="${x1 + 52}" y="${a.y + 4}" class="${cls}" data-seq="${a.seq}" style="cursor:pointer">${icon} ${esc(label)}</text>`;
      }
      // Inter-lane message: line + arrowhead + an inline, ellipsized preview
      // centered above the wire so its content is legible at a glance.
      const dir = x2 > x1 ? 1 : -1;
      const head = `${x2},${a.y} ${x2 - dir * 7},${a.y - 4} ${x2 - dir * 7},${a.y + 4}`;
      const budget = Math.max(6, Math.floor(Math.abs(x2 - x1) / 6.6) - 4);
      const label = esc(clip(preview(a.event), budget));
      return `<g data-seq="${a.seq}" style="cursor:pointer">
                <line x1="${x1}" y1="${a.y}" x2="${x2 - dir * 6}" y2="${a.y}" stroke="${color}" ${sel} ${dash}/>
                <polygon points="${head}" fill="${color}"/>
                <text x="${(x1 + x2) / 2}" y="${a.y - 5}" text-anchor="middle" class="${cls}">${label}</text>
              </g>`;
    }).join("");
    view.innerHTML =
      `<div class="swim">
         <div class="lane-scroll">
           <div class="lane-canvas" style="width:${width}px">
             <svg class="lane-headers" width="${width}" height="${HEAD}">${heads}</svg>
             <svg class="lane-body" width="${width}" height="${height}">${guides}${body}</svg>
           </div>
         </div>
         <div class="detail${collapsed ? " collapsed" : ""}" id="detail">
           <div class="detail-head">
             <span class="mut">message inspector</span>
             <button type="button" class="collapse-btn" id="collapse-btn"
               aria-expanded="${!collapsed}" title="${collapsed ? "Expand" : "Collapse"} inspector">${collapsed ? "▴" : "▾"}</button>
           </div>
           <div class="detail-body" id="detail-body"><span class="mut">click a message to inspect</span></div>
         </div>
       </div>`;

    view.querySelectorAll("[data-seq]").forEach((el) => {
      // Selecting a message always reveals the inspector, even if collapsed.
      el.addEventListener("click", () => { collapsed = false; draw(Number(el.getAttribute("data-seq"))); });
    });
    // Collapse toggle: flip the closure flag and reflect it on the panel
    // in place — no full redraw, so the current selection stays put.
    const btn = document.getElementById("collapse-btn");
    btn.addEventListener("click", () => {
      collapsed = !collapsed;
      document.getElementById("detail").classList.toggle("collapsed", collapsed);
      btn.textContent = collapsed ? "▴" : "▾";
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.title = `${collapsed ? "Expand" : "Collapse"} inspector`;
    });
    if (selectedSeq != null) {
      const e = events.find((x) => x.seq === selectedSeq);
      if (e) {
        document.getElementById("detail-body").innerHTML =
          `<strong>${esc(e.agent)} · ${esc(e.type)}</strong>
           <div class="mut">seq ${e.seq} · depth ${e.depth}${e.threadId ? " · thread " + esc(e.threadId) : ""}${e.roomId ? " · room " + esc(e.roomId) : ""}</div>
           ${Object.entries(e.data).map(([k, v]) =>
             `<div class="bubble"><span class="mut">${esc(k)}</span>\n${esc(pretty(v))}</div>`).join("")}`;
      }
    }
  };

  draw(null);

  const es = new EventSource(`/stream?session=${sessionId}`);
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === "hello") return;
    events = [...events, ev].sort((a, b) => a.seq - b.seq);
    draw(null);
  };
  globalThis.addEventListener("hashchange", () => es.close(), { once: true });
}
```

- [ ] **Step 3: Run full test suite to verify no regressions**

```bash
deno task test
```
Expected: all previously-passing tests still pass. (swimlane.js is not imported by any test — its correctness is verified visually in the next task.)

- [ ] **Step 4: Commit**

```bash
git add monitor/web/styles.css monitor/web/swimlane.js
git commit -m "feat(monitor): render room arrows + lifecycle badges in swimlane UI"
```

---

## Task 4: (Optional) Agent-side `sessionId` for room turns

**Background:** `src/agent/room-turn.ts` currently sets `ctx.sessionId = ""`. The emitter in `src/observability/emit.ts:28` drops events with empty `sessionId` (`if (!event.sessionId || !event.requestId) return`). This means agent `turn.started`/`turn.completed`/`message.completed` events for room turns are silently discarded, so the agent's lane shows no activity during room participation. Fixing this requires adding `sessionId` to `InboxDelivery` so the broker can propagate the room's session ID to the agent.

**Files:**
- Modify: `src/rooms/types.ts`
- Modify: `src/rooms/server.ts`
- Modify: `src/agent/room-turn.ts`
- Modify: `tests/agent/room-turn.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/agent/room-turn.test.ts`:

```typescript
Deno.test("room-turn processor uses d.sessionId for ctx.sessionId when provided", async () => {
  let capturedSessionId: string | undefined;
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: (ctx) => {
      capturedSessionId = ctx.sessionId;
      return Promise.resolve({ text: "" });
    },
    rooms: {
      post: () => Promise.resolve({ seq: 0 }),
      ack: () => Promise.resolve(),
    } as never,
    roomTurn, store,
  });
  const d: InboxDelivery = {
    roomId: "r1", turnId: "T2", addressedBy: "Alvy", title: "t",
    members: ["Alvy", "Bex"], transcript: [], sessionId: "session-xyz",
  };
  await proc(d);
  assertEquals(capturedSessionId, "session-xyz");
});

Deno.test("room-turn processor falls back to empty sessionId when sessionId absent", async () => {
  let capturedSessionId: string | undefined;
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: (ctx) => {
      capturedSessionId = ctx.sessionId;
      return Promise.resolve({ text: "" });
    },
    rooms: { post: () => Promise.resolve({ seq: 0 }), ack: () => Promise.resolve() } as never,
    roomTurn, store,
  });
  await proc(delivery()); // delivery() has no sessionId field
  assertEquals(capturedSessionId, "");
});
```

Note: this test file already imports `InboxDelivery`, `RoomTurnState`, `makeRoomTurnProcessor`, and the `delivery()` / `store` fixtures from earlier tests. No new imports needed.

- [ ] **Step 2: Run to confirm failure**

```bash
deno test --allow-read tests/agent/room-turn.test.ts
```
Expected: `FAIL` — `Argument of type '{ ...; sessionId: string; }' is not assignable` (sessionId is not in InboxDelivery yet) or `capturedSessionId !== "session-xyz"`.

- [ ] **Step 3: Add `sessionId` to `InboxDelivery` in `src/rooms/types.ts`**

In `src/rooms/types.ts`, update `InboxDelivery`:

Old:
```typescript
export type InboxDelivery = {
  roomId: string;
  turnId: string;
  addressedBy: string;
  title: string;
  members: string[];          // active member names
  transcript: TranscriptMessage[];
};
```

New:
```typescript
export type InboxDelivery = {
  roomId: string;
  turnId: string;
  addressedBy: string;
  title: string;
  members: string[];          // active member names
  transcript: TranscriptMessage[];
  sessionId?: string;         // room's monitor session; enables agent turn events to flow
};
```

- [ ] **Step 4: Set `sessionId` in `fanOut` in `src/rooms/server.ts`**

In `src/rooms/server.ts`, inside `fanOut`, find the `InboxDelivery` payload construction:

Old:
```typescript
      const payload: InboxDelivery = {
        roomId, turnId: delivery.turnId, addressedBy: from,
        title: room.title, members: [...activeNames], transcript,
      };
```

New:
```typescript
      const payload: InboxDelivery = {
        roomId, turnId: delivery.turnId, addressedBy: from,
        title: room.title, members: [...activeNames], transcript,
        sessionId: room.sessionId,
      };
```

- [ ] **Step 5: Use `d.sessionId` in `src/agent/room-turn.ts`**

In `src/agent/room-turn.ts`, inside `makeRoomTurnProcessor`, update the `AgentHandlerCtx` construction:

Old:
```typescript
        sessionId: "", // room events are emitted by the broker; agent turn events optional
```

New:
```typescript
        sessionId: d.sessionId ?? "",
```

- [ ] **Step 6: Run room-turn tests**

```bash
deno test --allow-read tests/agent/room-turn.test.ts
```
Expected: `ok | 5 passed | 0 failed` (3 original + 2 new)

- [ ] **Step 7: Run the full test suite**

```bash
deno task test
```
Expected: all 134+ tests pass (no regressions from the types.ts / server.ts changes).

- [ ] **Step 8: Commit**

```bash
git add src/rooms/types.ts src/rooms/server.ts src/agent/room-turn.ts tests/agent/room-turn.test.ts
git commit -m "feat(rooms): thread sessionId through InboxDelivery so agent room-turn events reach monitor"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|---|---|
| `room.post` → arrow from `from` → each `to` member (or `"*"` = all) | Task 2 (layout), Task 3 (swimlane) |
| Room lifecycle badges: created, idle, capped, left, invited, turn_timeout, closed | Task 1 (labels), Task 2 (layout), Task 3 (swimlane) |
| "human" is NOT in registry — must render without agent swimlane | Task 2: lane added from room participant discovery; human never required to be in registry |
| `room.post from:"human"` / `to:["human"]` renders correctly | Task 2: human gets a lane via `see(e.data.from)` and `see(n)` in to discovery |
| `room.capped` = badge not terminal (status stays open) | Task 1: roomBadgeLabel for room.capped just shows "capped @N"; no special close logic |
| session/request grouping: rooms collapse into one "request" per room | Verified: no changes needed to store.ts or server.ts; requestId === roomId already collapses them |
| Agent-side room turn events visible in monitor | Task 4 (optional) |
| Baseline 134 tests green | Tasks 2, 3, 4 all run `deno task test` to verify |

### Placeholder scan

No TBD, TODO, or "implement later" in code steps — all code blocks are complete. Labels/icons chosen concretely. CSS color values specified.

### Type consistency

- `InboxDelivery.sessionId` added in Task 4 Step 3, used in Task 4 Steps 4+5 — consistent.
- `roomBadgeLabel(event)` is called in swimlane.js (Task 3) and tested in Task 1 — same function name.
- `expandRoomTo(to, from, memberSet)` signature is consistent between room-helpers.js and its usage in layout.js.
- `kind: "room"` / `"room-self"` / `"room-badge"` arrow kinds are consistently produced in layout.js (Task 2) and consumed in swimlane.js (Task 3).
- `COLOR["room"]`, `COLOR["room-self"]`, `COLOR["room-badge"]` keys match the kind strings exactly.

No gaps found.
