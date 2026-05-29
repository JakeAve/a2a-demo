# Agent Rooms Core — Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a central Room Broker service and agent-side inbox so tool-capable agents can hold async, multi-party, `@mention`-addressed conversations ("rooms") — independent of the synchronous `delegate_*` RPC path.

**Architecture:** A new `src/rooms/` service (Hono + its own Deno KV, mirroring the registry/monitor services) owns room membership, the canonical transcript, delivery records, and push delivery. Agents gain a fire-and-forget `POST /inbox` endpoint backed by a serialized FIFO; each delivery runs **one** room-turn by feeding the existing backend handler a synthesized "transcript + instruction" message with room tools available. `turnId` is threaded through a per-agent mutable holder (safe because the inbox consumer is serialized). Loop-safety is idle-detection + a turn-count backstop, not call-stack depth.

**Tech Stack:** Deno, TypeScript, Hono, Deno KV (`--unstable-kv`), `@std/assert` for tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-29-agent-rooms-design.md`

**Scope of this plan (Plan 1):** broker service, agent inbox + room-turn, room tools, config, orchestrator wiring, and an end-to-end integration test with stub agents (no LLM). **Out of scope** (later plans): REPL/human participation (Plan 2), monitor web room view (Plan 3). This plan emits the room events but does not change the monitor UI.

---

## File Structure

**Create:**
- `src/rooms/types.ts` — shared room types (`RoomRecord`, `Member`, `TranscriptMessage`, `Delivery`, `RoomTurnState`, broker I/O types).
- `src/rooms/store.ts` — `RoomStore`: KV persistence + per-room serialization + idle/backstop/sweep logic.
- `src/rooms/client.ts` — `RoomBrokerClient`: typed HTTP client used by agents.
- `src/rooms/server.ts` — `startRoomBroker`: Hono service, delivery push (injectable), event emit.
- `src/agent/inbox.ts` — `InboxQueue`: serialized FIFO consumer.
- `tests/rooms/store.test.ts`, `tests/rooms/server.test.ts`, `tests/agent/inbox.test.ts`, `tests/agent/room-tools.test.ts`, `tests/rooms/e2e.test.ts`.

**Modify:**
- `src/observability/events.ts` — add optional `roomId` + `room.*` event types.
- `src/agent/tools.ts` — room tools, `ROOMS_SUFFIX`, `ToolDeps.rooms` + `ToolDeps.roomTurn`, dispatch, emit-exclusion.
- `src/agent/base.ts` — `POST /inbox` endpoint wired to an `InboxQueue` + `onInbox` callback.
- `src/agent/handlers.ts` — pass `rooms` + `roomTurn` through `BuildHandlersDeps` into each backend's `ToolDeps`.
- `src/agent/ollama.ts`, `src/agent/claude.ts` — accept `rooms`/`roomTurn` in their tool deps (claude-code wiring noted, light).
- `src/agent-entry.ts` — build the room-turn processor, the shared `RoomTurnState`, the `RoomBrokerClient`; pass `onInbox` to `startAgent`; read `--broker`.
- `src/config.ts` — `roomBrokerPort`, `roomMaxTurns`, `agentDeadlineMs`, `humanDeadlineMs`; `--broker` resolution.
- `src/orchestrator.ts` — start the broker in `setupOrchestrator`, add to `OrchestratorContext`, pass `--broker` to spawned agents and to in-process agents' tool deps.

---

## Task 1: Room types + event-schema extensions

**Files:**
- Create: `src/rooms/types.ts`
- Modify: `src/observability/events.ts`
- Test: `tests/observability/events.test.ts` (create if absent)

- [ ] **Step 1: Write `src/rooms/types.ts`**

```typescript
// Shared types for the Room Broker and its clients. The broker owns the
// canonical copies in its own KV; agents only ever see snapshots.

export type MemberKind = "agent" | "human";

export type Member = {
  name: string;
  inboxUrl: string;   // broker pushes deliveries to `${inboxUrl}/inbox`
  kind: MemberKind;
  active: boolean;    // false after leave()
  joinedAt: number;
};

export type RoomRecord = {
  roomId: string;
  title: string;
  createdBy: string;
  status: "open" | "closed";
  members: Member[];
  turnCount: number;     // total posts; checked against maxTurns
  maxTurns: number;
  lastActivityAt: number;
  sessionId: string;     // monitor session that owns this room
};

export type TranscriptMessage = {
  seq: number;
  roomId: string;
  from: string;
  to: string[];
  text: string;
  ts: number;
};

export type Delivery = {
  turnId: string;        // == delivery id
  roomId: string;
  member: string;        // recipient
  addressedBy: string;   // poster who triggered it
  createdAt: number;
  deadline: number;      // sweep resolves pending deliveries past this
  status: "pending" | "resolved";
};

// Mutable per-agent holder, set by the inbox consumer before a room-turn and
// read by the `post` tool to attach the correct turnId. Safe to mutate in
// place because the inbox consumer runs one delivery at a time.
export type RoomTurnState = {
  active: null | {
    roomId: string;
    turnId: string;
    addressedBy: string;
    posted: boolean;
  };
};

// Payload the broker pushes to an agent's /inbox.
export type InboxDelivery = {
  roomId: string;
  turnId: string;
  addressedBy: string;
  title: string;
  members: string[];          // active member names
  transcript: TranscriptMessage[];
};

// Body of POST /rooms/:id/post
export type PostInput = {
  from: string;
  text: string;
  to: string[];
  turnId?: string;
};
```

- [ ] **Step 2: Run typecheck to verify it compiles**

Run: `deno check src/rooms/types.ts`
Expected: `Check src/rooms/types.ts` with no errors.

- [ ] **Step 3: Extend the event schema**

In `src/observability/events.ts`, add the room event types to `EVENT_TYPES` (after `"request.completed"`) and add an optional `roomId` to `EventSchema`.

Add to the `EVENT_TYPES` array:
```typescript
  "room.created",
  "room.invited",
  "room.post",
  "room.ack",
  "room.left",
  "room.idle",
  "room.capped",
  "room.turn_timeout",
  "room.delivery_failed",
  "room.closed",
```

In `EventSchema`, add alongside `threadId`:
```typescript
  roomId: z.string().optional(),
```

- [ ] **Step 4: Write a schema test**

Create `tests/observability/events.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { parseEvent } from "../../src/observability/events.ts";

Deno.test("parseEvent accepts a room.post with roomId", () => {
  const ev = parseEvent({
    sessionId: "s1", requestId: "room-1", seq: 0, ts: 1, agent: "Alvy",
    depth: 0, roomId: "room-1", type: "room.post",
    data: { from: "Alvy", to: ["Bex"], seq: 0, text: "hi" },
  });
  assertEquals(ev.type, "room.post");
  assertEquals(ev.roomId, "room-1");
});

Deno.test("parseEvent still accepts a non-room event without roomId", () => {
  const ev = parseEvent({
    sessionId: "s1", requestId: "r1", seq: 0, ts: 1, agent: "x",
    depth: 0, type: "turn.started", data: {},
  });
  assertEquals(ev.roomId, undefined);
});
```

- [ ] **Step 5: Run the test**

Run: `deno test --allow-read tests/observability/events.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 6: Commit**

```bash
git add src/rooms/types.ts src/observability/events.ts tests/observability/events.test.ts
git commit -m "feat(rooms): room types + room.* event schema"
```

---

## Task 2: RoomStore — rooms, members, transcript

**Files:**
- Create: `src/rooms/store.ts`
- Test: `tests/rooms/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/rooms/store.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { RoomStore } from "../../src/rooms/store.ts";

function fixedClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

async function freshStore() {
  const kv = await Deno.openKv(":memory:");
  const clock = fixedClock();
  return { store: new RoomStore(kv, clock.now), kv, clock };
}

Deno.test("createRoom stores members and is retrievable", async () => {
  const { store, kv } = await freshStore();
  const room = await store.createRoom({
    title: "debate", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(room.members.length, 2);
  assertEquals(room.status, "open");
  assertEquals(room.turnCount, 0);
  const got = await store.getRoom(room.roomId);
  assertEquals(got?.title, "debate");
  assertEquals(got?.members[0].active, true);
  kv.close();
});

Deno.test("appendMessage assigns increasing seq and bumps turnCount", async () => {
  const { store, kv } = await freshStore();
  const room = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  const m0 = await store.appendMessage(room.roomId, { from: "Alvy", to: ["Bex"], text: "one" });
  const m1 = await store.appendMessage(room.roomId, { from: "Bex", to: ["Alvy"], text: "two" });
  assertEquals(m0.seq, 0);
  assertEquals(m1.seq, 1);
  const transcript = await store.getTranscript(room.roomId);
  assertEquals(transcript.map((m) => m.text), ["one", "two"]);
  assertEquals((await store.getRoom(room.roomId))?.turnCount, 2);
  kv.close();
});

Deno.test("listRoomsByMember returns rooms a member belongs to", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  const rooms = await store.listRoomsByMember("Alvy");
  assertEquals(rooms.map((x) => x.roomId), [r.roomId]);
  kv.close();
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `deno test --unstable-kv --allow-read tests/rooms/store.test.ts`
Expected: FAIL — `Module not found "src/rooms/store.ts"`.

- [ ] **Step 3: Implement `src/rooms/store.ts` (rooms/members/transcript half)**

```typescript
// Persistence for the Room Broker. Owns its OWN Deno KV. Mutations for a
// given room are serialised through a per-room promise chain so seq and
// turnCount never race (the pattern monitor/store.ts uses per session).
import type { Member, RoomRecord, TranscriptMessage } from "./types.ts";

