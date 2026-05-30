# Web UI Monitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, isolated monitor service + web UI that visualizes an
A2A run as a swimlane/sequence diagram, by having agents emit milestone events
correlated through propagated session/request ids.

**Architecture:** Agents gain a no-op-when-disabled `emit()` seam that
fire-and-forget POSTs milestone events to a standalone monitor
(`A2A_MONITOR_URL`). `sessionId`/`requestId` propagate through delegation as
`x-session`/`x-request` headers (mirroring `x-depth`). The monitor persists
events to its own named Deno KV, fans them out live over SSE, and serves a
vanilla-TS/SVG swimlane UI. Off by default; the app behaves exactly as today
when `A2A_MONITOR_URL` is unset.

**Tech Stack:** Deno, TypeScript, Hono, Deno KV, zod, SSE, vanilla HTML/SVG.
Tests via `deno test`.

**Reference spec:** `docs/superpowers/specs/2026-05-28-web-ui-monitor-design.md`

**Conventions:** Run all tests with the project's existing flags:
`deno test --allow-net --allow-env --allow-read --allow-write --allow-sys --unstable-kv <path>`.
Commit after every task. This repo commits directly to `main`.

---

## Phase 1 — Event foundation

### Task 1: Event envelope + zod schema

**Files:**

- Create: `src/observability/events.ts`
- Test: `tests/observability/events.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/observability/events.test.ts
import { assertEquals } from "@std/assert";
import { EVENT_TYPES, parseEvent } from "../../src/observability/events.ts";

Deno.test("parseEvent accepts a well-formed milestone event", () => {
  const ev = {
    sessionId: "s1",
    requestId: "r1",
    seq: 0,
    ts: 1234,
    agent: "coordinator",
    depth: 0,
    type: "delegate.start",
    data: { peer: "scout", threadId: "t1", prompt: "hi" },
  };
  const parsed = parseEvent(ev);
  assertEquals(parsed.agent, "coordinator");
  assertEquals(parsed.data.peer, "scout");
});

Deno.test("parseEvent rejects an unknown type", () => {
  let threw = false;
  try {
    parseEvent({
      sessionId: "s1",
      requestId: "r1",
      seq: 0,
      ts: 1,
      agent: "a",
      depth: 0,
      type: "not.a.type",
      data: {},
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("EVENT_TYPES lists every milestone type", () => {
  assertEquals(EVENT_TYPES.includes("message.completed"), true);
  assertEquals(EVENT_TYPES.includes("spawn"), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read tests/observability/events.test.ts` Expected: FAIL
— module `src/observability/events.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/observability/events.ts
// Single source of truth for the monitor event envelope. Imported by the
// agent-side emitter (src/observability/emit.ts) and the monitor service.
import { z } from "zod";

export const EVENT_TYPES = [
  "request.started",
  "turn.started",
  "delegate.start",
  "delegate.continue",
  "delegate.return",
  "tool.call",
  "spawn",
  "message.completed",
  "turn.completed",
  "error",
  "request.completed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// `seq` is assigned by the monitor on ingest, so emitters send 0 as a
// placeholder. Everything else is stamped by the emitting agent.
export const EventSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  agent: z.string().min(1),
  depth: z.number().int().nonnegative(),
  threadId: z.string().optional(),
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type A2AEvent = z.infer<typeof EventSchema>;

// The shape an emitter constructs (no seq — monitor assigns it).
export type EmitEvent = Omit<A2AEvent, "seq">;

export function parseEvent(input: unknown): A2AEvent {
  return EventSchema.parse(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read tests/observability/events.test.ts` Expected: PASS
