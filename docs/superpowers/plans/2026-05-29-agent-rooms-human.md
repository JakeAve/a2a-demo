# Agent Rooms — Human Participation Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the human (via the REPL) a first-class room member who can create/join rooms, get `@addressed`, and post/reply inline — not just observe — while keeping the existing `@agent <prompt>` direct-send working.

**Architecture:** `src/repl.ts` gains (1) a tiny Hono `/inbox` server started lazily on first room join, registered with the broker as a `kind:"human"` member; (2) a pure line-classifier (`classifyLine`) that maps a typed line to a direct-send, a room post, or a command; and (3) a rewired `runRepl` whose input/output are injectable so the whole flow is testable offline. Human reply posts thread the delivery's `turnId` exactly like an agent (the broker already gives human deliveries a long deadline). A new minimal `POST /rooms/:id/join` broker endpoint lets a human join an *existing* room with its own inbox URL (the existing `createRoom` `humanMembers` path covers room *creation*; `invite` only resolves agents via the registry, so it can't add a human).

**Tech Stack:** Deno, TypeScript, Hono, Deno KV (`--unstable-kv`), `@std/assert` for tests. No new dependencies. Reuses `InboxQueue` (`src/agent/inbox.ts`) and `RoomBrokerClient` (`src/rooms/client.ts`).

**Spec:** `docs/superpowers/specs/2026-05-29-agent-rooms-design.md` — the "REPL & human participation" section.

**Scope of this plan (Plan 2):** REPL inbox server, human room commands, focused-room input model, human turn accounting, a broker `join` endpoint for humans, config for the human's member name, and an end-to-end integration test driving a real broker + a real stub agent + a scripted REPL (no LLM). **Out of scope:** the monitor web room view (Plan 3 — this plan does NOT touch `monitor/`).

### A note on the focused-room input model (the documented iteration point)

The spec flags the focused-room addressing model as "the most likely thing to iterate on." This plan resolves the genuine ambiguity between `@agent <prompt>` (direct send) and `@Name ...` (room recipient) with a **focus- and membership-aware** rule, implemented in the pure `classifyLine` function so it is easy to unit-test and later tune:

1. `:`-prefixed lines are commands.
2. A line `@<name> <rest>` where a room is focused **and** `<name>` is an active member of that room → **room post** (leading `@Name` tokens become `to`).
3. Otherwise, if `<name>` is a known registered agent → **direct send** (the escape still works, focused or not — so you can direct-send to an agent that is *not* in your focused room).
4. Otherwise, if a room is focused → **room post** addressing `<name>` (the broker silently drops unknown recipients).
5. A plain line (no leading `@`) with a room focused → **room post** to whoever last addressed you, or `["*"]` if nobody.
6. A plain line with no room focused → the existing usage hint.

This keeps `@agent` direct-send working while making in-room `@member` addressing the default when focused.

---

## File Structure

**Create:**
- `tests/repl-parse.test.ts` — unit tests for the pure classifier + mention parser + delivery formatter.
- `tests/repl-inbox.test.ts` — unit/integration tests for the REPL `/inbox` server.
- `tests/repl-e2e.test.ts` — end-to-end: real broker + stub agent + scripted REPL; asserts a human delivery prints and the human reply posts back with the correct `turnId`.

**Modify:**
- `src/config.ts` — add `humanName` (env `A2A_HUMAN_NAME`, default `"human"`).
- `tests/config.test.ts` — assert the `humanName` default.
- `src/rooms/server.ts` — add `POST /rooms/:id/join` (human/agent member with a supplied inbox URL).
- `src/rooms/client.ts` — add `join(roomId, {name, inboxUrl, kind?})`.
- `tests/rooms/server.test.ts` — append a `join` integration case.
- `tests/rooms/client.test.ts` — append a `join` stubbed-fetch case.
- `src/repl.ts` — add the classifier, formatter, inbox server, and rewire `runRepl` (injectable I/O, room state, commands, dispatch).
- `src/orchestrator.ts` — pass `roomBrokerUrl` + `humanName` into `runRepl`.

---

## Task 1: Config — the human's member name

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Add `humanName` to `AppConfig`**

In `src/config.ts`, add to the `AppConfig` type (after `humanDeadlineMs`):
```typescript
  humanName: string; // the human's room-member name (REPL participant)
```

- [ ] **Step 2: Populate it in `loadConfig`**

In `loadConfig`'s returned object, add after the `humanDeadlineMs` line:
```typescript
    humanName: env.A2A_HUMAN_NAME ?? "human",
```

- [ ] **Step 3: Run typecheck**

Run: `deno check src/config.ts`
Expected: no errors.

- [ ] **Step 4: Add the test**

Append to `tests/config.test.ts`:
```typescript
Deno.test("loadConfig defaults the human member name", async () => {
  const cfg = await loadConfig();
  assertEquals(cfg.humanName, "human");
});
```

- [ ] **Step 5: Run the test**