export type CreateRoomInput = {
  title: string;
  createdBy: string;
  sessionId: string;
  maxTurns: number;
  members: Array<Pick<Member, "name" | "inboxUrl" | "kind">>;
};

export class RoomStore {
  #seq = new Map<string, number>();             // roomId -> next transcript seq
  #lock = new Map<string, Promise<unknown>>();  // per-room serialisation

  constructor(private kv: Deno.Kv, private now: () => number = () => Date.now()) {}

  // Chain `fn` onto any in-flight mutation for this room.
  #withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#lock.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#lock.set(roomId, next.catch(() => {}));
    return next;
  }

  async createRoom(input: CreateRoomInput): Promise<RoomRecord> {
    const roomId = crypto.randomUUID();
    const now = this.now();
    const room: RoomRecord = {
      roomId,
      title: input.title,
      createdBy: input.createdBy,
      status: "open",
      members: input.members.map((m) => ({ ...m, active: true, joinedAt: now })),
      turnCount: 0,
      maxTurns: input.maxTurns,
      lastActivityAt: now,
      sessionId: input.sessionId,
    };
    await this.kv.set(["room", roomId], room);
    for (const m of room.members) {
      await this.kv.set(["room_by_member", m.name, roomId], 1);
    }
    return room;
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return (await this.kv.get<RoomRecord>(["room", roomId])).value;
  }

  async #setRoom(room: RoomRecord): Promise<void> {
    room.lastActivityAt = this.now();
    await this.kv.set(["room", room.roomId], room);
  }

  async #nextSeq(roomId: string): Promise<number> {
    const cached = this.#seq.get(roomId);
    if (cached !== undefined) return cached;
    let max = -1;
    for await (const e of this.kv.list<TranscriptMessage>({ prefix: ["room_msg", roomId] })) {
      if (e.value.seq > max) max = e.value.seq;
    }
    const next = max + 1;
    this.#seq.set(roomId, next);
    return next;
  }

  appendMessage(
    roomId: string,
    msg: { from: string; to: string[]; text: string },
  ): Promise<TranscriptMessage> {
    return this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) throw new Error(`unknown room ${roomId}`);
      const seq = await this.#nextSeq(roomId);
      const message: TranscriptMessage = {
        seq, roomId, from: msg.from, to: msg.to, text: msg.text, ts: this.now(),
      };
      await this.kv.set(["room_msg", roomId, seq], message);
      this.#seq.set(roomId, seq + 1);
      room.turnCount += 1;
      await this.#setRoom(room);
      return message;
    });
  }

  async getTranscript(roomId: string): Promise<TranscriptMessage[]> {
    const out: TranscriptMessage[] = [];
    for await (const e of this.kv.list<TranscriptMessage>({ prefix: ["room_msg", roomId] })) {
      out.push(e.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async addMember(roomId: string, m: Pick<Member, "name" | "inboxUrl" | "kind">): Promise<void> {
    await this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) throw new Error(`unknown room ${roomId}`);
      const existing = room.members.find((x) => x.name === m.name);
      if (existing) { existing.active = true; existing.inboxUrl = m.inboxUrl; }
      else room.members.push({ ...m, active: true, joinedAt: this.now() });
      await this.#setRoom(room);
      await this.kv.set(["room_by_member", m.name, roomId], 1);
    });
  }

  async listRoomsByMember(name: string): Promise<RoomRecord[]> {
    const out: RoomRecord[] = [];
    for await (const e of this.kv.list({ prefix: ["room_by_member", name] })) {
      const roomId = e.key[e.key.length - 1] as string;
      const room = await this.getRoom(roomId);
      if (room) out.push(room);
    }
    return out;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --unstable-kv --allow-read tests/rooms/store.test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/rooms/store.ts tests/rooms/store.test.ts
git commit -m "feat(rooms): RoomStore rooms/members/transcript with per-room locking"
```

---

## Task 3: RoomStore — deliveries, idle, backstop, leave, sweep

**Files:**
- Modify: `src/rooms/store.ts`
- Test: `tests/rooms/store.test.ts` (append cases)

- [ ] **Step 1: Add the failing tests**

Append to `tests/rooms/store.test.ts`:
```typescript
Deno.test("delivery lifecycle drives the idle check", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(await store.isIdle(r.roomId), true);
  const t1 = await store.createDelivery(r.roomId, "Bex", "Alvy", 5000);
  assertEquals(await store.isIdle(r.roomId), false);
  await store.resolveDelivery(r.roomId, t1.turnId);
  assertEquals(await store.isIdle(r.roomId), true);
  kv.close();
});

Deno.test("sweepExpired resolves only past-deadline pending deliveries", async () => {
  const { store, kv, clock } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [{ name: "Bex", inboxUrl: "http://b", kind: "agent" }],
  });
  const t1 = await store.createDelivery(r.roomId, "Bex", "Alvy", 100); // deadline now+100
  clock.advance(50);
  assertEquals((await store.sweepExpired()).length, 0);   // not yet past
  clock.advance(100);                                      // now past
  const swept = await store.sweepExpired();
  assertEquals(swept.map((d) => d.turnId), [t1.turnId]);
  assertEquals(await store.isIdle(r.roomId), true);
  kv.close();
});

Deno.test("atTurnCap is true once turnCount reaches maxTurns", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 2,
    members: [{ name: "Alvy", inboxUrl: "http://a", kind: "agent" }],
  });
  assertEquals(await store.atTurnCap(r.roomId), false);
  await store.appendMessage(r.roomId, { from: "Alvy", to: [], text: "1" });
  await store.appendMessage(r.roomId, { from: "Alvy", to: [], text: "2" });
  assertEquals(await store.atTurnCap(r.roomId), true);
  kv.close();
});

Deno.test("deactivateMember reports when fewer than 2 active remain", async () => {
  const { store, kv } = await freshStore();
  const r = await store.createRoom({
    title: "t", createdBy: "Alvy", sessionId: "s1", maxTurns: 24,
    members: [
      { name: "Alvy", inboxUrl: "http://a", kind: "agent" },
      { name: "Bex", inboxUrl: "http://b", kind: "agent" },
    ],
  });
  assertEquals(await store.deactivateMember(r.roomId, "Alvy"), true); // 1 active left -> should close
  assertEquals((await store.getRoom(r.roomId))?.members.find((m) => m.name === "Alvy")?.active, false);
  kv.close();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --unstable-kv --allow-read tests/rooms/store.test.ts`
Expected: FAIL — `store.createDelivery is not a function` (and similar).

- [ ] **Step 3: Add the delivery/idle/backstop/leave/sweep methods to `RoomStore`**

Add these methods inside the `RoomStore` class:
```typescript
  async createDelivery(
    roomId: string, member: string, addressedBy: string, ttlMs: number,
  ): Promise<Delivery> {
    const now = this.now();
    const delivery: Delivery = {
      turnId: crypto.randomUUID(), roomId, member, addressedBy,
      createdAt: now, deadline: now + ttlMs, status: "pending",
    };
    await this.kv.set(["room_delivery", roomId, delivery.turnId], delivery);
    return delivery;
  }

  async resolveDelivery(roomId: string, turnId: string): Promise<boolean> {
    const key = ["room_delivery", roomId, turnId];
    const cur = (await this.kv.get<Delivery>(key)).value;
    if (!cur || cur.status === "resolved") return false;
    cur.status = "resolved";
    await this.kv.set(key, cur);
    return true;
  }

  async pendingDeliveries(roomId: string): Promise<Delivery[]> {
    const out: Delivery[] = [];
    for await (const e of this.kv.list<Delivery>({ prefix: ["room_delivery", roomId] })) {
      if (e.value.status === "pending") out.push(e.value);
    }
    return out;
  }

  async isIdle(roomId: string): Promise<boolean> {
    return (await this.pendingDeliveries(roomId)).length === 0;
  }

  async atTurnCap(roomId: string): Promise<boolean> {
    const room = await this.getRoom(roomId);
    return !!room && room.turnCount >= room.maxTurns;
  }

  // Resolve every pending delivery (any room) whose deadline has passed.
  async sweepExpired(): Promise<Delivery[]> {
    const now = this.now();
    const swept: Delivery[] = [];
    for await (const e of this.kv.list<Delivery>({ prefix: ["room_delivery"] })) {
      const d = e.value;
      if (d.status === "pending" && d.deadline <= now) {
        d.status = "resolved";
        await this.kv.set(e.key, d);
        swept.push(d);
      }
    }
    return swept;
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) return;
      room.status = "closed";
      await this.#setRoom(room);
    });
  }

  // Mark a member inactive. Returns true if fewer than 2 active members remain
  // (the caller closes the room in that case).
  async deactivateMember(roomId: string, name: string): Promise<boolean> {
    return await this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) return false;
      const m = room.members.find((x) => x.name === name);
      if (m) m.active = false;
      await this.#setRoom(room);
      return room.members.filter((x) => x.active).length < 2;
    });
  }