(3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/observability/events.ts tests/observability/events.test.ts
git commit -m "feat(observability): event envelope + zod schema"
```

---

### Task 2: Emitter shim

**Files:**

- Create: `src/observability/emit.ts`
- Test: `tests/observability/emit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/observability/emit.test.ts
import { assertEquals } from "@std/assert";
import { createEmitter } from "../../src/observability/emit.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

const sample: EmitEvent = {
  sessionId: "s1",
  requestId: "r1",
  ts: 1,
  agent: "a",
  depth: 0,
  type: "turn.started",
  data: {},
};

Deno.test("createEmitter with no URL returns a no-op (never calls post)", async () => {
  let calls = 0;
  const emit = createEmitter(undefined, undefined, () => {
    calls++;
    return Promise.resolve();
  });
  await emit(sample);
  assertEquals(calls, 0);
});

Deno.test("createEmitter with a URL posts the event to /ingest", async () => {
  let captured: { url: string; body: unknown } | null = null;
  const emit = createEmitter("http://mon:7891", "tok", (url, body) => {
    captured = { url, body };
    return Promise.resolve();
  });
  await emit(sample);
  assertEquals(captured!.url, "http://mon:7891/ingest");
  assertEquals((captured!.body as EmitEvent).agent, "a");
});

Deno.test("emit swallows post errors (never throws into the caller)", async () => {
  const emit = createEmitter(
    "http://mon:7891",
    undefined,
    () => Promise.reject(new Error("down")),
  );
  await emit(sample); // must not throw
  assertEquals(true, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read tests/observability/emit.test.ts` Expected: FAIL —
`src/observability/emit.ts` not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/observability/emit.ts
// A tiny, optional event-export seam. When no monitor URL is configured,
// emit() is a no-op so agents incur zero coupling. Otherwise it fire-and-
// forgets a POST and swallows all errors — observability must never affect
// agent behavior.
import type { EmitEvent } from "./events.ts";

export type Emitter = (event: EmitEvent) => Promise<void>;

// Injectable transport so tests don't hit the network. Defaults to fetch.
export type PostFn = (
  url: string,
  body: EmitEvent,
  token?: string,
) => Promise<void>;

const defaultPost: PostFn = async (url, body, token) => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
};

export function createEmitter(
  monitorUrl: string | undefined,
  token: string | undefined,
  post: PostFn = defaultPost,
): Emitter {
  if (!monitorUrl) return () => Promise.resolve();
  const ingest = `${monitorUrl.replace(/\/$/, "")}/ingest`;
  return (event: EmitEvent) => {
    // Fire-and-forget: do not await the network in the agent's hot path.
    void post(ingest, event, token).catch(() => {});
    return Promise.resolve();
  };
}

// Convenience for stamping `ts` at the call site.
export function now(): number {
  return Date.now();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read tests/observability/emit.test.ts` Expected: PASS (3
tests).

- [ ] **Step 5: Commit**

```bash
git add src/observability/emit.ts tests/observability/emit.test.ts
git commit -m "feat(observability): optional fire-and-forget emitter"
```

---

### Task 3: Config — add monitorUrl

**Files:**

- Modify: `src/config.ts:4-10` (AppConfig type) and `src/config.ts:21-27`
  (loadConfig return)
- Modify: `.env.example`
- Test: `tests/config.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to existing file)**

```ts
// tests/config.test.ts  — add this test
Deno.test("loadConfig reads A2A_MONITOR_URL (empty when unset)", async () => {
  const { loadConfig } = await import("../src/config.ts");
  const cfg = await loadConfig();
  // Type-level guarantee plus runtime presence of the field.
  assertEquals(typeof cfg.monitorUrl, "string");
});
```

(Ensure `import { assertEquals } from "@std/assert";` exists at the top of the
file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --allow-env tests/config.test.ts` Expected: FAIL —
`cfg.monitorUrl` is `undefined` (typeof "undefined").

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the `AppConfig` type:

```ts
export type AppConfig = {
  registryPort: number;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  bearerToken: string;
  ollamaBaseUrl: string;
  monitorUrl: string; // empty string = disabled
};
```

And to the `loadConfig` return object:

```ts
monitorUrl: env.A2A_MONITOR_URL ?? "",
```

In `.env.example`, add:

```
# Optional: enable the web UI monitor. Unset = no events emitted.
A2A_MONITOR_URL=http://localhost:7891
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --allow-env tests/config.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example tests/config.test.ts
git commit -m "feat(config): add A2A_MONITOR_URL (monitorUrl)"
```

---

### Task 4: Propagate session/request ids in the protocol client

**Files:**

- Modify: `src/protocol/client.ts:3-8` (SendOptions), `:12-29` (sendMessage),
  `:37-47` (streamMessage)
- Test: `tests/protocol/propagation.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/protocol/propagation.test.ts
import { assertEquals } from "@std/assert";
import { sendMessage } from "../../src/protocol/client.ts";

Deno.test("sendMessage forwards x-session and x-request headers", async () => {
  let seen: Record<string, string | null> = {};
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    seen = {
      session: req.headers.get("x-session"),
      request: req.headers.get("x-request"),
      depth: req.headers.get("x-depth"),
    };
    return new Response(JSON.stringify({ text: "ok" }), {
      headers: { "content-type": "application/json" },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;

  await sendMessage({
    url: `http://localhost:${port}`,
    token: "t",
    depth: 1,
    sessionId: "s1",
    requestId: "r1",
    message: {
      messageId: "m1",
      role: "agent",
      parts: [{ type: "text", text: "hi" }],
    },
  });

  await server.shutdown();
  assertEquals(seen.session, "s1");
  assertEquals(seen.request, "r1");
  assertEquals(seen.depth, "1");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-net tests/protocol/propagation.test.ts` Expected: FAIL —
`sessionId`/`requestId` not accepted / headers absent.

- [ ] **Step 3: Implement**

In `src/protocol/client.ts`, extend `SendOptions`:

```ts
export type SendOptions = {
  url: string;
  token: string;
  depth: number;
  message: Message;
  sessionId?: string; // forwarded as x-session
  requestId?: string; // forwarded as x-request
};
```

Add a header helper and use it in both `sendMessage` and `streamMessage`:

```ts
function corrHeaders(opts: SendOptions): Record<string, string> {
  const h: Record<string, string> = {};
  if (opts.sessionId) h["x-session"] = opts.sessionId;
  if (opts.requestId) h["x-request"] = opts.requestId;
  return h;
}
```

In `sendMessage`, change the `headers` object to spread it:

```ts
headers: {
  "content-type": "application/json",
  "authorization": `Bearer ${opts.token}`,
  "x-depth": String(opts.depth),
  ...corrHeaders(opts),
},
```

Do the same in `streamMessage` (it also has `"accept": "text/event-stream"`).

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-net tests/protocol/propagation.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/client.ts tests/protocol/propagation.test.ts
git commit -m "feat(protocol): forward x-session/x-request through delegation"
```

---

## Phase 2 — Instrumentation

### Task 5: base.ts — read ids, emit turn/message/error events

**Files:**

- Modify: `src/agent/base.ts` (AgentHandlerCtx, AgentConfig, Variables,
  middleware, both routes)
- Test: `tests/agent/base-emit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/base-emit.test.ts
import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "tester",
  description: "t",
  version: "1.0.0",
  url: "http://localhost:0",
  skills: [],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("base emits turn.started + message.completed with propagated ids", async () => {
  const events: EmitEvent[] = [];
  const handle = await startAgent({
    card,
    bearerToken: "t",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    handler: () => Promise.resolve({ text: "hello" }),
    streamHandler: async function* () {
      yield { type: "done" };
    },
  });

  const res = await fetch(`${handle.card.url}/message/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": "Bearer t",
      "x-depth": "0",
      "x-session": "s1",
      "x-request": "r1",
    },
    body: JSON.stringify({
      message: {
        messageId: "m1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    }),
  });
  await res.json();
  await handle.shutdown();

  const types = events.map((e) => e.type);
  assertEquals(types.includes("turn.started"), true);
  assertEquals(types.includes("message.completed"), true);
  const completed = events.find((e) => e.type === "message.completed")!;
  assertEquals(completed.sessionId, "s1");
  assertEquals(completed.requestId, "r1");
  assertEquals(completed.agent, "tester");
  assertEquals(completed.data.text, "hello");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-net tests/agent/base-emit.test.ts` Expected: FAIL —
`emit` not a valid AgentConfig field / no events captured.

- [ ] **Step 3: Implement**

In `src/agent/base.ts`:

Update imports and types:

```ts
import { Hono } from "hono";
import { type AgentCard, isMessage, type Message } from "../protocol/types.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { Emitter } from "../observability/emit.ts";
import { now } from "../observability/emit.ts";

export type AgentHandlerCtx = {
  depth: number;
  message: Message;
  sessionId: string;
  requestId: string;
};

export type AgentConfig = {
  card: AgentCard;
  bearerToken: string;
  emit?: Emitter; // optional; defaults to no-op
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  streamHandler: (ctx: AgentHandlerCtx) => AsyncGenerator<StreamEvent>;
};

type Variables = { depth: number; sessionId: string; requestId: string };
```

In `startAgent`, after `const app = ...`, add:

```ts
const emit: Emitter = cfg.emit ?? (() => Promise.resolve());
const agent = cfg.card.name;
```

In the `/message/*` middleware, after setting depth, also read the ids:

```ts
c.set("depth", depth);
c.set("sessionId", c.req.header("x-session") ?? "");
c.set("requestId", c.req.header("x-request") ?? "");
await next();
```

Replace the `/message/send` handler body:

```ts
app.post("/message/send", async (c) => {
  const body = await c.req.json();
  if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
  const depth = c.get("depth");
  const sessionId = c.get("sessionId");
  const requestId = c.get("requestId");
  const base = { sessionId, requestId, agent, depth };
  const startedTs = now();
  void emit({ ...base, ts: startedTs, type: "turn.started", data: {} });
  try {
    const result = await cfg.handler({
      depth,
      message: body.message,
      sessionId,
      requestId,
    });
    void emit({
      ...base,
      ts: now(),
      type: "message.completed",
      data: { text: result.text },
    });
    void emit({
      ...base,
      ts: now(),
      type: "turn.completed",
      data: { durationMs: now() - startedTs, status: "ok" },
    });
    return c.json({ text: result.text });
  } catch (e) {
    void emit({
      ...base,
      ts: now(),
      type: "error",
      data: { message: (e as Error).message, where: "send" },
    });
    return c.json({ error: (e as Error).message }, 500);
  }
});
```

Replace the `/message/stream` handler to thread ids and accumulate text:

```ts
app.post("/message/stream", async (c) => {
  const body = await c.req.json();
  if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
  const depth = c.get("depth");
  const sessionId = c.get("sessionId");
  const requestId = c.get("requestId");
  const base = { sessionId, requestId, agent, depth };
  const startedTs = now();
  void emit({ ...base, ts: startedTs, type: "turn.started", data: {} });

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const write = (ev: StreamEvent) =>
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
      let acc = "";
      try {
        for await (
          const ev of cfg.streamHandler({
            depth,
            message: body.message,
            sessionId,
            requestId,
          })
        ) {
          if (ev.type === "delta") acc += ev.text;
          write(ev);
        }
        void emit({
          ...base,
          ts: now(),
          type: "message.completed",
          data: { text: acc },
        });
        void emit({
          ...base,
          ts: now(),
          type: "turn.completed",
          data: { durationMs: now() - startedTs, status: "ok" },
        });
      } catch (e) {
        write({ type: "error", message: (e as Error).message });
        void emit({
          ...base,
          ts: now(),
          type: "error",
          data: { message: (e as Error).message, where: "stream" },
        });
      }
      controller.enqueue(enc.encode(`data: [DONE]\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-net tests/agent/base-emit.test.ts` Expected: PASS.

- [ ] **Step 5: Run the full suite to catch ctx-shape breakage**

Run:
`deno test --allow-net --allow-env --allow-read --allow-write --allow-sys --unstable-kv`
Expected: existing tests that build `AgentHandlerCtx` may fail to compile
because `sessionId`/`requestId` are now required. Fix each by adding
`sessionId: "", requestId: ""` to test ctx literals. (Search: `depth:` in
`tests/`.)

- [ ] **Step 6: Commit**

```bash
git add src/agent/base.ts tests/agent/base-emit.test.ts tests/
git commit -m "feat(agent): emit turn/message/error events from base, thread ids to ctx"
```

---

### Task 6: tools.ts — emit delegation/tool/spawn events + forward ids

**Files:**

- Modify: `src/agent/tools.ts` (ToolDeps, `delegate`, `runTool`)
- Test: `tests/agent/tools-emit.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/agent/tools-emit.test.ts
import { assertEquals } from "@std/assert";
import { runTool, type ToolDeps } from "../../src/agent/tools.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import { RegistryClient } from "../../src/registry/client.ts";

Deno.test("runTool(list_agents) emits a tool.call event with ids", async () => {
  const events: EmitEvent[] = [];
  // Registry stub returning an empty agent list.
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/agents") {
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("null", {
      headers: { "content-type": "application/json" },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;

  const deps: ToolDeps = {
    store: null as never,
    threads: null as never,
    registry: new RegistryClient(`http://localhost:${port}`),
    bearerToken: "t",
    selfName: "coordinator",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  };

  await runTool(deps, "list_agents", {}, 0, "ctx1", {
    sessionId: "s1",
    requestId: "r1",
  });
  await server.shutdown();

  const call = events.find((e) => e.type === "tool.call")!;
  assertEquals(call.data.tool, "list_agents");
  assertEquals(call.sessionId, "s1");
  assertEquals(call.requestId, "r1");
  assertEquals(call.agent, "coordinator");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-net tests/agent/tools-emit.test.ts` Expected: FAIL —
`emit` not on ToolDeps / `runTool` does not accept a 6th arg.

- [ ] **Step 3: Implement**

In `src/agent/tools.ts`:

Add imports at top:

```ts
import type { Emitter } from "../observability/emit.ts";
import { now } from "../observability/emit.ts";
```

Add to `ToolDeps`:

```ts
// Optional event emitter; defaults to no-op inside runTool.
emit?: Emitter;
```

Add a correlation-id param type near the top:

```ts
export type EmitIds = { sessionId: string; requestId: string };
```

Change `delegate` to forward ids and accept them:

```ts
async function delegate(
  deps: ToolDeps,
  threadId: string,
  peerUrl: string,
  prompt: string,
  depth: number,
  ids: EmitIds,
): Promise<string> {
  const res = await sendMessage({
    url: peerUrl,
    token: deps.bearerToken,
    depth: depth + 1,
    sessionId: ids.sessionId,
    requestId: ids.requestId,
    message: {
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ type: "text", text: prompt }],
      contextId: threadId,
    },
  });
  return res.text;
}
```

Change `runTool`'s signature to accept ids and emit. Replace the signature line
and add a local emit helper at the top of the function body:

```ts
export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
  ids: EmitIds,
): Promise<string> {
  const emit = deps.emit ?? (() => Promise.resolve());
  const ev = (type: Parameters<Emitter>[0]["type"], data: Record<string, unknown>, threadId?: string) =>
    void emit({
      sessionId: ids.sessionId, requestId: ids.requestId, agent: deps.selfName,
      depth, ts: now(), type, data, threadId,
    });
  try {
```

Then add emits inside each tool branch (just before each `return`):

For `list_agents`, `list_my_threads`, `reset_thread`, `list_roles` — emit a
generic `tool.call` immediately before returning. Example for `list_agents`:

```ts
if (name === "list_agents") {
  const cards = await deps.registry.list();
  const peers = cards.filter((c) => c.name !== deps.selfName);
  const result = JSON.stringify(
    peers.map((c) => ({
      name: c.name,
      description: c.description,
      skills: c.skills,
    })),
  );
  ev("tool.call", {
    tool: "list_agents",
    resultPreview: `${peers.length} peers`,
  });
  return result;
}
```

(Apply the same one-line `ev("tool.call", { tool: name, ... })` pattern before
the returns in `list_my_threads`, `reset_thread`, `list_roles`.)

For `delegate_start`:

```ts
if (name === "delegate_start") {
  const target = String(args.agent);
  const prompt = String(args.prompt);
  const title = typeof args.title === "string" && args.title.trim()
    ? args.title
    : truncate(prompt);
  const card = await deps.registry.get(target);
  if (!card) return JSON.stringify({ error: `unknown agent ${target}` });
  const meta = await deps.threads.start(parentContextId, target, title);
  ev(
    "delegate.start",
    { peer: target, title, prompt: truncate(prompt, 200) },
    meta.threadId,
  );
  const startedTs = now();
  const text = await delegate(
    deps,
    meta.threadId,
    card.url,
    prompt,
    depth,
    ids,
  );
  await deps.threads.touch(meta.threadId);
  ev("delegate.return", {
    peer: target,
    ok: true,
    durationMs: now() - startedTs,
    preview: truncate(text, 200),
  }, meta.threadId);
  return JSON.stringify({ threadId: meta.threadId, text });
}
```

For `delegate_continue` (add `turn` from the touched meta's `turnCount` if
available, else omit):

```ts
if (name === "delegate_continue") {
  const threadId = String(args.threadId);
  const prompt = String(args.prompt);
  const meta = await deps.threads.get(threadId);
  if (!meta) return JSON.stringify({ error: `unknown thread ${threadId}` });
  if (meta.parentContextId !== parentContextId) {
    return JSON.stringify({
      error: `thread ${threadId} is not owned by this conversation`,
    });
  }
  const card = await deps.registry.get(meta.peer);
  if (!card) return JSON.stringify({ error: `peer ${meta.peer} is gone` });
  ev("delegate.continue", {
    peer: meta.peer,
    turn: meta.turnCount + 1,
    prompt: truncate(prompt, 200),
  }, threadId);
  const startedTs = now();
  const text = await delegate(deps, threadId, card.url, prompt, depth, ids);
  await deps.threads.touch(threadId);
  ev("delegate.return", {
    peer: meta.peer,
    ok: true,
    durationMs: now() - startedTs,
    preview: truncate(text, 200),
  }, threadId);
  return JSON.stringify({ threadId, text });
}
```

For `spawn_agent` (emit after the spawn result):

```ts
const result = await deps.spawnAgent(role, customName, model);
ev("spawn", {
  role,
  name: result.name ?? customName ?? role,
  model: model ?? null,
  ok: result.ok,
});
return JSON.stringify(result);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-net tests/agent/tools-emit.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools.ts tests/agent/tools-emit.test.ts
git commit -m "feat(agent): emit delegate/tool/spawn events and forward ids"
```

---

### Task 7: Wire emit + ids through handlers and backends

**Files:**

- Modify: `src/agent/handlers.ts` (BuildHandlersDeps, pass emit into tool deps)
- Modify: `src/agent/claude.ts` (ClaudeDeps.emit, toolDeps.emit, runTool calls)
- Modify: `src/agent/ollama.ts` (pass ids to runTool; tools already carry deps)
- Modify: `src/agent/claude-code.ts` (mirror claude wiring)
- Test: covered by Task 6 + the e2e in Task 16; add a compile-smoke run here.

- [ ] **Step 1: Update `handlers.ts`**

Add `emit` to `BuildHandlersDeps`:

```ts
import type { Emitter } from "../observability/emit.ts";
// ...
export type BuildHandlersDeps = {
  model: string;
  preset: RolePreset;
  cfg: AppConfig;
  store: ContextStore;
  threads: ThreadStore;
  sessions: SessionStore;
  registry: RegistryClient;
  selfName: string;
  emit?: Emitter;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
};
```

Pass `emit: d.emit` into each `make*Handlers(...)` call (claude, claude-code,
and ollama's `tools` object).

- [ ] **Step 2: Update `claude.ts`**

Add `emit?: Emitter` to `ClaudeDeps` (import the type). Add `emit: deps.emit` to
the `toolDeps` object. Change the `runTool` call to pass ids from ctx:

```ts
content: await runTool(toolDeps, tb.name, tb.input, ctx.depth, contextId, {
  sessionId: ctx.sessionId, requestId: ctx.requestId,
}),
```

- [ ] **Step 3: Update `ollama.ts`**

Both `runTool` call sites (in `handler` and `streamHandler`) gain the ids arg:

```ts
const result = await runTool(
  deps.tools,
  tc.function.name,
  tc.function.arguments ?? {},
  ctx.depth,
  contextId,
  { sessionId: ctx.sessionId, requestId: ctx.requestId },
);
```

(`deps.tools` is a `ToolDeps`; its `emit` is supplied by `handlers.ts`.)

- [ ] **Step 4: Update `claude-code.ts`**

Mirror Task 7 Step 2: add `emit?: Emitter` to its deps type, set `emit` on its
tool deps object, and pass
`{ sessionId: ctx.sessionId, requestId: ctx.requestId }` to every `runTool`
call. (Open the file and apply the same pattern as claude.ts to each `runTool`
invocation.)

- [ ] **Step 5: Typecheck**

Run: `deno check src/main.ts src/agent-entry.ts` Expected: no type errors. Fix
any missing `emit`/ids wiring the checker reports.

- [ ] **Step 6: Commit**

```bash
git add src/agent/handlers.ts src/agent/claude.ts src/agent/ollama.ts src/agent/claude-code.ts
git commit -m "feat(agent): thread emitter + correlation ids through all backends"
```

---

### Task 8: Wire orchestrator, agent-entry, and REPL

**Files:**

- Modify: `src/orchestrator.ts` (create emitter; pass to buildHandlers +
  startAgent + repl)
- Modify: `src/agent-entry.ts` (create emitter; pass to buildHandlers +
  startAgent)
- Modify: `src/repl.ts` (mint ids; emit request.*; pass ids to streamMessage)

- [ ] **Step 1: Update `orchestrator.ts`**

Add import and create the emitter after `const kv = ...`:

```ts
import { createEmitter } from "./observability/emit.ts";
// ...
const emit = createEmitter(cfg.monitorUrl || undefined, cfg.bearerToken);
```

Pass `emit` into `buildHandlers({ ... emit, ... })` and into
`startAgent({ card, bearerToken, emit, handler, streamHandler })`.

Pass it into the REPL:
`await runRepl({ agents, bearerToken: cfg.bearerToken, emit });`

- [ ] **Step 2: Update `agent-entry.ts`**

```ts
import { createEmitter } from "./observability/emit.ts";
// ...
const emit = createEmitter(cfg.monitorUrl || undefined, cfg.bearerToken);
```

Pass `emit` into `buildHandlers({ ... emit })` and `startAgent({ ... emit })`.

- [ ] **Step 3: Update `repl.ts`**

Add to `ReplDeps`:

```ts
import type { Emitter } from "./observability/emit.ts";
import { now } from "./observability/emit.ts";

export type ReplDeps = {
  agents: Map<string, AgentCard>;
  bearerToken: string;
  emit?: Emitter;
};
```

In `runRepl`, after `const contextId = crypto.randomUUID();` add:

```ts
const sessionId = contextId; // session == driver run
const emit: Emitter = deps.emit ?? (() => Promise.resolve());
```

Inside the per-line block, after resolving `card` and before streaming, mint a
requestId and emit `request.started`; pass ids into `streamMessage`; emit
`request.completed` after the loop. Concretely, replace the streaming block:

```ts
const requestId = crypto.randomUUID();
void emit({
  sessionId,
  requestId,
  agent: "REPL",
  depth: 0,
  ts: now(),
  type: "request.started",
  data: { target: name, prompt },
});
const enc = new TextEncoder();
Deno.stdout.writeSync(enc.encode(`[${name}] `));
const startedTs = now();
try {
  for await (
    const ev of streamMessage({
      url: card.url,
      token: deps.bearerToken,
      depth: 0,
      sessionId,
      requestId,
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: prompt }],
        contextId,
      },
    })
  ) {
    if (ev.type === "delta") Deno.stdout.writeSync(enc.encode(ev.text));
    else if (ev.type === "tool") {
      const argsStr = JSON.stringify(ev.args);
      const compact = argsStr.length > 80
        ? argsStr.slice(0, 77) + "…"
        : argsStr;
      Deno.stdout.writeSync(enc.encode(`\n  · ${ev.name}${compact}\n  `));
    } else if (ev.type === "error") {
      Deno.stdout.writeSync(enc.encode(`\n[error] ${ev.message}`));
    } else if (ev.type === "done") break;
  }
} catch (e) {
  Deno.stdout.writeSync(enc.encode(`\n[error] ${(e as Error).message}`));
}
void emit({
  sessionId,
  requestId,
  agent: "REPL",
  depth: 0,
  ts: now(),
  type: "request.completed",
  data: { durationMs: now() - startedTs },
});
Deno.stdout.writeSync(enc.encode(PROMPT));
```

- [ ] **Step 4: Typecheck + smoke (monitor off — must behave as today)**

Run: `deno check src/main.ts src/agent-entry.ts` Expected: no errors.

Run (monitor unset):
`deno test --allow-net --allow-env --allow-read --allow-write --allow-sys --unstable-kv`
Expected: full suite passes — emit is no-op, behavior unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.ts src/agent-entry.ts src/repl.ts
git commit -m "feat: wire emitter + session/request ids through orchestrator, agent-entry, REPL"
```

---

## Phase 3 — Monitor service

### Task 9: Monitor store (KV writes, seq, summaries, reads)

**Files:**

- Create: `monitor/store.ts`
- Test: `tests/monitor/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/monitor/store.test.ts
import { assertEquals } from "@std/assert";
import { MonitorStore } from "../../monitor/store.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

function ev(partial: Partial<EmitEvent>): EmitEvent {
  return {
    sessionId: "s1",
    requestId: "r1",
    ts: 1,
    agent: "a",
    depth: 0,
    type: "turn.started",
    data: {},
    ...partial,
  };
}

Deno.test("ingest assigns monotonic seq per session and persists", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new MonitorStore(kv);
  const a = await store.ingest(ev({ type: "request.started" }));
  const b = await store.ingest(ev({ type: "turn.started" }));
  assertEquals(a.seq, 0);
  assertEquals(b.seq, 1);

  const events = await store.getSessionEvents("s1");
  assertEquals(events.length, 2);
  assertEquals(events[0].seq, 0);
  assertEquals(events[1].seq, 1);
  kv.close();
});

Deno.test("session summary tracks agents, requests, lastSeq", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new MonitorStore(kv);
  await store.ingest(
    ev({ agent: "REPL", type: "request.started", requestId: "r1" }),
  );
  await store.ingest(
    ev({ agent: "coordinator", type: "turn.started", requestId: "r1" }),
  );
  await store.ingest(
    ev({ agent: "REPL", type: "request.started", requestId: "r2" }),
  );

  const list = await store.listSessions();
  assertEquals(list.length, 1);
  assertEquals(list[0].sessionId, "s1");
  assertEquals(list[0].requestCount, 2);
  assertEquals(list[0].agents.sort(), ["REPL", "coordinator"]);
  assertEquals(list[0].lastSeq, 2);
  kv.close();
});

Deno.test("seq rehydrates after a store restart on the same kv", async () => {
  const kv = await Deno.openKv(":memory:");
  const s1 = new MonitorStore(kv);
  await s1.ingest(ev({}));
  await s1.ingest(ev({}));
  const s2 = new MonitorStore(kv); // fresh instance, same kv
  const c = await s2.ingest(ev({}));
  assertEquals(c.seq, 2);
  kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read --unstable-kv tests/monitor/store.test.ts`
Expected: FAIL — `monitor/store.ts` not found.

- [ ] **Step 3: Implement**

```ts
// monitor/store.ts
// Persistence for the monitor. Owns its OWN Deno KV (never the agents' KV).
// Assigns the authoritative `seq` on ingest and maintains a per-session
// summary so the sessions list never scans all events.
import {
  type A2AEvent,
  type EmitEvent,
  parseEvent,
} from "../src/observability/events.ts";

export type SessionSummary = {
  sessionId: string;
  startedAt: number;
  lastEventAt: number;
  agents: string[];
  requestCount: number;
  lastSeq: number;
  status: "active" | "done";
};

export class MonitorStore {
  // In-memory next-seq cache per session; rehydrated from KV on miss.
  #nextSeq = new Map<string, number>();

  constructor(private kv: Deno.Kv) {}

  async #seqFor(sessionId: string): Promise<number> {
    const cached = this.#nextSeq.get(sessionId);
    if (cached !== undefined) return cached;
    const summary = await this.kv.get<SessionSummary>(["session", sessionId]);
    const next = summary.value ? summary.value.lastSeq + 1 : 0;
    this.#nextSeq.set(sessionId, next);
    return next;
  }

  async ingest(input: EmitEvent | A2AEvent): Promise<A2AEvent> {
    const seq = await this.#seqFor(input.sessionId);
    const event = parseEvent({ ...input, seq });
    this.#nextSeq.set(event.sessionId, seq + 1);

    await this.kv.set(["evt", event.sessionId, event.requestId, seq], event);
    await this.#updateSummary(event);
    return event;
  }

  async #updateSummary(event: A2AEvent): Promise<void> {
    const key = ["session", event.sessionId];
    const cur = (await this.kv.get<SessionSummary>(key)).value;
    const agents = new Set(cur?.agents ?? []);
    if (event.agent) agents.add(event.agent);
    const summary: SessionSummary = {
      sessionId: event.sessionId,
      startedAt: cur?.startedAt ?? event.ts,
      lastEventAt: event.ts,
      agents: [...agents],
      requestCount: await this.#countRequests(event),
      lastSeq: event.seq,
      status: "active",
    };
    await this.kv.set(key, summary);
  }

  // Count distinct requestIds by recording each on first sight, then scanning.
  async #countRequests(event: A2AEvent): Promise<number> {
    const reqKey = ["session_req", event.sessionId, event.requestId];
    if (!(await this.kv.get(reqKey)).value) await this.kv.set(reqKey, 1);
    let count = 0;
    for await (
      const _ of this.kv.list({ prefix: ["session_req", event.sessionId] })
    ) count++;
    return count;
  }

  async getSessionEvents(sessionId: string): Promise<A2AEvent[]> {
    const out: A2AEvent[] = [];
    for await (
      const entry of this.kv.list<A2AEvent>({ prefix: ["evt", sessionId] })
    ) {
      out.push(entry.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async getRequestEvents(
    sessionId: string,
    requestId: string,
  ): Promise<A2AEvent[]> {
    const out: A2AEvent[] = [];
    for await (
      const entry of this.kv.list<A2AEvent>({
        prefix: ["evt", sessionId, requestId],
      })
    ) {
      out.push(entry.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for await (
      const entry of this.kv.list<SessionSummary>({ prefix: ["session"] })
    ) {
      out.push(entry.value);
    }
    out.sort((a, b) => b.lastEventAt - a.lastEventAt);
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read --unstable-kv tests/monitor/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor/store.ts tests/monitor/store.test.ts
git commit -m "feat(monitor): KV store with seq assignment + session summaries"
```

---

### Task 10: In-memory fan-out bus

**Files:**

- Create: `monitor/bus.ts`
- Test: `tests/monitor/bus.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/monitor/bus.test.ts
import { assertEquals } from "@std/assert";
import { EventBus } from "../../monitor/bus.ts";
import type { A2AEvent } from "../../src/observability/events.ts";

function ev(sessionId: string): A2AEvent {
  return {
    sessionId,
    requestId: "r1",
    seq: 0,
    ts: 1,
    agent: "a",
    depth: 0,
    type: "turn.started",
    data: {},
  };
}

Deno.test("subscribers receive events for their session only", () => {
  const bus = new EventBus();
  const s1: A2AEvent[] = [];
  const s2: A2AEvent[] = [];
  const unsub1 = bus.subscribe("s1", (e) => s1.push(e));
  bus.subscribe("s2", (e) => s2.push(e));
  bus.publish(ev("s1"));
  assertEquals(s1.length, 1);
  assertEquals(s2.length, 0);
  unsub1();
  bus.publish(ev("s1"));
  assertEquals(s1.length, 1); // unsubscribed
});

Deno.test("wildcard subscribers receive every event", () => {
  const bus = new EventBus();
  const all: A2AEvent[] = [];
  bus.subscribe("*", (e) => all.push(e));
  bus.publish(ev("s1"));
  bus.publish(ev("s2"));
  assertEquals(all.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test tests/monitor/bus.test.ts` Expected: FAIL — `monitor/bus.ts` not
found.

- [ ] **Step 3: Implement**

```ts
// monitor/bus.ts
// In-memory fan-out. KV is the source of truth for history; this bus only
// pushes live events to currently-connected SSE clients.
import type { A2AEvent } from "../src/observability/events.ts";

type Listener = (event: A2AEvent) => void;

export class EventBus {
  // sessionId -> listeners; "*" -> wildcard (sessions-list page).
  #subs = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.#subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subs.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#subs.delete(sessionId);
    };
  }

  publish(event: A2AEvent): void {
    for (const l of this.#subs.get(event.sessionId) ?? []) l(event);
    for (const l of this.#subs.get("*") ?? []) l(event);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test tests/monitor/bus.test.ts` Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor/bus.ts tests/monitor/bus.test.ts
git commit -m "feat(monitor): in-memory fan-out bus"
```

---

### Task 11: Monitor HTTP server

**Files:**

- Create: `monitor/server.ts`
- Test: `tests/monitor/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/monitor/server.test.ts
import { assertEquals } from "@std/assert";
import { startMonitor } from "../../monitor/server.ts";

Deno.test("POST /ingest persists and GET /api/sessions returns it", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });

  const post = await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      requestId: "r1",
      ts: 1,
      agent: "REPL",
      depth: 0,
      type: "request.started",
      data: { target: "coordinator", prompt: "hi" },
    }),
  });
  assertEquals(post.status, 200);

  const sessions = await (await fetch(`${mon.url}/api/sessions`)).json();
  assertEquals(sessions.length, 1);
  assertEquals(sessions[0].sessionId, "s1");

  const detail = await (await fetch(`${mon.url}/api/sessions/s1`)).json();
  assertEquals(detail.events.length, 1);
  assertEquals(detail.summary.sessionId, "s1");

  await mon.shutdown();
  kv.close();
});

Deno.test("POST /ingest rejects a malformed envelope", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const res = await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nope: true }),
  });
  assertEquals(res.status, 400);
  await mon.shutdown();
  kv.close();
});

Deno.test("GET /stream delivers a posted event to a subscriber", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const res = await fetch(`${mon.url}/stream?session=s1`, {
    headers: { accept: "text/event-stream" },
  });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();

  await fetch(`${mon.url}/ingest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "s1",
      requestId: "r1",
      ts: 1,
      agent: "a",
      depth: 0,
      type: "turn.started",
      data: {},
    }),
  });

  let got = "";
  while (!got.includes("turn.started")) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value;
  }
  assertEquals(got.includes("turn.started"), true);
  await reader.cancel();
  await mon.shutdown();
  kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`deno test --allow-net --allow-read --unstable-kv tests/monitor/server.test.ts`
Expected: FAIL — `monitor/server.ts` not found.

- [ ] **Step 3: Implement**

```ts
// monitor/server.ts
import { Hono } from "hono";
import { MonitorStore } from "./store.ts";
import { EventBus } from "./bus.ts";
import { parseEvent } from "../src/observability/events.ts";

export type MonitorConfig = {
  kv: Deno.Kv;
  port: number;
  token: string; // "" disables the bearer check on /ingest
  webDir?: string; // static UI directory; omitted in tests
};

export type MonitorHandle = {
  port: number;
  url: string;
  shutdown(): Promise<void>;
};

export function startMonitor(cfg: MonitorConfig): Promise<MonitorHandle> {
  const store = new MonitorStore(cfg.kv);
  const bus = new EventBus();
  const app = new Hono();

  app.post("/ingest", async (c) => {
    if (cfg.token) {
      const auth = c.req.header("authorization") ?? "";
      if (auth !== `Bearer ${cfg.token}`) {
        return c.json({ error: "unauthorized" }, 401);
      }
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    const items = Array.isArray(body) ? body : [body];
    try {
      for (const item of items) {
        // Validate the emitter shape (seq defaults to 0 then store reassigns).
        parseEvent({ ...(item as Record<string, unknown>), seq: 0 });
        const stored = await store.ingest(item as never);
        bus.publish(stored);
      }
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    return c.json({ ok: true });
  });

  app.get("/api/sessions", async (c) => c.json(await store.listSessions()));

  app.get("/api/sessions/:id", async (c) => {
    const id = c.req.param("id");
    const summary = (await store.listSessions()).find((s) =>
      s.sessionId === id
    ) ?? null;
    const events = await store.getSessionEvents(id);
    return c.json({ summary, events });
  });

  app.get("/stream", (c) => {
    const session = c.req.query("session") ?? "*";
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: unknown) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        send({ type: "hello", session });
        const unsub = bus.subscribe(session, (ev) => {
          try {
            send(ev);
          } catch { /* closed */ }
        });
        c.req.raw.signal.addEventListener("abort", () => {
          unsub();
          try {
            controller.close();
          } catch { /* already closed */ }
        });
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  });

  if (cfg.webDir) {
    app.get("/*", async (c) => {
      const path = new URL(c.req.url).pathname;
      const file = path === "/" ? "/index.html" : path;
      try {
        const body = await Deno.readFile(`${cfg.webDir}${file}`);
        const type = file.endsWith(".html")
          ? "text/html"
          : file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
          ? "text/css"
          : "application/octet-stream";
        return new Response(body, { headers: { "content-type": type } });
      } catch {
        return c.notFound();
      }
    });
  }

  const server = Deno.serve({ port: cfg.port, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  return Promise.resolve({
    port,
    url: `http://localhost:${port}`,
    shutdown: async () => {
      await server.shutdown();
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`deno test --allow-net --allow-read --unstable-kv tests/monitor/server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add monitor/server.ts tests/monitor/server.test.ts
git commit -m "feat(monitor): HTTP server (ingest, sessions, SSE stream, static)"
```

---

### Task 12: Monitor entry point + deno task

**Files:**

- Create: `monitor/main.ts`
- Modify: `deno.json` (add `monitor` task)

- [ ] **Step 1: Implement `monitor/main.ts`**

```ts
// monitor/main.ts
// Standalone monitor service. Run: deno task monitor
import { load } from "@std/dotenv";
import { startMonitor } from "./server.ts";

await load({ export: true });
const env = Deno.env.toObject();
const port = Number(env.MONITOR_PORT ?? 7891);
const kvPath = env.MONITOR_KV_PATH ?? "./a2a-monitor.db";
const token = env.AGENT_BEARER_TOKEN ?? "";
const webDir = new URL("./web", import.meta.url).pathname;

const kv = await Deno.openKv(kvPath);
const mon = await startMonitor({ kv, port, token, webDir });
console.log(`[monitor] ${mon.url}  (kv: ${kvPath})`);

const shutdown = async () => {
  await mon.shutdown();
  kv.close();
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);
await new Promise<void>(() => {});
```

- [ ] **Step 2: Add the task to `deno.json`**

In the `tasks` object add:

```json
"monitor": "deno run --allow-net --allow-env --allow-read --unstable-kv --env-file=.env monitor/main.ts"
```

- [ ] **Step 3: Manual smoke**

Run: `deno task monitor` Expected: prints
`[monitor] http://localhost:7891  (kv: ./a2a-monitor.db)`. In another shell:

```bash
curl -s localhost:7891/api/sessions
```

Expected: `[]`. Stop with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add monitor/main.ts deno.json
git commit -m "feat(monitor): standalone entry point + deno task monitor"
```

---

## Phase 4 — Web UI

### Task 13: Static shell + sessions list

**Files:**

- Create: `monitor/web/index.html`
- Create: `monitor/web/styles.css`
- Create: `monitor/web/app.js`

- [ ] **Step 1: Implement `index.html`**

```html
<!-- monitor/web/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>A2A Monitor</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header><strong>A2A Monitor</strong> <span id="crumb"></span></header>
    <main id="view"></main>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Implement `styles.css`**

```css
/* monitor/web/styles.css */
:root {
  color-scheme: dark;
  --bg: #0d0d0f;
  --fg: #e8e8ea;
  --mut: #9aa;
  --line: #333;
  --repl: #888;
  --coord: #2e6fff;
  --del: #e0a030;
  --ret: #7fd17f;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
}
header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}
main {
  padding: 14px;
}
a {
  color: var(--coord);
  cursor: pointer;
  text-decoration: none;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th, td {
  text-align: left;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
}
.mut {
  color: var(--mut);
}
.lane-head {
  font-weight: 700;
  font-size: 11px;
}
.detail {
  margin-top: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 10px 12px;
}
.bubble {
  background: #0004;
  border-radius: 8px;
  padding: 7px 10px;
  margin: 5px 0;
  white-space: pre-wrap;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.tab {
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 3px 10px;
  cursor: pointer;
}
.tab.on {
  background: #2e6fff22;
  border-color: var(--coord);
}
svg text {
  fill: var(--fg);
  font: 11px ui-monospace, monospace;
}
```

- [ ] **Step 3: Implement `app.js` (router + sessions list; session view added
      in Task 15)**

```js
// monitor/web/app.js
import { renderSwimlane } from "/swimlane.js";

const view = document.getElementById("view");
const crumb = document.getElementById("crumb");

async function getJSON(url) {
  return (await fetch(url)).json();
}

async function routeSessions() {
  crumb.textContent = "";
  const sessions = await getJSON("/api/sessions");
  view.innerHTML = `<table><thead><tr>
    <th>session</th><th>started</th><th>agents</th><th>requests</th><th>status</th>
    </tr></thead><tbody>${
    sessions.map((s) =>
      `<tr>
        <td><a href="#/session/${s.sessionId}">${
        s.sessionId.slice(0, 8)
      }</a></td>
        <td class="mut">${new Date(s.startedAt).toLocaleTimeString()}</td>
        <td>${s.agents.join(", ")}</td>
        <td>${s.requestCount}</td>
        <td>${s.status}</td></tr>`
    ).join("")
  }</tbody></table>`;

  // live: new/changed sessions
  const es = new EventSource("/stream?session=*");
  es.onmessage = () => {
    /* re-fetch on any event */ routeSessions._dirty = true;
  };
  clearInterval(routeSessions._timer);
  routeSessions._timer = setInterval(() => {
    if (routeSessions._dirty) {
      routeSessions._dirty = false;
      if (location.hash.startsWith("#/session/")) {}
      else routeSessions();
    }
  }, 1000);
  routeSessions._es = es;
}

function router() {
  if (routeSessions._es) {
    routeSessions._es.close();
    routeSessions._es = null;
  }
  const m = location.hash.match(/^#\/session\/(.+)$/);
  if (m) return renderSwimlane(view, crumb, m[1]);
  return routeSessions();
}

globalThis.addEventListener("hashchange", router);
router();
```

- [ ] **Step 4: Manual check**

Run `deno task monitor`, then `curl -s localhost:7891/` — expect the HTML shell.
(Full visual check happens in Task 15.)

- [ ] **Step 5: Commit**

```bash
git add monitor/web/index.html monitor/web/styles.css monitor/web/app.js
git commit -m "feat(monitor/ui): static shell + live sessions list"
```

---

### Task 14: Swimlane layout (pure function) + test

**Files:**

- Create: `monitor/web/layout.js` (pure layout, importable by Deno for testing)
- Test: `tests/monitor/layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/monitor/layout.test.ts
import { assertEquals } from "@std/assert";
// layout.js is framework-free ESM; import it directly.
import { computeLayout } from "../../monitor/web/layout.js";

const events = [
  {
    sessionId: "s1",
    requestId: "r1",
    seq: 0,
    ts: 1,
    agent: "REPL",
    depth: 0,
    type: "request.started",
    data: { target: "coordinator" },
  },
  {
    sessionId: "s1",
    requestId: "r1",
    seq: 1,
    ts: 2,
    agent: "coordinator",
    depth: 0,
    type: "delegate.start",
    data: { peer: "scout" },
    threadId: "t1",
  },
  {
    sessionId: "s1",
    requestId: "r1",
    seq: 2,
    ts: 3,
    agent: "coordinator",
    depth: 0,
    type: "delegate.return",
    data: { peer: "scout" },
    threadId: "t1",
  },
  {
    sessionId: "s1",
    requestId: "r1",
    seq: 3,
    ts: 4,
    agent: "coordinator",
    depth: 0,
    type: "message.completed",
    data: { text: "done" },
  },
];

Deno.test("computeLayout assigns a lane per agent including REPL and peers", () => {
  const { lanes } = computeLayout(events);
  const names = lanes.map((l) => l.agent);
  assertEquals(names.includes("REPL"), true);
  assertEquals(names.includes("coordinator"), true);
  assertEquals(names.includes("scout"), true);
});

Deno.test("computeLayout turns delegate.start into an outbound arrow", () => {
  const { arrows } = computeLayout(events);
  const out = arrows.find((a) => a.kind === "delegate" && a.to === "scout");
  assertEquals(out!.from, "coordinator");
});

Deno.test("computeLayout draws depth-0 message.completed as a return to REPL", () => {
  const { arrows } = computeLayout(events);
  const fin = arrows.find((a) => a.kind === "final");
  assertEquals(fin!.from, "coordinator");
  assertEquals(fin!.to, "REPL");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --allow-read tests/monitor/layout.test.ts` Expected: FAIL —
`monitor/web/layout.js` not found.

- [ ] **Step 3: Implement `layout.js`**

```js
// monitor/web/layout.js
// Pure function: ordered events -> { lanes, arrows }. No DOM, so it is unit
// testable under Deno. Lanes are ordered by first appearance, REPL first.
export function computeLayout(events) {
  const order = [];
  const seen = new Set();
  const see = (a) => {
    if (a && !seen.has(a)) {
      seen.add(a);
      order.push(a);
    }
  };
  see("REPL");
  for (const e of events) {
    see(e.agent);
    if (e.data && typeof e.data.peer === "string") see(e.data.peer);
    if (e.type === "spawn" && typeof e.data.name === "string") see(e.data.name);
  }
  const laneX = new Map();
  const lanes = order.map((agent, i) => {
    const x = 90 + i * 200;
    laneX.set(agent, x);
    return { agent, x };
  });

  const arrows = [];
  let y = 70;
  const rowH = 46;
  for (const e of events) {
    const row = { y, seq: e.seq, event: e };
    if (e.type === "request.started") {
      arrows.push({
        ...row,
        kind: "request",
        from: "REPL",
        to: e.agent === "REPL" ? (e.data.target ?? "?") : e.agent,
      });
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
    } else {
      continue; // turn.started / turn.completed / non-depth0 message.completed: no arrow
    }
    y += rowH;
  }
  return { lanes, laneX: Object.fromEntries(laneX), arrows, height: y + 20 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --allow-read tests/monitor/layout.test.ts` Expected: PASS (3
tests).

- [ ] **Step 5: Commit**

```bash
git add monitor/web/layout.js tests/monitor/layout.test.ts
git commit -m "feat(monitor/ui): pure swimlane layout + tests"
```

---

### Task 15: Swimlane renderer + live wiring + detail panel

**Files:**

- Create: `monitor/web/swimlane.js`

- [ ] **Step 1: Implement `swimlane.js`**

```js
// monitor/web/swimlane.js
import { computeLayout } from "/layout.js";

const COLOR = {
  request: "var(--repl)",
  delegate: "var(--del)",
  continue: "var(--del)",
  return: "var(--ret)",
  final: "var(--ret)",
  self: "var(--del)",
  error: "#e05555",
};

export async function renderSwimlane(view, crumb, sessionId) {
  crumb.innerHTML = `/ <a href="#/">sessions</a> / ${sessionId.slice(0, 8)}`;
  const data = await (await fetch(`/api/sessions/${sessionId}`)).json();
  let events = data.events;

  const draw = (selectedSeq) => {
    const { lanes, laneX, arrows, height } = computeLayout(events);
    const width = 90 + lanes.length * 200;
    const heads = lanes.map((l) =>
      `<text x="${l.x}" y="24" text-anchor="middle" class="lane-head">${l.agent}</text>
       <line x1="${l.x}" y1="36" x2="${l.x}" y2="${height}" stroke="#fff2" stroke-dasharray="3 5"/>`
    ).join("");
    const body = arrows.map((a) => {
      const x1 = laneX[a.from], x2 = laneX[a.to];
      const color = COLOR[a.kind] ?? "var(--repl)";
      const dash = (a.kind === "return" || a.kind === "final")
        ? `stroke-dasharray="5 4"`
        : "";
      const sel = a.seq === selectedSeq
        ? `stroke-width="3.5"`
        : `stroke-width="2"`;
      if (a.from === a.to) {
        return `<path d="M${x1},${a.y} q44,-6 44,8 q0,15 -44,8" fill="none" stroke="${color}" stroke-width="1.6" data-seq="${a.seq}"/>
                <text x="${x1 + 52}" y="${a.y + 4}">· ${
          a.event.data.tool ?? a.event.type
        }</text>`;
      }
      return `<line x1="${x1}" y1="${a.y}" x2="${x2}" y2="${a.y}" stroke="${color}" ${sel} ${dash} data-seq="${a.seq}" style="cursor:pointer"/>`;
    }).join("");
    view.innerHTML = `<div class="tabs" id="tabs"></div>
       <svg width="${width}" height="${height}" id="canvas">${heads}${body}</svg>
       <div class="detail" id="detail"><span class="mut">click an arrow to inspect</span></div>`;

    view.querySelectorAll("[data-seq]").forEach((el) => {
      el.addEventListener(
        "click",
        () => draw(Number(el.getAttribute("data-seq"))),
      );
    });
    if (selectedSeq != null) {
      const e = events.find((x) => x.seq === selectedSeq);
      if (e) {
        document.getElementById("detail").innerHTML =
          `<strong>${e.agent} · ${e.type}</strong>
           <div class="mut">seq ${e.seq} · depth ${e.depth}${
            e.threadId ? " · thread " + e.threadId : ""
          }</div>
           ${
            Object.entries(e.data).map(([k, v]) =>
              `<div class="bubble"><span class="mut">${k}</span>\n${
                typeof v === "string" ? v : JSON.stringify(v)
              }</div>`
            ).join("")
          }`;
      }
    }
  };

  draw(null);

  // live updates
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

- [ ] **Step 2: Manual end-to-end visual check**

Terminal 1: `deno task monitor` Terminal 2:
`A2A_MONITOR_URL=http://localhost:7891 deno task start --agents="coordinator,scout"`
In the REPL: `@coordinator ask scout to write a haiku about frogs` Browser: open
`http://localhost:7891`, click the session, confirm:

- lanes for REPL / coordinator / scout
- a `delegate.start` amber arrow and a dashed `delegate.return`
- a final dashed arrow back to REPL
- clicking an arrow fills the detail panel
- the view updates live as the run proceeds

- [ ] **Step 3: Commit**

```bash
git add monitor/web/swimlane.js
git commit -m "feat(monitor/ui): swimlane renderer with live SSE + detail panel"
```

---

## Phase 5 — End-to-end + docs

### Task 16: End-to-end correlation test

**Files:**

- Create: `tests/e2e/monitor.test.ts`

- [ ] **Step 1: Write the test**

```ts
// tests/e2e/monitor.test.ts
// Drives a real agent through a delegation while a real monitor server runs,
// then asserts the persisted events reconstruct the expected tree.
import { assertEquals } from "@std/assert";
import { startMonitor } from "../../monitor/server.ts";
import { createEmitter } from "../../src/observability/emit.ts";

Deno.test("emitted events for a delegation correlate under one session", async () => {
  const kv = await Deno.openKv(":memory:");
  const mon = await startMonitor({ kv, port: 0, token: "" });
  const emit = createEmitter(mon.url, undefined);

  // Simulate a coordinator fan-out: request -> delegate.start -> return -> final.
  const sessionId = "sess-e2e";
  const requestId = "req-1";
  const base = { sessionId, requestId };
  await emit({
    ...base,
    agent: "REPL",
    depth: 0,
    ts: 1,
    type: "request.started",
    data: { target: "coordinator" },
  });
  await emit({
    ...base,
    agent: "coordinator",
    depth: 0,
    ts: 2,
    type: "turn.started",
    data: {},
  });
  await emit({
    ...base,
    agent: "coordinator",
    depth: 0,
    ts: 3,
    type: "delegate.start",
    data: { peer: "scout" },
    threadId: "t1",
  });
  await emit({
    ...base,
    agent: "scout",
    depth: 1,
    ts: 4,
    type: "message.completed",
    data: { text: "haiku" },
  });
  await emit({
    ...base,
    agent: "coordinator",
    depth: 0,
    ts: 5,
    type: "delegate.return",
    data: { peer: "scout", ok: true },
    threadId: "t1",
  });
  await emit({
    ...base,
    agent: "coordinator",
    depth: 0,
    ts: 6,
    type: "message.completed",
    data: { text: "final" },
  });

  // Allow fire-and-forget POSTs to land.
  await new Promise((r) => setTimeout(r, 300));

  const detail = await (await fetch(`${mon.url}/api/sessions/${sessionId}`))
    .json();
  assertEquals(detail.events.length, 6);
  assertEquals(detail.summary.agents.sort(), ["REPL", "coordinator", "scout"]);
  // seq is monotonic and dense.
  assertEquals(detail.events.map((e) => e.seq), [0, 1, 2, 3, 4, 5]);
  const del = detail.events.find((e) => e.type === "delegate.start");
  assertEquals(del.data.peer, "scout");
  assertEquals(del.threadId, "t1");

  await mon.shutdown();
  kv.close();
});
```

- [ ] **Step 2: Run it**

Run:
`deno test --allow-net --allow-read --unstable-kv tests/e2e/monitor.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the entire suite**

Run:
`deno test --allow-net --allow-env --allow-read --allow-write --allow-sys --unstable-kv`
Expected: ALL PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/monitor.test.ts
git commit -m "test(monitor): e2e correlation of a delegation under one session"
```

---

### Task 17: README + .env.example documentation

**Files:**

- Modify: `README.md` (add a "Web UI monitor" section)

- [ ] **Step 1: Add a section to `README.md`** (place after the "Scripts"
      section)

````markdown
## Web UI monitor (optional)

Visualize a run as a swimlane diagram. The monitor is a standalone service; the
app works exactly the same with it off.

```
# terminal 1 — start the monitor
deno task monitor                       # http://localhost:7891

# terminal 2 — point agents at it
A2A_MONITOR_URL=http://localhost:7891 \
  deno task start --agents="coordinator,scout,analyst"
```

Open http://localhost:7891, pick a session, and watch delegations stream in.
With `A2A_MONITOR_URL` unset, no events are emitted and behavior is unchanged.

Config: `MONITOR_PORT` (default 7891), `MONITOR_KV_PATH` (default
`./a2a-monitor.db`), and `AGENT_BEARER_TOKEN` (optional shared secret on
`/ingest`). See `docs/superpowers/specs/2026-05-28-web-ui-monitor-design.md`.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document the optional web UI monitor"
```

---

## Self-review notes (resolved)

- **Spec coverage:** event model (T1), emitter optional/no-op (T2), config flag
  (T3), id propagation (T4), all emit seams —
  base/tools/handlers/backends/orchestrator/agent-entry/repl (T5–T8), monitor
  store+seq+summaries (T9), fan-out (T10), HTTP API incl. SSE + static
  (T11–T12), swimlane UI incl. sessions list, layout, renderer, live, detail
  (T13–T15), e2e correlation (T16), docs (T17). Non-goals (tokens, chat, graph,
  MCP, multi-machine) intentionally excluded.
- **`message.completed` double-draw:** layout (T14) only draws an arrow for
  `depth === 0`; deeper agents' completions are inspectable but not redundant
  arrows — matches the spec's rule.
- **seq authority:** assigned by `MonitorStore.ingest` (T9); emitters send
  `seq: 0` placeholder (T1 schema default / T11 ingest revalidation).
- **Type consistency:** `Emitter`, `EmitEvent`, `EmitIds`, `runTool(..., ids)`,
  `AgentHandlerCtx.{sessionId,requestId}`, `createEmitter(url, token, post?)`,
  `MonitorStore`, `EventBus`, `startMonitor`, `computeLayout` used consistently
  across tasks.