Run: `deno test --env-file=.env.example --allow-env --allow-read tests/config.test.ts`
Expected: all pass (including the new case). (If `.env.example` sets `A2A_HUMAN_NAME`, adjust the expectation to match it.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(rooms): config humanName for REPL room participation"
```

---

## Task 2: Broker `join` endpoint + client method (human joins an existing room)

**Files:**
- Modify: `src/rooms/server.ts`, `src/rooms/client.ts`
- Test: `tests/rooms/server.test.ts`, `tests/rooms/client.test.ts`

The store already has `addMember(roomId, {name, inboxUrl, kind})`. `createRoom`'s `humanMembers` handles room *creation*; `invite` only resolves agents via the registry. So a human joining an *existing* room needs a path that accepts a supplied inbox URL. `join` exposes `addMember` over HTTP.

- [ ] **Step 1: Add the failing client test (stubbed fetch)**

Append to `tests/rooms/client.test.ts`:
```typescript
Deno.test("join POSTs name/inboxUrl/kind", async () => {
  let captured: unknown;
  let capturedUrl = "";
  const restore = stubFetch((url, init) => {
    capturedUrl = url;
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  await client.join("r1", { name: "human", inboxUrl: "http://repl:5000" });
  restore();
  assertEquals(capturedUrl, "http://broker/rooms/r1/join");
  assertEquals(captured, { name: "human", inboxUrl: "http://repl:5000" });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --allow-net tests/rooms/client.test.ts`
Expected: FAIL — `client.join is not a function`.

- [ ] **Step 3: Implement `join` in `src/rooms/client.ts`**

Add this method to `RoomBrokerClient` (after `invite`):
```typescript
  async join(
    roomId: string,
    body: { name: string; inboxUrl: string; kind?: "agent" | "human" },
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`);
    await res.body?.cancel();
  }
```

- [ ] **Step 4: Run the client test to verify it passes**

Run: `deno test --allow-net tests/rooms/client.test.ts`
Expected: all pass.

- [ ] **Step 5: Add the failing server test**

Append to `tests/rooms/server.test.ts` (the file already imports `assertEquals`, `startRoomBroker`, types):
```typescript
Deno.test("join adds a human member who then receives pushed deliveries", async () => {
  const kv = await Deno.openKv(":memory:");
  const pushedTo: Array<{ url: string; delivery: InboxDelivery }> = [];
  const inboxes: Record<string, string> = { Alvy: "http://alvy" };
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (name) => Promise.resolve(inboxes[name] ?? null),
    push: (url, d) => { pushedTo.push({ url, delivery: d }); return Promise.resolve(true); },
    agentDeadlineMs: 1000, humanDeadlineMs: 1000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const base = broker.url;
  const h = { "content-type": "application/json", "authorization": "Bearer tok" };

  // Alvy creates a room solo; the human joins with its own inbox URL.
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "t", members: ["Alvy"], createdBy: "Alvy", sessionId: "s1" }),
  })).json();
  const roomId = created.roomId;

  const joinRes = await fetch(`${base}/rooms/${roomId}/join`, {
    method: "POST", headers: h,
    body: JSON.stringify({ name: "human", inboxUrl: "http://repl" }),
  });
  assertEquals(joinRes.status, 200);
  await joinRes.body?.cancel();

  // Alvy addresses the human -> delivery pushed to the human's supplied URL.
  await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h,
    body: JSON.stringify({ from: "Alvy", text: "hi human", to: ["human"] }),
  });

  assertEquals(pushedTo.length, 1);
  assertEquals(pushedTo[0].url, "http://repl");
  assertEquals(pushedTo[0].delivery.addressedBy, "Alvy");
  await broker.shutdown(); kv.close();
});
```

- [ ] **Step 6: Run to confirm failure**

Run: `deno test --unstable-kv --allow-net --allow-read tests/rooms/server.test.ts`
Expected: FAIL — `join` returns 404 (route not found) so `joinRes.status` is not 200.

- [ ] **Step 7: Implement the `join` route in `src/rooms/server.ts`**

Add this handler immediately after the `app.post("/rooms/:id/invite", ...)` block:
```typescript
  app.post("/rooms/:id/join", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const body = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    const name = String(body.name ?? "");
    const inboxUrl = String(body.inboxUrl ?? "");
    if (!name || !inboxUrl) return c.json({ error: "name and inboxUrl required" }, 400);
    const kind = body.kind === "agent" ? "agent" : "human";
    await store.addMember(roomId, { name, inboxUrl, kind });
    ev(room.sessionId, roomId, name, "room.invited", { agent: name });
    return c.json({ ok: true });
  });
```

- [ ] **Step 8: Run the server tests to verify they pass**

Run: `deno test --unstable-kv --allow-net --allow-read tests/rooms/server.test.ts`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add src/rooms/server.ts src/rooms/client.ts tests/rooms/server.test.ts tests/rooms/client.test.ts
git commit -m "feat(rooms): broker join endpoint so a human can join an existing room"
```

---

## Task 3: REPL line classifier + delivery formatter (pure, no I/O)

**Files:**
- Modify: `src/repl.ts`
- Test: `tests/repl-parse.test.ts`

This adds exported pure functions; the existing `runRepl` is left untouched until Task 5. Only a type-only import of `InboxDelivery` is added — no runtime imports yet.

- [ ] **Step 1: Write the failing tests**

Create `tests/repl-parse.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { classifyLine, formatDelivery, parseLeadingMentions } from "../src/repl.ts";
import type { InboxDelivery } from "../src/rooms/types.ts";

const NO_FOCUS = {
  focusedRoomId: null,
  focusedMembers: new Set<string>(),
  knownAgents: new Set(["scout", "coordinator"]),
  lastAddressedBy: null,
};
function focused(members: string[], lastAddressedBy: string | null = null) {
  return {
    focusedRoomId: "r1",
    focusedMembers: new Set(members),
    knownAgents: new Set(["scout", "coordinator"]),
    lastAddressedBy,
  };
}

Deno.test("parseLeadingMentions pulls leading @tokens", () => {
  assertEquals(parseLeadingMentions("@A @B hello there"), { to: ["A", "B"], rest: "hello there" });
  assertEquals(parseLeadingMentions("no mentions"), { to: [], rest: "no mentions" });
});

Deno.test("empty / quit / commands", () => {
  assertEquals(classifyLine("", NO_FOCUS).kind, "empty");
  assertEquals(classifyLine(":quit", NO_FOCUS).kind, "quit");
  assertEquals(classifyLine(":q", NO_FOCUS).kind, "quit");
  assertEquals(classifyLine(":rooms", NO_FOCUS).kind, "rooms");
  assertEquals(classifyLine(":room leave", focused(["scout"])).kind, "roomLeave");
  assertEquals(classifyLine(":room log", focused(["scout"])).kind, "roomLog");
});

Deno.test(":room new parses a multi-word title and member CSV", () => {
  const c = classifyLine(":room new hotdog debate Alvy,Bex", NO_FOCUS);
  assertEquals(c, { kind: "roomNew", title: "hotdog debate", members: ["Alvy", "Bex"] });
});

Deno.test(":room join parses a roomId", () => {
  assertEquals(classifyLine(":room join r-123", NO_FOCUS), { kind: "roomJoin", roomId: "r-123" });
});

Deno.test("@agent direct-send when not focused", () => {
  assertEquals(classifyLine("@scout find foo", NO_FOCUS), { kind: "direct", agent: "scout", prompt: "find foo" });
});

Deno.test("unknown @name when not focused is a hint", () => {
  assertEquals(classifyLine("@nobody hi", NO_FOCUS).kind, "hint");
});

Deno.test("@member while focused is a room post", () => {
  // Bex is a member of the focused room.
  assertEquals(
    classifyLine("@Bex your turn", focused(["Bex"])),
    { kind: "roomPost", to: ["Bex"], text: "your turn" },
  );
});

Deno.test("@known-agent that is NOT a focused member still direct-sends", () => {
  // scout is a known agent but not in this room -> escape to direct send.
  assertEquals(
    classifyLine("@scout summarize", focused(["Bex"])),
    { kind: "direct", agent: "scout", prompt: "summarize" },
  );
});

Deno.test("plain line while focused replies to last addresser", () => {
  assertEquals(
    classifyLine("sounds good", focused(["Bex"], "Bex")),
    { kind: "roomPost", to: ["Bex"], text: "sounds good" },
  );
});

Deno.test("plain line while focused with no addresser broadcasts", () => {
  assertEquals(
    classifyLine("anyone there", focused(["Bex"], null)),
    { kind: "roomPost", to: ["*"], text: "anyone there" },
  );
});

Deno.test("formatDelivery renders the addressed line", () => {
  const d: InboxDelivery = {
    roomId: "r1", turnId: "t1", addressedBy: "Bex", title: "debate", members: ["human", "Bex"],
    transcript: [{ seq: 0, roomId: "r1", from: "Bex", to: ["human"], text: "your move", ts: 1 }],
  };
  assertEquals(formatDelivery(d), "[room: debate] Bex → you: your move");
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --allow-read tests/repl-parse.test.ts`
Expected: FAIL — `classifyLine`/`formatDelivery`/`parseLeadingMentions` are not exported.

- [ ] **Step 3: Add the classifier + formatter to `src/repl.ts`**

At the top of `src/repl.ts`, add a type-only import (alongside the existing imports):
```typescript
import type { InboxDelivery } from "./rooms/types.ts";
```

Then add this block to `src/repl.ts` (place it above `runRepl`):
```typescript
// ---- Pure line classification (no I/O, unit-tested) ----

export type Classified =
  | { kind: "empty" }
  | { kind: "quit" }
  | { kind: "rooms" }
  | { kind: "roomNew"; title: string; members: string[] }
  | { kind: "roomJoin"; roomId: string }
  | { kind: "roomLeave" }
  | { kind: "roomLog" }
  | { kind: "direct"; agent: string; prompt: string }
  | { kind: "roomPost"; to: string[]; text: string }
  | { kind: "hint"; message: string };

export type ClassifyOpts = {
  focusedRoomId: string | null;
  focusedMembers: ReadonlySet<string>;
  knownAgents: ReadonlySet<string>;
  lastAddressedBy: string | null;
};

// "@A @B hello" -> { to: ["A","B"], rest: "hello" }
export function parseLeadingMentions(line: string): { to: string[]; rest: string } {
  const to: string[] = [];
  let rest = line.trim();
  let m: RegExpMatchArray | null;
  while ((m = rest.match(/^@(\S+)\s+(.*)$/))) {
    to.push(m[1]);
    rest = m[2].trim();
  }
  return { to, rest };
}

export function classifyLine(raw: string, opts: ClassifyOpts): Classified {
  const line = raw.trim();
  if (!line) return { kind: "empty" };
  if (line === ":quit" || line === ":q") return { kind: "quit" };
  if (line === ":rooms") return { kind: "rooms" };

  if (line.startsWith(":room")) {
    const rest = line.slice(":room".length).trim();
    if (rest === "leave") return { kind: "roomLeave" };
    if (rest === "log") return { kind: "roomLog" };
    if (rest.startsWith("new")) {
      const tokens = rest.slice("new".length).trim().split(/\s+/).filter(Boolean);
      if (tokens.length < 2) return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      const members = tokens.pop()!.split(",").map((s) => s.trim()).filter(Boolean);
      const title = tokens.join(" ");
      if (!title || members.length === 0) {
        return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      }
      return { kind: "roomNew", title, members };
    }
    if (rest.startsWith("join")) {
      const roomId = rest.slice("join".length).trim();
      if (!roomId) return { kind: "hint", message: "usage: :room join <roomId>" };
      return { kind: "roomJoin", roomId };
    }
    return { kind: "hint", message: "commands: :rooms, :room new|join|leave|log" };
  }

  const at = line.match(/^@(\S+)\s+(.+)$/);
  if (at) {
    const [, first, restText] = at;
    // Addressing an active member of the focused room => room post.
    if (opts.focusedRoomId && opts.focusedMembers.has(first)) {
      const parsed = parseLeadingMentions(line);
      return { kind: "roomPost", to: parsed.to, text: parsed.rest };
    }
    // A known agent that is NOT a focused member => direct-send escape (focused or not).
    if (opts.knownAgents.has(first)) return { kind: "direct", agent: first, prompt: restText };
    // Focused but unknown @name => treat as a room recipient (broker drops unknowns).
    if (opts.focusedRoomId) {
      const parsed = parseLeadingMentions(line);
      return { kind: "roomPost", to: parsed.to, text: parsed.rest };
    }
    return { kind: "hint", message: `unknown agent: ${first}` };
  }

  // Plain line.
  if (opts.focusedRoomId) {
    const to = opts.lastAddressedBy ? [opts.lastAddressedBy] : ["*"];
    return { kind: "roomPost", to, text: line };
  }
  return {
    kind: "hint",
    message: `(use @<agent> <prompt>; known: ${[...opts.knownAgents].join(", ")})`,
  };
}

// The line printed when a delivery arrives for the human.
export function formatDelivery(d: InboxDelivery): string {
  const text = d.transcript.at(-1)?.text ?? "";
  return `[room: ${d.title}] ${d.addressedBy} → you: ${text}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --allow-read tests/repl-parse.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/repl.ts tests/repl-parse.test.ts
git commit -m "feat(rooms): pure REPL line classifier + delivery formatter"
```

---

## Task 4: REPL inbox server

**Files:**
- Modify: `src/repl.ts`
- Test: `tests/repl-inbox.test.ts`

A tiny Hono `/inbox` server mirroring the agent inbox contract (`src/agent/base.ts`): bearer-auth, `202` immediately, deliveries drained one-at-a-time via the shared `InboxQueue`.

- [ ] **Step 1: Write the failing test**

Create `tests/repl-inbox.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { startReplInbox } from "../src/repl.ts";
import type { InboxDelivery } from "../src/rooms/types.ts";

function delivery(roomId: string): InboxDelivery {
  return { roomId, turnId: "t", addressedBy: "Bex", title: "t", members: [], transcript: [] };
}

Deno.test("startReplInbox returns 202 and invokes onDelivery", async () => {
  const seen: string[] = [];
  const inbox = startReplInbox({ token: "tok", onDelivery: (d) => { seen.push(d.roomId); } });
  const res = await fetch(`${inbox.url}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer tok" },
    body: JSON.stringify(delivery("r1")),
  });
  await res.body?.cancel();
  assertEquals(res.status, 202);
  await inbox.drain();
  assertEquals(seen, ["r1"]);
  await inbox.shutdown();
});

Deno.test("startReplInbox rejects a bad token with 401", async () => {
  const inbox = startReplInbox({ token: "tok", onDelivery: () => {} });
  const res = await fetch(`${inbox.url}/inbox`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer wrong" },
    body: JSON.stringify(delivery("r1")),
  });
  await res.body?.cancel();
  assertEquals(res.status, 401);
  await inbox.shutdown();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --allow-net tests/repl-inbox.test.ts`
Expected: FAIL — `startReplInbox` is not exported.

- [ ] **Step 3: Add runtime imports + `startReplInbox` to `src/repl.ts`**

Add these imports at the top of `src/repl.ts`:
```typescript
import { Hono } from "hono";
import { InboxQueue } from "./agent/inbox.ts";
import { RoomBrokerClient } from "./rooms/client.ts";
```
(The `RoomBrokerClient` import is used in Task 5; adding it now keeps imports together.)

Add this block to `src/repl.ts` (below `formatDelivery`):
```typescript
// ---- REPL inbox server ----

export type ReplInboxHandle = {
  url: string;
  port: number;
  shutdown: () => Promise<void>;
  drain: () => Promise<void>;
};

// A tiny /inbox server. Mirrors the agent inbox contract: bearer-authed,
// returns 202 immediately, deliveries drained one-at-a-time so prints stay
// ordered and the broker is never blocked.
export function startReplInbox(opts: {
  token: string;
  port?: number;
  onDelivery: (d: InboxDelivery) => void;
}): ReplInboxHandle {
  const app = new Hono();
  const queue = new InboxQueue<InboxDelivery>((d) => {
    opts.onDelivery(d);
    return Promise.resolve();
  });
  app.post("/inbox", async (c) => {
    const authz = c.req.header("authorization") ?? "";
    if (opts.token && authz !== `Bearer ${opts.token}`) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    queue.enqueue(body as InboxDelivery);
    return c.json({ ok: true }, 202);
  });
  const server = Deno.serve({ port: opts.port ?? 0, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://localhost:${port}`,
    port,
    shutdown: () => server.shutdown(),
    drain: () => queue.drain(),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net tests/repl-inbox.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/repl.ts tests/repl-inbox.test.ts
git commit -m "feat(rooms): REPL /inbox server (202 + serialized drain)"
```

---

## Task 5: Rewire `runRepl` — injectable I/O, room state, commands, dispatch

**Files:**
- Modify: `src/repl.ts`
- Test: `tests/repl-e2e.test.ts` (first case — no stub agent)

This replaces the body of `runRepl` and extends `ReplDeps`. Input/output become injectable so the loop is testable offline; the existing `@agent` direct-send is preserved verbatim as an internal helper.

- [ ] **Step 1: Write the failing integration test (create + focus + post, no stub agent)**

Create `tests/repl-e2e.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { runRepl } from "../src/repl.ts";
import { startRoomBroker } from "../src/rooms/server.ts";
import { RoomBrokerClient } from "../src/rooms/client.ts";
import type { AgentCard } from "../src/protocol/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Yields scripted lines with a gap before each so async deliveries can land.
async function* scripted(lines: string[], gapMs = 150): AsyncGenerator<string> {
  for (const l of lines) {
    await sleep(gapMs);
    yield l;
  }
}

Deno.test("runRepl creates a room, focuses it, and posts a typed line", async () => {
  const kv = await Deno.openKv(":memory:");
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: () => Promise.resolve(null), // no agents resolve; room is human-only
    agentDeadlineMs: 1000, humanDeadlineMs: 60_000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const out: string[] = [];

  await runRepl({
    agents: new Map<string, AgentCard>(),
    bearerToken: "tok",
    roomBrokerUrl: broker.url,
    humanName: "human",
    output: (s) => out.push(s),
    input: scripted([":room new solo X", "hello room", ":quit"]),
  });

  const client = new RoomBrokerClient(broker.url, "tok");
  const rooms = await client.listByMember("human");
  assertEquals(rooms.length, 1);
  const got = await client.get(rooms[0].roomId);
  const mine = got!.transcript.find((m) => m.from === "human");
  assertEquals(mine?.text, "hello room");

  await broker.shutdown(); kv.close();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --unstable-kv --allow-net --allow-read tests/repl-e2e.test.ts`
Expected: FAIL — `runRepl` does not accept `roomBrokerUrl`/`output`/`input`, and no room is created.

- [ ] **Step 3: Extend `ReplDeps` in `src/repl.ts`**

Replace the existing `ReplDeps` type with:
```typescript
export type ReplDeps = {
  agents: Map<string, AgentCard>; // name → card
  bearerToken: string;
  emit?: Emitter;
  // Rooms: when a broker URL (or client) is provided, room commands are enabled.
  roomBrokerUrl?: string;
  roomsClient?: RoomBrokerClient; // test seam; defaults to one built from roomBrokerUrl
  humanName?: string; // the human's member name; default "human"
  // I/O seams (default: real stdin lines / stdout). Tests inject scripted I/O.
  input?: AsyncIterable<string>;
  output?: (s: string) => void;
  inboxPort?: number; // default 0 (dynamic)
};
```

- [ ] **Step 4: Replace the body of `runRepl` in `src/repl.ts`**

Replace the entire existing `runRepl` function with:
```typescript
// Default input: decode stdin chunks into lines (one chunk == one line, as before).
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) yield decoder.decode(chunk);
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const enc = new TextEncoder();
  const write = deps.output ?? ((s: string) => { Deno.stdout.writeSync(enc.encode(s)); });
  const input = deps.input ?? stdinLines();
  const contextId = crypto.randomUUID();
  const sessionId = contextId; // session == driver run
  const emit: Emitter = deps.emit ?? (() => Promise.resolve());
  const humanName = deps.humanName ?? "human";
  const rooms = deps.roomsClient ??
    (deps.roomBrokerUrl ? new RoomBrokerClient(deps.roomBrokerUrl, deps.bearerToken) : undefined);
  const knownAgents = new Set(deps.agents.keys());

  // ---- Room state ----
  let focusedRoomId: string | null = null;
  let focusedTitle = "";
  let focusedMembers = new Set<string>();
  // Most recent unanswered delivery per room: turnId to thread + who addressed us.
  const pending = new Map<string, { turnId: string; addressedBy: string }>();

  let inbox: ReplInboxHandle | null = null;
  const ensureInbox = (): ReplInboxHandle => {
    if (!inbox) {
      inbox = startReplInbox({
        token: deps.bearerToken,
        port: deps.inboxPort,
        onDelivery: (d) => {
          pending.set(d.roomId, { turnId: d.turnId, addressedBy: d.addressedBy });
          if (d.roomId === focusedRoomId) {
            focusedMembers = new Set(d.members);
            focusedTitle = d.title;
          }
          write(`\n${formatDelivery(d)}\n> `); // print then redraw the prompt
        },
      });
    }
    return inbox;
  };

  const refreshFocused = async (roomId: string) => {
    const got = await rooms?.get(roomId);
    if (got) {
      focusedTitle = got.room.title;
      focusedMembers = new Set(got.room.members.filter((m) => m.active).map((m) => m.name));
    }
  };

  // ---- Direct send to an agent (existing behavior, unchanged) ----
  const directSend = async (name: string, prompt: string) => {
    const card = deps.agents.get(name);
    if (!card) { write(`unknown agent: ${name}\n`); return; }
    const requestId = crypto.randomUUID();
    void emit({
      sessionId, requestId, agent: "REPL", depth: 0, ts: now(),
      type: "request.started", data: { target: name, prompt },
    });
    write(`[${name}] `);
    const startedTs = now();
    try {
      for await (const ev of streamMessage({
        url: card.url, token: deps.bearerToken, depth: 0, sessionId, requestId,
        message: {
          messageId: crypto.randomUUID(), role: "user",
          parts: [{ type: "text", text: prompt }], contextId,
        },
      })) {
        if (ev.type === "delta") write(ev.text);
        else if (ev.type === "tool") {
          const argsStr = JSON.stringify(ev.args);
          const compact = argsStr.length > 80 ? argsStr.slice(0, 77) + "…" : argsStr;
          write(`\n  · ${ev.name}${compact}\n  `);
        } else if (ev.type === "error") write(`\n[error] ${ev.message}`);
        else if (ev.type === "done") break;
      }
    } catch (e) {
      write(`\n[error] ${(e as Error).message}`);
    }
    void emit({
      sessionId, requestId, agent: "REPL", depth: 0, ts: now(),
      type: "request.completed", data: { durationMs: now() - startedTs },
    });
  };

  write(PROMPT);

  for await (const chunk of input) {
    const cls = classifyLine(chunk, {
      focusedRoomId, focusedMembers, knownAgents,
      lastAddressedBy: focusedRoomId ? (pending.get(focusedRoomId)?.addressedBy ?? null) : null,
    });

    if (cls.kind === "empty") { write(PROMPT); continue; }
    if (cls.kind === "quit") break;
    if (cls.kind === "hint") { write(cls.message + "\n"); write(PROMPT); continue; }

    if (cls.kind === "direct") { await directSend(cls.agent, cls.prompt); write(PROMPT); continue; }

    // ---- Room commands (all require a broker) ----
    if (!rooms) { write("rooms are disabled (no broker)\n"); write(PROMPT); continue; }

    if (cls.kind === "rooms") {
      const list = await rooms.listByMember(humanName);
      if (!list.length) write("(no rooms)\n");
      for (const r of list) {
        write(`  ${r.roomId}  "${r.title}"  [${r.status}]${r.roomId === focusedRoomId ? " *focused" : ""}\n`);
      }
      write(PROMPT); continue;
    }

    if (cls.kind === "roomNew") {
      const ib = ensureInbox();
      try {
        const res = await rooms.createRoom({
          title: cls.title, members: cls.members, createdBy: humanName, sessionId,
          humanMembers: [{ name: humanName, inboxUrl: ib.url }],
        });
        focusedRoomId = res.roomId;
        await refreshFocused(res.roomId);
        write(`joined room ${res.roomId} "${cls.title}"`);
        if (res.unresolved.length) write(`  (unresolved: ${res.unresolved.join(", ")})`);
        write("\n");
      } catch (e) { write(`[error] ${(e as Error).message}\n`); }
      write(PROMPT); continue;
    }

    if (cls.kind === "roomJoin") {
      const ib = ensureInbox();
      try {
        await rooms.join(cls.roomId, { name: humanName, inboxUrl: ib.url });
        focusedRoomId = cls.roomId;
        await refreshFocused(cls.roomId);
        write(`joined room ${cls.roomId} "${focusedTitle}"\n`);
      } catch (e) { write(`[error] ${(e as Error).message}\n`); }
      write(PROMPT); continue;
    }

    if (cls.kind === "roomLeave") {
      if (!focusedRoomId) { write("not in a room\n"); write(PROMPT); continue; }
      try { await rooms.leave(focusedRoomId, humanName); } catch { /* ignore */ }
      write(`left room ${focusedRoomId}\n`);
      pending.delete(focusedRoomId);
      focusedRoomId = null; focusedMembers = new Set(); focusedTitle = "";
      write(PROMPT); continue;
    }

    if (cls.kind === "roomLog") {
      if (!focusedRoomId) { write("not in a room\n"); write(PROMPT); continue; }
      const got = await rooms.get(focusedRoomId);
      if (!got || !got.transcript.length) write("(no history)\n");
      else for (const m of got.transcript) {
        write(`  [${m.from}${m.to.length ? " → " + m.to.join(", ") : ""}] ${m.text}\n`);
      }
      write(PROMPT); continue;
    }

    if (cls.kind === "roomPost") {
      if (!focusedRoomId) { write("not in a room\n"); write(PROMPT); continue; }
      if (!cls.text) { write("(nothing to post)\n"); write(PROMPT); continue; }
      const p = pending.get(focusedRoomId);
      try {
        await rooms.post(focusedRoomId, {
          from: humanName, text: cls.text, to: cls.to, turnId: p?.turnId,
        });
        pending.delete(focusedRoomId); // we've answered this delivery
      } catch (e) { write(`[error] ${(e as Error).message}\n`); }
      write(PROMPT); continue;
    }
  }

  // ---- Cleanup: leave the focused room and stop the inbox server ----
  if (focusedRoomId && rooms) { try { await rooms.leave(focusedRoomId, humanName); } catch { /* ignore */ } }
  if (inbox) await inbox.shutdown();
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno test --unstable-kv --allow-net --allow-read tests/repl-e2e.test.ts`
Expected: the first case passes.

- [ ] **Step 6: Typecheck the whole module**

Run: `deno check src/repl.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/repl.ts tests/repl-e2e.test.ts
git commit -m "feat(rooms): runRepl room participation (commands, focus, inbox, turn threading)"
```

---

## Task 6: Orchestrator wiring + full end-to-end (human delivery + reply with correct turnId)

**Files:**
- Modify: `src/orchestrator.ts`
- Test: `tests/repl-e2e.test.ts` (append the full round-trip case)

- [ ] **Step 1: Pass room context into `runRepl`**

In `src/orchestrator.ts`, inside `runOrchestrator`, replace the `runRepl(...)` call:
```typescript
  await runRepl({ agents: ctx.agents, bearerToken: ctx.bearerToken, emit: ctx.emit });
```
with:
```typescript
  await runRepl({
    agents: ctx.agents,
    bearerToken: ctx.bearerToken,
    emit: ctx.emit,
    roomBrokerUrl: ctx.roomBrokerUrl,
    humanName: cfg.humanName,
  });
```

- [ ] **Step 2: Typecheck the orchestrator**

Run: `deno check src/orchestrator.ts`
Expected: no errors.

- [ ] **Step 3: Append the full round-trip integration test**

Append to `tests/repl-e2e.test.ts` (add the new imports at the top of the file):
```typescript
import { startAgent } from "../src/agent/base.ts";
import { makeRoomTurnProcessor } from "../src/agent/room-turn.ts";
import type { RoomTurnState } from "../src/rooms/types.ts";
import type { PostInput } from "../src/rooms/types.ts";
import type { EmitEvent } from "../src/observability/events.ts";

function card(name: string): AgentCard {
  return {
    name, description: "", version: "1.0.0", url: "http://localhost:0", skills: [],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
  };
}

// Stub agent: on its FIRST delivery, replies to whoever addressed it; then silent.
async function stubAgent(name: string, brokerUrl: string) {
  const rooms = new RoomBrokerClient(brokerUrl, "tok");
  const roomTurn: RoomTurnState = { active: null };
  let turn = 0;
  const handler = async (ctx: { requestId: string }) => {
    if (turn++ === 0) {
      await rooms.post(ctx.requestId, {
        from: name, text: "hi there", to: [roomTurn.active!.addressedBy], turnId: roomTurn.active!.turnId,
      });
    }
    return { text: "" }; // posted (or staying silent -> room-turn auto-acks)
  };
  const store = { clear: () => Promise.resolve() } as never;
  const onInbox = makeRoomTurnProcessor({ selfName: name, handler, rooms, roomTurn, store });
  const handle = await startAgent({
    card: card(name), bearerToken: "tok", handler: () => Promise.resolve({ text: "" }),
    // deno-lint-ignore require-yield
    streamHandler: async function* () { return; }, onInbox,
  });
  return { handle, url: `http://localhost:${handle.port}` };
}

Deno.test("human receives a delivery and replies with the correct turnId", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const events: EmitEvent[] = [];
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    emit: (e) => { events.push(e); return Promise.resolve(); },
    agentDeadlineMs: 2000, humanDeadlineMs: 60_000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });
  const bex = await stubAgent("Bex", broker.url);
  urls["Bex"] = bex.url;

  // A client wrapper that records the human's outgoing posts (to inspect turnId).
  const real = new RoomBrokerClient(broker.url, "tok");
  const postCalls: Array<{ roomId: string; body: PostInput }> = [];
  const spy = {
    createRoom: (b: Parameters<RoomBrokerClient["createRoom"]>[0]) => real.createRoom(b),
    join: (id: string, b: Parameters<RoomBrokerClient["join"]>[1]) => real.join(id, b),
    post: (id: string, b: PostInput) => { postCalls.push({ roomId: id, body: b }); return real.post(id, b); },
    leave: (id: string, n: string) => real.leave(id, n),
    get: (id: string) => real.get(id),
    listByMember: (n: string) => real.listByMember(n),
  } as unknown as RoomBrokerClient;

  const out: string[] = [];
  await runRepl({
    agents: new Map<string, AgentCard>(),
    bearerToken: "tok",
    roomsClient: spy,
    humanName: "human",
    output: (s) => out.push(s),
    // gap 250ms so each round-trip (broker -> Bex -> broker -> human inbox) lands.
    input: scripted([":room new debate Bex", "@Bex hello", "your turn", ":quit"], 250),
  });

  // 1. The delivery from Bex printed for the human.
  const printed = out.join("");
  assertEquals(printed.includes("[room: debate] Bex → you: hi there"), true);

  // 2. The human's reply ("your turn") addressed Bex and carried a turnId.
  const reply = postCalls.find((p) => p.body.text === "your turn");
  assertEquals(reply?.body.to, ["Bex"]);
  assertEquals(typeof reply?.body.turnId, "string");

  // 3. The room reached idle — only possible if that turnId resolved the
  //    human's pending delivery (sweep is off, so a wrong/missing turnId
  //    would leave it pending forever).
  assertEquals(events.some((e) => e.type === "room.idle"), true);

  // 4. Transcript shows the full exchange.
  const rid = postCalls[0].roomId;
  const texts = (await real.get(rid))!.transcript.map((m) => m.text);
  assertEquals(texts.includes("hello"), true);
  assertEquals(texts.includes("hi there"), true);
  assertEquals(texts.includes("your turn"), true);

  await bex.handle.shutdown(); await broker.shutdown(); kv.close();
});
```

- [ ] **Step 4: Run the e2e tests to verify they pass**

Run: `deno test --unstable-kv --allow-net --allow-read tests/repl-e2e.test.ts`
Expected: both cases pass. (If the round-trip case is flaky, the gap in `scripted([...], 250)` is the only timing knob — raise it; it does not change behavior.)

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts tests/repl-e2e.test.ts
git commit -m "feat(rooms): wire human room participation into runOrchestrator + e2e"
```

---

## Task 7: Full suite green + lint

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `deno task test`
Expected: all tests pass (Plan 1's 115 + the new room-human tests). Note the count for the completion report.

- [ ] **Step 2: Lint + typecheck the touched files**

Run: `deno lint src/repl.ts src/rooms/server.ts src/rooms/client.ts src/config.ts src/orchestrator.ts`
Then: `deno check src/repl.ts src/orchestrator.ts`
Expected: no findings, no errors.

- [ ] **Step 3: Commit any lint fixes (if needed)**

```bash
git add -A
git commit -m "chore(rooms): lint/typecheck cleanup for human participation"
```

- [ ] **Step 4: Finish the branch**

Use the **superpowers:finishing-a-development-branch** skill. The expected choice is **"keep"** so Plan 3 (`agent-rooms-monitor`) can stack on top of this branch.

---

## Manual verification (optional, not a test)

With real agents running (`deno task start`), in the REPL:
1. `:room new hotdog debate scout,coordinator` → creates and focuses the room; you are a member.
2. Watch agents converse; when one `@human`-addresses you, a `[room: hotdog debate] <agent> → you: …` line prints.
3. Type a plain line to reply to that agent, or `@scout ...` to address scout specifically.
4. `:rooms` lists your rooms, `:room log` prints the transcript, `:room leave` exits.
5. `@scout <prompt>` (when not focused, or to an agent not in the focused room) still does a direct send.

---

## Self-Review (run against the spec's "REPL & human participation" section)

- **Inbox: lazy Hono `/inbox` server on first join, registered as `kind:"human"` with that URL** → Task 4 (`startReplInbox`) + Task 5 (`ensureInbox` on `:room new`/`:room join`; `humanMembers`/`join` carry the URL). ✓
- **Incoming deliveries print `[room: <title>] <from> → you: <text>` then redraw the prompt** → `formatDelivery` (Task 3) + `onDelivery` writes the line + `"> "` (Task 5). ✓
- **`:room new <title> <a,b,...>` (create + focus; human auto-added)** → `classifyLine` roomNew (Task 3) + handler passing `humanMembers` and `createdBy: humanName` (Task 5; broker's creator-auto-add already skips the human since it's in `humanMembers`). ✓
- **`:room join <roomId>` / `:room leave` / `:rooms` / `:room log`** → classifier + handlers (Tasks 3, 5) + broker `join` endpoint (Task 2). ✓
- **Focused: plain line posts; `@Name` sets `to`; else reply to last addresser (`["*"]` if nobody)** → `classifyLine` (Task 3), verified by unit tests. ✓
- **`@agent <prompt>` still escapes to a direct send** → `classifyLine` direct case + `directSend` helper preserving the original streaming path (Tasks 3, 5). ✓
- **Human turn accounting: thread the delivery's `turnId` into the reply post** → `pending` map records `turnId` per room on delivery; `roomPost` handler threads it; asserted end-to-end via the `room.idle` event (Tasks 5, 6). ✓
- **Human deliveries get a long deadline (humanDeadlineMs)** → already in Plan 1's broker `fanOut` (`member.kind === "human" ? humanDeadlineMs : agentDeadlineMs`); confirmed, no change needed. ✓
- **Both kickoff flows (human-driven `:room new …` and agent-driven `@coordinator …`)** → `:room new` covered; agent-driven needs only the human to be addressable, covered by the inbox + `join`/`humanMembers`. ✓
- **Does NOT touch `monitor/`** → confirmed; no monitor files in this plan. ✓
- **Testable offline, no LLM** → all tests use `:memory:` KV, injected I/O, and a deterministic stub agent. ✓
- **Rough edge noted (mid-type prints)** → acknowledged in the architecture note; kept simple (print + redraw prompt), not over-engineered. ✓