```

Add `Delivery` to the import at the top of `store.ts`:
```typescript
import type { Delivery, Member, RoomRecord, TranscriptMessage } from "./types.ts";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `deno test --unstable-kv --allow-read tests/rooms/store.test.ts`
Expected: `ok | 7 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/rooms/store.ts tests/rooms/store.test.ts
git commit -m "feat(rooms): RoomStore deliveries, idle, backstop, leave, sweep"
```

---

## Task 4: RoomBrokerClient

**Files:**
- Create: `src/rooms/client.ts`
- Test: `tests/rooms/client.test.ts`

- [ ] **Step 1: Write the failing test (stubbed fetch)**

Create `tests/rooms/client.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { RoomBrokerClient } from "../../src/rooms/client.ts";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const orig = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  globalThis.fetch = ((input: any, init: any) =>
    Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
  return () => { globalThis.fetch = orig; };
}

Deno.test("createRoom POSTs and returns roomId", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const restore = stubFetch((url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ roomId: "r1", unresolved: [] }), { status: 200 });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  const res = await client.createRoom({
    title: "t", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1",
  });
  restore();
  assertEquals(res.roomId, "r1");
  assertEquals(calls[0].url, "http://broker/rooms");
  assertEquals((calls[0].body as { title: string }).title, "t");
});

Deno.test("post sends from/text/to/turnId", async () => {
  let captured: unknown;
  const restore = stubFetch((_url, init) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ seq: 3 }), { status: 200 });
  });
  const client = new RoomBrokerClient("http://broker", "tok");
  const res = await client.post("r1", { from: "Bex", text: "hi", to: ["Alvy"], turnId: "T1" });
  restore();
  assertEquals(res.seq, 3);
  assertEquals(captured, { from: "Bex", text: "hi", to: ["Alvy"], turnId: "T1" });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --allow-net tests/rooms/client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/rooms/client.ts`**

```typescript
import type { PostInput, RoomRecord, TranscriptMessage } from "./types.ts";

export type CreateRoomBody = {
  title: string;
  members: string[];          // agent names; broker resolves inbox URLs
  createdBy: string;
  sessionId: string;
  maxTurns?: number;
  humanMembers?: Array<{ name: string; inboxUrl: string }>;  // REPL supplies its own URL
};

export class RoomBrokerClient {
  constructor(private baseUrl: string, private token: string) {}

  #headers(): Record<string, string> {
    return { "content-type": "application/json", "authorization": `Bearer ${this.token}` };
  }

  async createRoom(body: CreateRoomBody): Promise<{ roomId: string; unresolved: string[] }> {
    const res = await fetch(`${this.baseUrl}/rooms`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`createRoom failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }

  async post(roomId: string, body: PostInput): Promise<{ seq: number }> {
    const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/post`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`post failed: ${res.status} ${await res.text()}`);
    return await res.json();
  }

  async ack(roomId: string, body: { from: string; turnId: string }): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/ack`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify(body),
    });
    await res.body?.cancel();
  }

  async invite(roomId: string, agent: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify({ agent }),
    });
    if (!res.ok) throw new Error(`invite failed: ${res.status}`);
    await res.body?.cancel();
  }

  async leave(roomId: string, agent: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/leave`, {
      method: "POST", headers: this.#headers(), body: JSON.stringify({ agent }),
    });
    await res.body?.cancel();
  }

  async get(roomId: string): Promise<{ room: RoomRecord; transcript: TranscriptMessage[] } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/rooms/${encodeURIComponent(roomId)}`, {
        headers: this.#headers(),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  async listByMember(name: string): Promise<RoomRecord[]> {
    try {
      const res = await fetch(`${this.baseUrl}/rooms?member=${encodeURIComponent(name)}`, {
        headers: this.#headers(),
      });
      if (!res.ok) return [];
      return await res.json();
    } catch { return []; }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --allow-net tests/rooms/client.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/rooms/client.ts tests/rooms/client.test.ts
git commit -m "feat(rooms): RoomBrokerClient HTTP wrapper"
```

---

## Task 5: Room Broker server (push + events)

**Files:**
- Create: `src/rooms/server.ts`
- Test: `tests/rooms/server.test.ts`

The server takes injectable `push` (delivery transport) and `emit` (monitor) so tests stay offline. It resolves agent inbox URLs via a `resolveInbox(name)` callback (the registry in production; a map in tests).

- [ ] **Step 1: Write the failing test**

Create `tests/rooms/server.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { startRoomBroker } from "../../src/rooms/server.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import type { InboxDelivery } from "../../src/rooms/types.ts";

async function harness() {
  const kv = await Deno.openKv(":memory:");
  const pushed: InboxDelivery[] = [];
  const events: EmitEvent[] = [];
  const inboxes: Record<string, string> = { Alvy: "http://alvy", Bex: "http://bex" };
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (name) => Promise.resolve(inboxes[name] ?? null),
    push: (_url, d) => { pushed.push(d); return Promise.resolve(true); },
    emit: (e) => { events.push(e); return Promise.resolve(); },
    agentDeadlineMs: 1000, humanDeadlineMs: 1000, defaultMaxTurns: 24,
  });
  const base = broker.url;
  const h = { "content-type": "application/json", "authorization": "Bearer tok" };
  return { kv, broker, base, h, pushed, events };
}

Deno.test("create + post pushes a delivery to the addressed member and emits events", async () => {
  const { kv, broker, base, h, pushed, events } = await harness();
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "debate", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1" }),
  })).json();
  const roomId = created.roomId;

  const posted = await (await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h,
    body: JSON.stringify({ from: "Alvy", text: "opening", to: ["Bex"] }),
  })).json();

  assertEquals(posted.seq, 0);
  assertEquals(pushed.length, 1);
  assertEquals(pushed[0].addressedBy, "Alvy");
  assertEquals(pushed[0].transcript.at(-1)?.text, "opening");
  assertEquals(events.some((e) => e.type === "room.created"), true);
  assertEquals(events.some((e) => e.type === "room.post"), true);
  await broker.shutdown(); kv.close();
});

Deno.test("post past maxTurns is rejected and emits room.capped", async () => {
  const { kv, broker, base, h, events } = await harness();
  const created = await (await fetch(`${base}/rooms`, {
    method: "POST", headers: h,
    body: JSON.stringify({ title: "t", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1", maxTurns: 1 }),
  })).json();
  const roomId = created.roomId;
  await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Alvy", text: "1", to: ["Bex"] }),
  });
  const second = await fetch(`${base}/rooms/${roomId}/post`, {
    method: "POST", headers: h, body: JSON.stringify({ from: "Bex", text: "2", to: ["Alvy"] }),
  });
  assertEquals(second.status, 429);
  await second.body?.cancel();
  assertEquals(events.some((e) => e.type === "room.capped"), true);
  await broker.shutdown(); kv.close();
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test --unstable-kv --allow-net --allow-read tests/rooms/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/rooms/server.ts`**

```typescript
import { Hono } from "hono";
import { RoomStore } from "./store.ts";
import type { InboxDelivery } from "./types.ts";
import type { EmitEvent } from "../observability/events.ts";

export type PushFn = (inboxUrl: string, delivery: InboxDelivery) => Promise<boolean>;
export type EmitFn = (event: EmitEvent) => Promise<void>;

export type RoomBrokerConfig = {
  kv: Deno.Kv;
  port: number;
  token: string;                                  // "" disables auth
  resolveInbox: (name: string) => Promise<string | null>;
  push?: PushFn;                                  // default: fetch POST {url}/inbox
  emit?: EmitFn;                                  // default: no-op
  agentDeadlineMs: number;
  humanDeadlineMs: number;
  defaultMaxTurns: number;
  sweepIntervalMs?: number;                       // default 30s; 0 disables timer
  now?: () => number;
};

export type RoomBrokerHandle = { port: number; url: string; shutdown(): Promise<void> };

const defaultPush: PushFn = async (url, delivery) => {
  try {
    const res = await fetch(`${url}/inbox`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(delivery),
    });
    const ok = res.status === 202 || res.ok;
    await res.body?.cancel();
    return ok;
  } catch { return false; }
};

export function startRoomBroker(cfg: RoomBrokerConfig): Promise<RoomBrokerHandle> {
  const now = cfg.now ?? (() => Date.now());
  const store = new RoomStore(cfg.kv, now);
  const push = cfg.push ?? defaultPush;
  const emit: EmitFn = cfg.emit ?? (() => Promise.resolve());
  const app = new Hono();

  const auth = (c: { req: { header: (k: string) => string | undefined } }) =>
    !cfg.token || c.req.header("authorization") === `Bearer ${cfg.token}`;

  // Emit a room.* event with the room's session + requestId == roomId.
  const ev = (
    sessionId: string, roomId: string, agent: string,
    type: EmitEvent["type"], data: Record<string, unknown>,
  ) => void emit({
    sessionId, requestId: roomId, agent, depth: 0, ts: now(), roomId, type, data,
  });

  // Deliver `from`'s freshly-appended post to each addressed active member.
  async function fanOut(roomId: string, from: string, to: string[]): Promise<void> {
    const room = await store.getRoom(roomId);
    if (!room) return;
    const transcript = await store.getTranscript(roomId);
    const activeNames = new Set(room.members.filter((m) => m.active).map((m) => m.name));
    const expand = to.includes("*")
      ? [...activeNames].filter((n) => n !== from)
      : to.filter((n) => n !== from && activeNames.has(n));
    for (const name of expand) {
      const member = room.members.find((m) => m.name === name)!;
      const ttl = member.kind === "human" ? cfg.humanDeadlineMs : cfg.agentDeadlineMs;
      const delivery = await store.createDelivery(roomId, name, from, ttl);
      const payload: InboxDelivery = {
        roomId, turnId: delivery.turnId, addressedBy: from,
        title: room.title, members: [...activeNames], transcript,
      };
      const ok = await push(member.inboxUrl, payload);
      if (!ok) {
        await store.resolveDelivery(roomId, delivery.turnId);
        ev(room.sessionId, roomId, "room-broker", "room.delivery_failed",
          { turnId: delivery.turnId, member: name });
      }
    }
    if (await store.isIdle(roomId)) {
      ev(room.sessionId, roomId, "room-broker", "room.idle", {});
    }
  }

  app.post("/rooms", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await c.req.json();
    const unresolved: string[] = [];
    const members: Array<{ name: string; inboxUrl: string; kind: "agent" | "human" }> = [];
    for (const name of (body.members ?? []) as string[]) {
      const url = await cfg.resolveInbox(name);
      if (!url) { unresolved.push(name); continue; }
      members.push({ name, inboxUrl: url, kind: "agent" });
    }
    for (const hm of (body.humanMembers ?? []) as Array<{ name: string; inboxUrl: string }>) {
      members.push({ name: hm.name, inboxUrl: hm.inboxUrl, kind: "human" });
    }
    const room = await store.createRoom({
      title: String(body.title ?? "room"), createdBy: String(body.createdBy ?? "?"),
      sessionId: String(body.sessionId ?? ""), maxTurns: Number(body.maxTurns ?? cfg.defaultMaxTurns),
      members,
    });
    ev(room.sessionId, room.roomId, room.createdBy, "room.created",
      { title: room.title, members: members.map((m) => m.name), maxTurns: room.maxTurns });
    return c.json({ roomId: room.roomId, unresolved });
  });

  app.post("/rooms/:id/post", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const body = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room || room.status !== "open") return c.json({ error: "unknown or closed room" }, 404);
    if (!room.members.some((m) => m.name === body.from)) return c.json({ error: "not a member" }, 403);

    if (await store.atTurnCap(roomId)) {
      ev(room.sessionId, roomId, "room-broker", "room.capped", { turnCount: room.turnCount });
      return c.json({ error: "room at turn cap" }, 429);
    }

    const to: string[] = Array.isArray(body.to) ? body.to : [];
    const msg = await store.appendMessage(roomId, { from: body.from, to, text: String(body.text ?? "") });
    if (typeof body.turnId === "string") await store.resolveDelivery(roomId, body.turnId);
    ev(room.sessionId, roomId, body.from, "room.post", { from: body.from, to, seq: msg.seq, text: msg.text });
    await fanOut(roomId, body.from, to);
    return c.json({ seq: msg.seq });
  });

  app.post("/rooms/:id/ack", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const body = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    await store.resolveDelivery(roomId, String(body.turnId));
    ev(room.sessionId, roomId, String(body.from ?? "?"), "room.ack", { turnId: body.turnId });
    if (await store.isIdle(roomId)) ev(room.sessionId, roomId, "room-broker", "room.idle", {});
    return c.json({ ok: true });
  });

  app.post("/rooms/:id/invite", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const { agent } = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    const url = await cfg.resolveInbox(agent);
    if (!url) return c.json({ error: `cannot resolve ${agent}` }, 400);
    await store.addMember(roomId, { name: agent, inboxUrl: url, kind: "agent" });
    ev(room.sessionId, roomId, agent, "room.invited", { agent });
    return c.json({ ok: true });
  });

  app.post("/rooms/:id/leave", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const { agent } = await c.req.json();
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    const shouldClose = await store.deactivateMember(roomId, agent);
    ev(room.sessionId, roomId, agent, "room.left", { agent });
    if (shouldClose) {
      await store.closeRoom(roomId);
      ev(room.sessionId, roomId, "room-broker", "room.closed", {});
    }
    return c.json({ ok: true });
  });

  app.get("/rooms/:id", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const roomId = c.req.param("id");
    const room = await store.getRoom(roomId);
    if (!room) return c.json({ error: "unknown room" }, 404);
    return c.json({ room, transcript: await store.getTranscript(roomId) });
  });

  app.get("/rooms", async (c) => {
    if (!auth(c)) return c.json({ error: "unauthorized" }, 401);
    const member = c.req.query("member");
    if (!member) return c.json([]);
    return c.json(await store.listRoomsByMember(member));
  });

  const server = Deno.serve({ port: cfg.port, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;

  // Periodic sweep: resolve overdue deliveries so a dead member can't wedge a room.
  const intervalMs = cfg.sweepIntervalMs ?? 30_000;
  let timer: number | undefined;
  if (intervalMs > 0) {
    timer = setInterval(async () => {
      for (const d of await store.sweepExpired()) {
        const room = await store.getRoom(d.roomId);
        ev(room?.sessionId ?? "", d.roomId, "room-broker", "room.turn_timeout",
          { turnId: d.turnId, member: d.member });
        if (room && await store.isIdle(d.roomId)) {
          ev(room.sessionId, d.roomId, "room-broker", "room.idle", {});
        }
      }
    }, intervalMs);
  }

  return Promise.resolve({
    port, url: `http://localhost:${port}`,
    shutdown: async () => { if (timer) clearInterval(timer); await server.shutdown(); },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test --unstable-kv --allow-net --allow-read tests/rooms/server.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/rooms/server.ts tests/rooms/server.test.ts
git commit -m "feat(rooms): Room Broker HTTP server with push + monitor events"
```

---

## Task 6: Config additions

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (create if absent)

- [ ] **Step 1: Add fields to `AppConfig` and `loadConfig`**

In `src/config.ts`, add to the `AppConfig` type:
```typescript
  roomBrokerPort: number;
  roomMaxTurns: number;
  agentDeadlineMs: number;
  humanDeadlineMs: number;
```

In `loadConfig`'s returned object, add:
```typescript
    roomBrokerPort: Number(env.ROOM_BROKER_PORT ?? 7892),
    roomMaxTurns: Number(env.A2A_ROOM_MAX_TURNS ?? 24),
    agentDeadlineMs: Number(env.A2A_ROOM_AGENT_DEADLINE_MS ?? 120_000),
    humanDeadlineMs: Number(env.A2A_ROOM_HUMAN_DEADLINE_MS ?? 3_600_000),
```

- [ ] **Step 2: Write the test**

Create `tests/config.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { loadConfig } from "../src/config.ts";

Deno.test("loadConfig provides room defaults", async () => {
  const cfg = await loadConfig();
  assertEquals(cfg.roomBrokerPort, 7892);
  assertEquals(cfg.roomMaxTurns, 24);
  assertEquals(cfg.agentDeadlineMs, 120_000);
  assertEquals(cfg.humanDeadlineMs, 3_600_000);
});
```

- [ ] **Step 3: Run the test**

Run: `deno test --env-file=.env.example --allow-env --allow-read tests/config.test.ts`
Expected: `ok | 1 passed | 0 failed`. (Assumes `.env.example` does not override these; if it does, the test reflects those values — adjust the expectation to match `.env.example`.)

- [ ] **Step 4: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(rooms): room broker config (port, maxTurns, deadlines)"
```

---

## Task 7: Agent inbox endpoint + serialized queue

**Files:**
- Create: `src/agent/inbox.ts`
- Modify: `src/agent/base.ts`
- Test: `tests/agent/inbox.test.ts`

- [ ] **Step 1: Write the failing test for the queue**

Create `tests/agent/inbox.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { InboxQueue } from "../../src/agent/inbox.ts";

Deno.test("InboxQueue processes deliveries one at a time, in order", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const q = new InboxQueue(async (d: { id: string }) => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 10));
    order.push(d.id);
    active--;
  });
  q.enqueue({ id: "a" });
  q.enqueue({ id: "b" });
  q.enqueue({ id: "c" });
  await q.drain();
  assertEquals(order, ["a", "b", "c"]);
  assertEquals(maxActive, 1); // never concurrent
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `deno test tests/agent/inbox.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/inbox.ts`**

```typescript
// A serialised FIFO. enqueue() returns immediately; a single consumer drains
// the queue one item at a time so an agent never runs two room-turns at once.
export class InboxQueue<T> {
  #queue: T[] = [];
  #running = false;
  #idle: Promise<void> = Promise.resolve();
  #resolveIdle: (() => void) | null = null;

  constructor(private process: (item: T) => Promise<void>) {}

  enqueue(item: T): void {
    this.#queue.push(item);
    if (!this.#running) {
      this.#idle = new Promise((res) => { this.#resolveIdle = res; });
      this.#running = true;
      void this.#loop();
    }
  }

  async #loop(): Promise<void> {
    while (this.#queue.length) {
      const item = this.#queue.shift()!;
      try { await this.process(item); } catch { /* a wedged turn must not kill the loop */ }
    }
    this.#running = false;
    this.#resolveIdle?.();
    this.#resolveIdle = null;
  }

  // Resolves when the queue has fully drained (for tests/shutdown).
  drain(): Promise<void> {
    return this.#running ? this.#idle : Promise.resolve();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno test tests/agent/inbox.test.ts`
Expected: `ok | 1 passed | 0 failed`.

- [ ] **Step 5: Add the `/inbox` endpoint to `base.ts`**

In `src/agent/base.ts`, add to `AgentConfig`:
```typescript
  // Called once per inbox delivery, serialised. When omitted, /inbox returns 501.
  onInbox?: (delivery: import("../rooms/types.ts").InboxDelivery) => Promise<void>;
```

After the `app.post("/message/stream", ...)` handler and before `Deno.serve`, add:
```typescript
  const inbox = cfg.onInbox
    ? new (await import("./inbox.ts")).InboxQueue(cfg.onInbox)
    : null;

  app.post("/inbox", async (c) => {
    const authz = c.req.header("authorization") ?? "";
    if (authz !== `Bearer ${cfg.bearerToken}`) return c.json({ error: "unauthorized" }, 401);
    if (!inbox) return c.json({ error: "agent has no inbox" }, 501);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    inbox.enqueue(body as import("../rooms/types.ts").InboxDelivery);
    return c.json({ ok: true }, 202);
  });
```

Note: `startAgent` is already `async`, so the top-level `await import(...)` is fine. Alternatively add a static `import { InboxQueue } from "./inbox.ts";` at the top — inbox.ts has no heavy deps, so a static import is preferred. Use:
```typescript
import { InboxQueue } from "./inbox.ts";
```
and `const inbox = cfg.onInbox ? new InboxQueue(cfg.onInbox) : null;`.

- [ ] **Step 6: Write an endpoint test**

Append to `tests/agent/inbox.test.ts`:
```typescript
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "T", description: "", version: "1.0.0", url: "http://localhost:0",
  skills: [], securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
};

Deno.test("POST /inbox returns 202 and invokes onInbox", async () => {
  const seen: string[] = [];
  const handle = await startAgent({
    card, bearerToken: "tok",
    handler: () => Promise.resolve({ text: "" }),
    // deno-lint-ignore require-yield
    streamHandler: async function* () { return; },
    onInbox: (d) => { seen.push(d.roomId); return Promise.resolve(); },
  });
  const res = await fetch(`http://localhost:${handle.port}/inbox`, {
    method: "POST", headers: { "content-type": "application/json", "authorization": "Bearer tok" },
    body: JSON.stringify({ roomId: "r1", turnId: "T1", addressedBy: "x", title: "t", members: [], transcript: [] }),
  });
  await res.body?.cancel();
  assertEquals(res.status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(seen, ["r1"]);
  await handle.shutdown();
});
```

- [ ] **Step 7: Run the tests**

Run: `deno test --allow-net tests/agent/inbox.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 8: Commit**

```bash
git add src/agent/inbox.ts src/agent/base.ts tests/agent/inbox.test.ts
git commit -m "feat(rooms): agent /inbox endpoint backed by a serialized queue"
```

---

## Task 8: Room tools + ROOMS_SUFFIX + dispatch

**Files:**
- Modify: `src/agent/tools.ts`
- Test: `tests/agent/room-tools.test.ts`

- [ ] **Step 1: Extend `ToolDeps` and add room tool definitions**

In `src/agent/tools.ts`, add to `ToolDeps`:
```typescript
  // When set, room tools (create_room/post/invite/leave/list_rooms/room_history)
  // are exposed and backed by this broker client.
  rooms?: import("../rooms/client.ts").RoomBrokerClient;
  // Mutable per-agent holder; the inbox consumer sets `active` before a room-turn
  // so the `post` tool can attach the right turnId. Safe due to serialised inbox.
  roomTurn?: import("../rooms/types.ts").RoomTurnState;
```

Add a `ROOM_TOOLS: BaseTool[]` array (after `SPAWN_TOOLS`):
```typescript
const ROOM_TOOLS: BaseTool[] = [
  {
    name: "create_room",
    description:
      "Create a multi-party conversation room and add members by name. Returns { roomId }. Use a room for an open-ended exchange (debate, brainstorm, collaboration) — not for a task you need a single result back from (use delegate_* for that).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short room title" },
        members: { type: "array", items: { type: "string" }, description: "Agent names to add (besides you)" },
        maxTurns: { type: "number", description: "Optional hard cap on total posts (default 24)" },
      },
      required: ["title", "members"],
    },
  },
  {
    name: "post",
    description:
      "Post a message to a room, addressing specific members. `to` lists the member names that should respond; use [] to address no one (lets the conversation wind down) or [\"*\"] for everyone. Only addressed members are woken to reply.",
    parameters: {
      type: "object",
      properties: {
        roomId: { type: "string" },
        text: { type: "string", description: "What to say" },
        to: { type: "array", items: { type: "string" }, description: "Member names to address" },
      },
      required: ["roomId", "text", "to"],
    },
  },
  {
    name: "invite",
    description: "Invite another agent into an existing room by name.",
    parameters: {
      type: "object",
      properties: { roomId: { type: "string" }, agent: { type: "string" } },
      required: ["roomId", "agent"],
    },
  },
  {
    name: "leave",
    description: "Leave a room when you're done participating.",
    parameters: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] },
  },
  {
    name: "list_rooms",
    description: "List rooms you are a member of. Returns roomId, title, and members for each.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "room_history",
    description: "Fetch the full transcript of a room you belong to.",
    parameters: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] },
  },
];
```

Add the suffix constant (after `SPAWN_SUFFIX`):
```typescript
export const ROOMS_SUFFIX = `

You can also hold open-ended, multi-party conversations in "rooms" — distinct from
delegation. Use the rule: need a value back from a task → delegate_*; want an
open-ended exchange (debate, brainstorm, collaborate, or just talk with peers) → a room.

Room tools:
- create_room(title, members[], maxTurns?): start a room and add members; returns { roomId }.
- post(roomId, text, to[]): say something, addressing the member names in `to`. Only addressed members reply. Use to:[] to let it wind down, to:["*"] for everyone.
- invite(roomId, agent): add another agent.
- leave(roomId): exit when done.
- list_rooms() / room_history(roomId): see your rooms / a transcript.

When you are addressed in a room, just reply naturally — your reply is sent to whoever addressed you. Call post() explicitly only when you want to address someone specific, address everyone, or end the exchange.`;
```

Update `getTools` to append room tools when present:
```typescript
export function getTools(deps: ToolDeps): BaseTool[] {
  const tools = deps.spawnAgent ? [...BASE_TOOLS, ...SPAWN_TOOLS] : [...BASE_TOOLS];
  if (deps.rooms) tools.push(...ROOM_TOOLS);
  if (deps.search) tools.push(WEB_SEARCH_TOOL);
  return tools;
}
```

Update `buildSystemSuffix`:
```typescript
export function buildSystemSuffix(deps: ToolDeps): string {
  let s = deps.spawnAgent ? DELEGATION_SUFFIX + SPAWN_SUFFIX : DELEGATION_SUFFIX;
  if (deps.rooms) s += ROOMS_SUFFIX;
  return s;
}
```

- [ ] **Step 2: Add room dispatch + emit-exclusion**

In `runTool`, extend the emit-exclusion list so room tools don't double-emit (the broker emits `room.*`):
```typescript
  const roomToolNames = ["create_room", "post", "invite", "leave"];
  const skipEmit = ["delegate_start", "delegate_continue", "spawn_agent", ...roomToolNames];
  if (!skipEmit.includes(name)) {
    // ...existing emit...
  }
```
(Replace the existing `if (name !== "delegate_start" && ...)` condition with `if (!skipEmit.includes(name))`.)

In `dispatchTool`, before the final `return JSON.stringify({ error: ... unknown tool })`, add the room handlers:
```typescript
    if (name === "create_room") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const res = await deps.rooms.createRoom({
        title: String(args.title ?? "room"),
        members: Array.isArray(args.members) ? (args.members as string[]) : [],
        createdBy: deps.selfName,
        sessionId: ids.sessionId,
        maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
      });
      return JSON.stringify(res);
    }

    if (name === "post") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const roomId = String(args.roomId);
      const to = Array.isArray(args.to) ? (args.to as string[]) : [];
      const active = deps.roomTurn?.active;
      // First matching post of this turn carries the turnId (resolving the delivery);
      // any later post is treated as originating (no turnId).
      let turnId: string | undefined;
      if (active && active.roomId === roomId) {
        if (!active.posted) turnId = active.turnId;
        active.posted = true;
      }
      const res = await deps.rooms.post(roomId, {
        from: deps.selfName, text: String(args.text ?? ""), to, turnId,
      });
      return JSON.stringify(res);
    }

    if (name === "invite") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      await deps.rooms.invite(String(args.roomId), String(args.agent));
      return JSON.stringify({ ok: true });
    }

    if (name === "leave") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      await deps.rooms.leave(String(args.roomId), deps.selfName);
      return JSON.stringify({ ok: true });
    }

    if (name === "list_rooms") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const rooms = await deps.rooms.listByMember(deps.selfName);
      return JSON.stringify(rooms.map((r) => ({
        roomId: r.roomId, title: r.title, members: r.members.filter((m) => m.active).map((m) => m.name),
      })));
    }

    if (name === "room_history") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const res = await deps.rooms.get(String(args.roomId));
      if (!res) return JSON.stringify({ error: "unknown room" });
      return JSON.stringify(res.transcript.map((m) => ({ from: m.from, to: m.to, text: m.text })));
    }
```

- [ ] **Step 3: Write the test**

Create `tests/agent/room-tools.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { getTools, runTool, type ToolDeps } from "../../src/agent/tools.ts";
import type { RoomTurnState } from "../../src/rooms/types.ts";

function depsWithRooms(postSpy: (roomId: string, body: unknown) => void): ToolDeps {
  const roomTurn: RoomTurnState = { active: { roomId: "r1", turnId: "T1", addressedBy: "Alvy", posted: false } };
  return {
    store: {} as never, threads: {} as never, registry: {} as never,
    bearerToken: "t", selfName: "Bex", roomTurn,
    // minimal RoomBrokerClient stub
    rooms: {
      post: (roomId: string, body: unknown) => { postSpy(roomId, body); return Promise.resolve({ seq: 0 }); },
      createRoom: () => Promise.resolve({ roomId: "r1", unresolved: [] }),
      ack: () => Promise.resolve(), invite: () => Promise.resolve(), leave: () => Promise.resolve(),
      get: () => Promise.resolve(null), listByMember: () => Promise.resolve([]),
    } as never,
  };
}

Deno.test("room tools are exposed when a broker client is present", () => {
  const names = getTools(depsWithRooms(() => {})).map((t) => t.name);
  for (const n of ["create_room", "post", "invite", "leave", "list_rooms", "room_history"]) {
    assertEquals(names.includes(n), true, `missing ${n}`);
  }
});

Deno.test("post attaches the active turnId on the first call and marks posted", async () => {
  let captured: { roomId: string; body: { turnId?: string } } | null = null;
  const deps = depsWithRooms((roomId, body) => { captured = { roomId, body: body as { turnId?: string } }; });
  await runTool(deps, "post", { roomId: "r1", text: "hi", to: ["Alvy"] }, 0, "ctx", { sessionId: "s1", requestId: "r1" });
  assertEquals(captured!.body.turnId, "T1");
  assertEquals(deps.roomTurn!.active!.posted, true);
});
```

- [ ] **Step 4: Run the test**

Run: `deno test --allow-read tests/agent/room-tools.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/room-tools.test.ts
git commit -m "feat(rooms): room tools, ROOMS_SUFFIX, turnId-threaded post dispatch"
```

---

## Task 9: Room-turn processor + handler wiring

**Files:**
- Create: `src/agent/room-turn.ts`
- Modify: `src/agent/handlers.ts`, `src/agent/ollama.ts`, `src/agent/claude.ts`, `src/agent-entry.ts`
- Test: `tests/agent/room-turn.test.ts`

- [ ] **Step 1: Thread `rooms`/`roomTurn` through `buildHandlers`**

In `src/agent/handlers.ts`, add to `BuildHandlersDeps`:
```typescript
  rooms?: import("../rooms/client.ts").RoomBrokerClient;
  roomTurn?: import("../rooms/types.ts").RoomTurnState;
```

Pass them into the ollama and claude tool deps. In the `claude` branch's `makeClaudeHandlers({...})` add `rooms: d.rooms, roomTurn: d.roomTurn,`. In the ollama branch's `tools: preset.toolCapable ? { ... }` object add `rooms: d.rooms, roomTurn: d.roomTurn,`. (claude-code: leave a `// TODO(plan-3): expose room tools to claude-code MCP surface` note — claude-code room turns are out of scope for the persona use case.)

In `src/agent/ollama.ts` (`OllamaDeps.tools` is already a `ToolDeps`, so it flows through — no change needed beyond confirming `rooms`/`roomTurn` are part of `ToolDeps`, which Task 8 added).

In `src/agent/claude.ts`, confirm its handler deps spread into a `ToolDeps`; if it constructs a `ToolDeps` literal, add `rooms`, `roomTurn` to it. (Match the existing field-passing style.)

- [ ] **Step 2: Write `src/agent/room-turn.ts`**

```typescript
// Builds the processor for a single inbox delivery. Reuses the agent's normal
// (non-streaming) handler by synthesizing a "transcript + instruction" user
// message; the post tool (Task 8) turns the model's reply into a broker post.
// If the model replies in prose without calling post(), we wrap that prose as a
// reply to whoever addressed it; if it says nothing, we ack so the room can idle.
import type { AgentHandlerCtx } from "./base.ts";
import type { ContextStore } from "../store/context.ts";
import type { RoomBrokerClient } from "../rooms/client.ts";
import type { InboxDelivery, RoomTurnState } from "../rooms/types.ts";

export type RoomTurnDeps = {
  selfName: string;
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  rooms: RoomBrokerClient;
  roomTurn: RoomTurnState;       // the SAME object wired into ToolDeps
  store: ContextStore;
};

export function renderRoomTurn(d: InboxDelivery, selfName: string): string {
  const lines = d.transcript.map((m) =>
    `[${m.from}${m.to.length ? " → " + m.to.join(", ") : ""}]: ${m.text}`,
  ).join("\n");
  return [
    `You are "${selfName}" in the room "${d.title}". Members: ${d.members.join(", ")}.`,
    ``,
    `Transcript so far:`,
    lines || "(empty)",
    ``,
    `${d.addressedBy} just addressed you (roomId="${d.roomId}"). Reply naturally to continue the conversation. ` +
    `To address someone specific or everyone, or to end the exchange, call post(roomId, text, to). ` +
    `If you have nothing to add, say nothing.`,
  ].join("\n");
}

export function makeRoomTurnProcessor(deps: RoomTurnDeps) {
  return async function processDelivery(d: InboxDelivery): Promise<void> {
    deps.roomTurn.active = { roomId: d.roomId, turnId: d.turnId, addressedBy: d.addressedBy, posted: false };
    const contextId = crypto.randomUUID(); // ephemeral; the transcript IS the context
    try {
      const ctx: AgentHandlerCtx = {
        depth: 0,
        sessionId: "", // room events are emitted by the broker; agent turn events optional
        requestId: d.roomId,
        message: {
          messageId: crypto.randomUUID(), role: "user",
          parts: [{ type: "text", text: renderRoomTurn(d, deps.selfName) }],
          contextId,
        },
      };
      const res = await deps.handler(ctx);
      if (!deps.roomTurn.active.posted) {
        const text = (res.text ?? "").trim();
        if (text) await deps.rooms.post(d.roomId, { from: deps.selfName, text, to: [d.addressedBy], turnId: d.turnId });
        else await deps.rooms.ack(d.roomId, { from: deps.selfName, turnId: d.turnId });
      }
    } catch {
      // Never leave a delivery pending — resolve it so the room can idle/recover.
      try { await deps.rooms.ack(d.roomId, { from: deps.selfName, turnId: d.turnId }); } catch { /* ignore */ }
    } finally {
      deps.roomTurn.active = null;
      await deps.store.clear(contextId); // drop the throwaway context
    }
  };
}
```

- [ ] **Step 3: Write the test**

Create `tests/agent/room-turn.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { makeRoomTurnProcessor } from "../../src/agent/room-turn.ts";
import type { RoomTurnState, InboxDelivery } from "../../src/rooms/types.ts";

function delivery(): InboxDelivery {
  return {
    roomId: "r1", turnId: "T1", addressedBy: "Alvy", title: "t", members: ["Alvy", "Bex"],
    transcript: [{ seq: 0, roomId: "r1", from: "Alvy", to: ["Bex"], text: "hi", ts: 1 }],
  };
}
const store = { clear: () => Promise.resolve() } as never;

Deno.test("prose reply (no post call) is wrapped as a post to the addresser", async () => {
  const calls: Array<{ kind: string; body: unknown }> = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => Promise.resolve({ text: "a fair point, Alvy" }),
    rooms: {
      post: (_r, b) => { calls.push({ kind: "post", body: b }); return Promise.resolve({ seq: 1 }); },
      ack: (_r, b) => { calls.push({ kind: "ack", body: b }); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls.length, 1);
  assertEquals(calls[0].kind, "post");
  assertEquals((calls[0].body as { to: string[] }).to, ["Alvy"]);
  assertEquals((calls[0].body as { turnId: string }).turnId, "T1");
});

Deno.test("empty reply acks the delivery", async () => {
  const calls: string[] = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => Promise.resolve({ text: "   " }),
    rooms: {
      post: () => { calls.push("post"); return Promise.resolve({ seq: 1 }); },
      ack: () => { calls.push("ack"); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls, ["ack"]);
});

Deno.test("when the handler already posted, no wrap/ack happens", async () => {
  const calls: string[] = [];
  const roomTurn: RoomTurnState = { active: null };
  const proc = makeRoomTurnProcessor({
    selfName: "Bex",
    handler: () => { roomTurn.active!.posted = true; return Promise.resolve({ text: "" }); },
    rooms: {
      post: () => { calls.push("post"); return Promise.resolve({ seq: 1 }); },
      ack: () => { calls.push("ack"); return Promise.resolve(); },
    } as never,
    roomTurn, store,
  });
  await proc(delivery());
  assertEquals(calls, []);
});
```

- [ ] **Step 4: Run the test**

Run: `deno test --allow-read tests/agent/room-turn.test.ts`
Expected: `ok | 3 passed | 0 failed`.

- [ ] **Step 5: Wire the processor into `agent-entry.ts`**

In `src/agent-entry.ts`:

Add imports:
```typescript
import { RoomBrokerClient } from "./rooms/client.ts";
import { makeRoomTurnProcessor } from "./agent/room-turn.ts";
import type { RoomTurnState } from "./rooms/types.ts";
```

After `registryUrl` is resolved, add broker resolution and the shared room-turn state:
```typescript
const brokerUrl = getFlag(Deno.args, "broker") ?? Deno.env.get("ROOM_BROKER_URL");
const roomTurn: RoomTurnState = { active: null };
const rooms = brokerUrl ? new RoomBrokerClient(brokerUrl, cfg.bearerToken) : undefined;
```

Pass `rooms` and `roomTurn` into `buildHandlers({...})` (only meaningful for tool-capable backends; harmless otherwise):
```typescript
  rooms,
  roomTurn,
```

After `const handlers = await buildHandlers({...})`, build the processor and pass `onInbox` to `startAgent`:
```typescript
const onInbox = rooms
  ? makeRoomTurnProcessor({
      selfName: agentName, handler: handlers.handler, rooms, roomTurn, store,
    })
  : undefined;
```

In the `startAgent({...})` call, add:
```typescript
  onInbox,
```

- [ ] **Step 6: Typecheck the wiring**

Run: `deno check src/agent-entry.ts src/agent/handlers.ts src/agent/room-turn.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/agent/room-turn.ts src/agent/handlers.ts src/agent/ollama.ts src/agent/claude.ts src/agent-entry.ts tests/agent/room-turn.test.ts
git commit -m "feat(rooms): room-turn processor + handler/agent-entry wiring"
```

---

## Task 10: Start the broker in the orchestrator

**Files:**
- Modify: `src/orchestrator.ts`
- Test: covered by Task 11 (E2E). Add a focused wiring assertion here.

- [ ] **Step 1: Start the broker in `setupOrchestrator`**

In `src/orchestrator.ts`:

Add imports:
```typescript
import { startRoomBroker, type RoomBrokerHandle } from "./rooms/server.ts";
import { RoomBrokerClient } from "./rooms/client.ts";
import type { RoomTurnState } from "./rooms/types.ts";
import { makeRoomTurnProcessor } from "./agent/room-turn.ts";
```

After the registry + KV are created, start the broker (its own KV so its keys never collide with the agents' store):
```typescript
  const roomKv = await Deno.openKv();
  const roomBroker: RoomBrokerHandle = await startRoomBroker({
    kv: roomKv,
    port: cfg.roomBrokerPort,
    token: cfg.bearerToken,
    resolveInbox: async (name) => (await registryClient.get(name))?.url ?? null,
    emit,
    agentDeadlineMs: cfg.agentDeadlineMs,
    humanDeadlineMs: cfg.humanDeadlineMs,
    defaultMaxTurns: cfg.roomMaxTurns,
  });
  const roomBrokerUrl = `http://localhost:${roomBroker.port}`;
  console.log(`[room-broker] ${roomBrokerUrl}`);
```

- [ ] **Step 2: Pass `--broker` to spawned child agents**

In the `spawnAgent` `args` array (after the `--registry=...` entry), add:
```typescript
      `--broker=${roomBrokerUrl}`,
```

- [ ] **Step 3: Wire rooms into in-process agents**

In the `for (const spec of specs)` loop, before `buildHandlers`, create per-agent room state and pass it through; then build the processor and pass `onInbox` to `startAgent`:
```typescript
      const roomTurn: RoomTurnState = { active: null };
      const rooms = new RoomBrokerClient(roomBrokerUrl, cfg.bearerToken);
```
Add to the `buildHandlers({...})` call: `rooms, roomTurn,`.
After `const handle = await startAgent({...})` is currently built — instead, construct `onInbox` before `startAgent` and include it:
```typescript
      const onInbox = makeRoomTurnProcessor({
        selfName: spec.name, handler: handlers.handler, rooms, roomTurn, store,
      });
      const handle = await startAgent({
        card: baseCard,
        bearerToken: cfg.bearerToken,
        handler: handlers.handler,
        streamHandler: handlers.streamHandler,
        emit,
        maxDepth: resolveMaxDepth,
        onInbox,
      });
```

- [ ] **Step 4: Add broker to shutdown + `OrchestratorContext`**

In the `shutdown` function, after the registry shutdown, add:
```typescript
    try { await roomBroker.shutdown(); } catch { /* ignore */ }
    roomKv.close();
```
Add `roomBrokerUrl: string;` to the `OrchestratorContext` type, and `roomBrokerUrl,` to the returned object.

- [ ] **Step 5: Typecheck**

Run: `deno check src/orchestrator.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat(rooms): start Room Broker in setupOrchestrator; wire agents to it"
```

---

## Task 11: End-to-end integration test (real broker + stub agents)

**Files:**
- Test: `tests/rooms/e2e.test.ts`

This exercises the real broker + two real agent servers with **deterministic stub handlers** (no LLM): each stub, when addressed, replies once then stays silent, so the conversation runs a few turns and goes idle. A second test drives a non-stop ping-pong against a tiny `maxTurns` to prove the backstop fires.

- [ ] **Step 1: Write the E2E test**

Create `tests/rooms/e2e.test.ts`:
```typescript
import { assertEquals } from "@std/assert";
import { startRoomBroker } from "../../src/rooms/server.ts";
import { RoomBrokerClient } from "../../src/rooms/client.ts";
import { startAgent } from "../../src/agent/base.ts";
import { makeRoomTurnProcessor } from "../../src/agent/room-turn.ts";
import type { AgentCard } from "../../src/protocol/types.ts";
import type { RoomTurnState } from "../../src/rooms/types.ts";

function card(name: string): AgentCard {
  return {
    name, description: "", version: "1.0.0", url: "http://localhost:0", skills: [],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } }, security: [{ bearer: [] }],
  };
}

// A stub agent that posts a reply via the broker, then (optionally) stays silent.
async function stubAgent(name: string, brokerUrl: string, reply: (turn: number) => string | null) {
  const rooms = new RoomBrokerClient(brokerUrl, "tok");
  const roomTurn: RoomTurnState = { active: null };
  let turn = 0;
  const handler = async (ctx: { requestId: string }) => {
    const r = reply(turn++);
    if (r !== null) {
      // address the other member by replying to whoever addressed us
      await rooms.post(ctx.requestId, {
        from: name, text: r, to: [roomTurn.active!.addressedBy], turnId: roomTurn.active!.turnId,
      });
    }
    return { text: "" }; // we posted explicitly; nothing to wrap
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

Deno.test("two stub agents converse directly and the room goes idle", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    agentDeadlineMs: 2000, humanDeadlineMs: 2000, defaultMaxTurns: 24, sweepIntervalMs: 0,
  });

  // Alvy replies twice then goes quiet; Bex replies twice then goes quiet.
  const alvy = await stubAgent("Alvy", broker.url, (t) => (t < 2 ? `Alvy-${t}` : null));
  const bex = await stubAgent("Bex", broker.url, (t) => (t < 2 ? `Bex-${t}` : null));
  urls["Alvy"] = alvy.url; urls["Bex"] = bex.url;

  const client = new RoomBrokerClient(broker.url, "tok");
  const { roomId } = await client.createRoom({
    title: "debate", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1",
  });
  await client.post(roomId, { from: "Alvy", text: "opening", to: ["Bex"] });

  // Wait for the chain to wind down.
  for (let i = 0; i < 50; i++) {
    if ((await client.get(roomId))!.room && await isIdle(client, roomId)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const got = await client.get(roomId);
  const texts = got!.transcript.map((m) => m.text);
  // opening + Bex-0, Alvy-0, Bex-1, Alvy-1 (then both silent)
  assertEquals(texts[0], "opening");
  assertEquals(texts.includes("Bex-0"), true);
  assertEquals(texts.includes("Alvy-1"), true);

  await alvy.handle.shutdown(); await bex.handle.shutdown(); await broker.shutdown(); kv.close();
});

async function isIdle(client: RoomBrokerClient, roomId: string): Promise<boolean> {
  // No public idle endpoint; approximate by checking transcript stability across a tick.
  const a = (await client.get(roomId))!.transcript.length;
  await new Promise((r) => setTimeout(r, 40));
  const b = (await client.get(roomId))!.transcript.length;
  return a === b;
}

Deno.test("a non-stop ping-pong is bounded by maxTurns", async () => {
  const kv = await Deno.openKv(":memory:");
  const urls: Record<string, string> = {};
  const broker = await startRoomBroker({
    kv, port: 0, token: "tok",
    resolveInbox: (n) => Promise.resolve(urls[n] ?? null),
    agentDeadlineMs: 2000, humanDeadlineMs: 2000, defaultMaxTurns: 6, sweepIntervalMs: 0,
  });
  // Both always reply -> would loop forever without the backstop.
  const alvy = await stubAgent("Alvy", broker.url, () => "A");
  const bex = await stubAgent("Bex", broker.url, () => "B");
  urls["Alvy"] = alvy.url; urls["Bex"] = bex.url;

  const client = new RoomBrokerClient(broker.url, "tok");
  const { roomId } = await client.createRoom({
    title: "pingpong", members: ["Alvy", "Bex"], createdBy: "Alvy", sessionId: "s1", maxTurns: 6,
  });
  await client.post(roomId, { from: "Alvy", text: "go", to: ["Bex"] });

  await new Promise((r) => setTimeout(r, 600));
  const got = await client.get(roomId);
  // turnCount never exceeds maxTurns (6); transcript length is capped.
  assertEquals(got!.room.turnCount <= 6, true);

  await alvy.handle.shutdown(); await bex.handle.shutdown(); await broker.shutdown(); kv.close();
});
```

- [ ] **Step 2: Run the E2E test**

Run: `deno test --unstable-kv --allow-net --allow-read tests/rooms/e2e.test.ts`
Expected: `ok | 2 passed | 0 failed`.

- [ ] **Step 3: Run the whole suite**

Run: `deno task test`
Expected: all tests pass (existing + new).

- [ ] **Step 4: Commit**

```bash
git add tests/rooms/e2e.test.ts
git commit -m "test(rooms): end-to-end broker + stub agents (idle + backstop)"
```

---

## Manual verification (after Task 11)

1. `deno task monitor` (separate terminal).
2. `deno task start --agents="coordinator"`.
3. In the REPL: `@coordinator spawn two analyst agents named Alvy and Bex, then have Alvy open a room with Bex and debate whether a hotdog is a sandwich — tell Alvy to use the room tools to talk to Bex directly, not to relay through you.`
4. Confirm in the monitor that `room.created` / `room.post` events appear with a `roomId`, the posts alternate `Alvy → Bex` / `Bex → Alvy`, and the room ends via `room.idle` or `room.capped` (not a coordinator relay). (The monitor's dedicated room *view* is Plan 3; for now the events are visible in the raw event list.)

---

## Self-Review

**Spec coverage:**
- N-party rooms data model → Tasks 1–3 ✓
- @mention turn-taking (only addressed woken) → `fanOut` in Task 5 ✓
- Idle + explicit leave + backstop → Tasks 3, 5 (`isIdle`, `leave`/`deactivateMember`, `atTurnCap`/`room.capped`) ✓
- Async inbox returning 202 + serialized consumer → Task 7 ✓
- Room tools + delegate-vs-room guidance → Task 8 ✓
- turnId/ack auto-threading; prose auto-wrap → Tasks 8, 9 ✓
- Broker emits room.* with roomId, requestId=roomId → Tasks 1, 5 ✓
- Config/wiring → Tasks 6, 9, 10 ✓
- Delivery failure + timeout sweep → Task 5 (`push` failure path, `sweepExpired` + interval) ✓
- Human participation → **deferred to Plan 2** (noted in scope) ✓
- Monitor room view → **deferred to Plan 3** (noted in scope) ✓
- claude-code room tools → noted as out-of-scope for the persona use case in Task 9 ✓

**Placeholder scan:** No TBD/TODO except the explicit, intentional `TODO(plan-3)` note for claude-code MCP tool exposure. No vague "handle errors" steps — each error path has concrete code.

**Type consistency:** `InboxDelivery`, `Delivery`, `RoomTurnState`, `PostInput` defined in Task 1 and used unchanged in Tasks 5/7/8/9. `RoomBrokerClient` method names (`createRoom`, `post`, `ack`, `invite`, `leave`, `get`, `listByMember`) defined in Task 4 and used consistently in Tasks 8/9/10/11. `RoomStore` methods (`createRoom`, `appendMessage`, `getTranscript`, `createDelivery`, `resolveDelivery`, `isIdle`, `atTurnCap`, `sweepExpired`, `deactivateMember`, `closeRoom`, `addMember`, `listRoomsByMember`) defined in Tasks 2–3 and used consistently in Task 5.

**Known follow-ups (intentional, not gaps):** REPL human participation (Plan 2), monitor room view (Plan 3), claude-code room-tool exposure, transcript delta sync, delivery redelivery/retry.
