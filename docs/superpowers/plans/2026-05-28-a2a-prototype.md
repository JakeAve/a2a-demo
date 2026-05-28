# A2A Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Deno + TypeScript A2A prototype where a Claude-backed agent delegates work to Ollama-backed agents (and back), discovered via a central registry, with a streaming REPL.

**Architecture:** Single Deno process boots a registry on port 7890 plus N agents on OS-assigned ports. Each agent is a self-contained Hono server exposing `/.well-known/agent.json`, `/message/send`, `/message/stream`. Claude-backed agents inject `list_agents` + `delegate_task` tools so the model autonomously routes work to peers (max delegation depth 2). Conversation history persists in Deno KV by `contextId`. Shared bearer-token auth on all A2A calls.

**Tech Stack:** Deno 2.x, TypeScript, Hono (HTTP), `@std/dotenv`, `@anthropic-ai/sdk`, native `fetch` for Ollama, Deno KV.

**Spec:** `docs/superpowers/specs/2026-05-28-a2a-design.md`

---

## File Structure

```
.env.example                       # template config
deno.json                          # tasks, imports, compiler options
src/
├── main.ts                        # CLI: parse --agents, boot orchestrator
├── orchestrator.ts                # Boot registry + agents + REPL
├── repl.ts                        # Stdin loop, @mention parsing, SSE display
├── config.ts                      # .env loader, parses --agents flag
├── roles.config.ts                # Role presets (sonnet, gemma3, ...)
├── registry/
│   ├── server.ts                  # Hono registry server
│   └── client.ts                  # register/deregister/list helpers
├── agent/
│   ├── base.ts                    # Hono server + A2A routes + middleware
│   ├── claude.ts                  # Anthropic backend handler
│   └── ollama.ts                  # Ollama backend handler
├── protocol/
│   ├── types.ts                   # AgentCard, Message, Part, Task
│   └── client.ts                  # send / stream helpers
└── store/
    └── context.ts                 # Deno KV wrapper
tests/
├── protocol/types.test.ts
├── store/context.test.ts
├── agent/depth-guard.test.ts
├── agent/auth.test.ts
├── registry/registry.test.ts
├── agent/ollama.test.ts
└── e2e/delegation.test.ts
```

---

## Task 1: Project bootstrap

**Files:**
- Create: `deno.json`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `README.md`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "tasks": {
    "start": "deno run --env-file=.env --allow-net --allow-env --allow-read --unstable-kv src/main.ts",
    "test": "deno test --env-file=.env.example --allow-net --allow-env --allow-read --unstable-kv"
  },
  "imports": {
    "@std/dotenv": "jsr:@std/dotenv@^0.225.3",
    "@std/assert": "jsr:@std/assert@^1.0.0",
    "@std/testing": "jsr:@std/testing@^1.0.0",
    "hono": "jsr:@hono/hono@^4.6.0",
    "@anthropic-ai/sdk": "npm:@anthropic-ai/sdk@^0.30.0"
  },
  "compilerOptions": {
    "strict": true,
    "lib": ["deno.window", "deno.unstable"]
  }
}
```

- [ ] **Step 2: Create `.env.example`**

```
REGISTRY_PORT=7890
ANTHROPIC_API_KEY=sk-replace-me
AGENT_BEARER_TOKEN=local-dev-secret
OLLAMA_BASE_URL=http://localhost:11434
```

- [ ] **Step 3: Create `.gitignore`**

```
.env
.DS_Store
deno.lock
```

- [ ] **Step 4: Create `README.md`**

```markdown
# A2A Prototype

Deno-based Agent-to-Agent (A2A) prototype: Claude delegates work to Ollama
peers (and back) over HTTP, discovered via a local registry.

## Run

    cp .env.example .env
    # edit ANTHROPIC_API_KEY
    deno task start --agents="sonnet,gemma3"

See `docs/superpowers/specs/2026-05-28-a2a-design.md` for the design.
```

- [ ] **Step 5: Commit**

```bash
git add deno.json .env.example .gitignore README.md
git commit -m "chore: project bootstrap (deno.json, env template, readme)"
```

---

## Task 2: Protocol types

**Files:**
- Create: `src/protocol/types.ts`
- Test: `tests/protocol/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/protocol/types.test.ts
import { assert, assertEquals } from "@std/assert";
import { isAgentCard, isMessage, type AgentCard, type Message } from "../../src/protocol/types.ts";

Deno.test("isAgentCard accepts a valid card", () => {
  const card: AgentCard = {
    name: "gemma3",
    description: "fast",
    version: "1.0.0",
    url: "http://localhost:1234",
    skills: [{ id: "general", name: "General", description: "anything" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  };
  assert(isAgentCard(card));
});

Deno.test("isAgentCard rejects missing fields", () => {
  assertEquals(isAgentCard({ name: "x" }), false);
  assertEquals(isAgentCard(null), false);
  assertEquals(isAgentCard("string"), false);
});

Deno.test("isMessage accepts a valid text message", () => {
  const m: Message = {
    messageId: "m1",
    role: "user",
    parts: [{ type: "text", text: "hi" }],
  };
  assert(isMessage(m));
});

Deno.test("isMessage rejects bad role", () => {
  assertEquals(isMessage({ messageId: "m1", role: "bad", parts: [] }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test tests/protocol/types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/protocol/types.ts`**

```ts
export type TextPart = { type: "text"; text: string };
export type DataPart = { type: "data"; data: unknown };
export type Part = TextPart | DataPart;

export type Message = {
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  contextId?: string;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
};

export type SecurityScheme = {
  type: "http";
  scheme: "bearer";
};

export type AgentCard = {
  name: string;
  description: string;
  version: string;
  url: string;
  skills: Skill[];
  securitySchemes: Record<string, SecurityScheme>;
  security: Array<Record<string, string[]>>;
};

export type Task = {
  id: string;
  contextId: string;
  status: "submitted" | "working" | "completed" | "failed" | "canceled";
  result?: string;
  error?: string;
};

export function isAgentCard(v: unknown): v is AgentCard {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    typeof o.version === "string" &&
    typeof o.url === "string" &&
    Array.isArray(o.skills) &&
    typeof o.securitySchemes === "object" &&
    Array.isArray(o.security)
  );
}

export function isPart(v: unknown): v is Part {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string";
  if (o.type === "data") return "data" in o;
  return false;
}

export function isMessage(v: unknown): v is Message {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.messageId === "string" &&
    (o.role === "user" || o.role === "agent") &&
    Array.isArray(o.parts) &&
    o.parts.every(isPart)
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test tests/protocol/types.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/protocol/types.ts tests/protocol/types.test.ts
git commit -m "feat(protocol): add A2A type definitions and guards"
```

---

## Task 3: Context store (Deno KV)

**Files:**
- Create: `src/store/context.ts`
- Test: `tests/store/context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/context.test.ts
import { assertEquals } from "@std/assert";
import { ContextStore } from "../../src/store/context.ts";

Deno.test("ContextStore appends and reads in order", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);

  await store.append("ctx1", { role: "user", content: "hi" });
  await store.append("ctx1", { role: "assistant", content: "hello" });
  await store.append("ctx1", { role: "user", content: "how are you" });

  const history = await store.get("ctx1");
  assertEquals(history.length, 3);
  assertEquals(history[0].content, "hi");
  assertEquals(history[2].content, "how are you");
  kv.close();
});

Deno.test("ContextStore isolates contexts", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);
  await store.append("a", { role: "user", content: "from a" });
  await store.append("b", { role: "user", content: "from b" });
  assertEquals((await store.get("a")).length, 1);
  assertEquals((await store.get("b"))[0].content, "from b");
  kv.close();
});

Deno.test("ContextStore.get returns [] for unknown id", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ContextStore(kv);
  assertEquals(await store.get("nope"), []);
  kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test tests/store/context.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/store/context.ts`**

```ts
export type StoredMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export class ContextStore {
  constructor(private kv: Deno.Kv) {}

  async get(contextId: string): Promise<StoredMessage[]> {
    const res = await this.kv.get<StoredMessage[]>(["context", contextId]);
    return res.value ?? [];
  }

  async append(contextId: string, message: StoredMessage): Promise<void> {
    const current = await this.get(contextId);
    current.push(message);
    await this.kv.set(["context", contextId], current);
  }

  async clear(contextId: string): Promise<void> {
    await this.kv.delete(["context", contextId]);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test tests/store/context.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/store/context.ts tests/store/context.test.ts
git commit -m "feat(store): add Deno KV context store"
```

---

## Task 4: Config loader and role presets

**Files:**
- Create: `src/config.ts`
- Create: `src/roles.config.ts`

- [ ] **Step 1: Create `src/roles.config.ts`**

```ts
import type { Skill } from "./protocol/types.ts";

export type Backend = "claude" | "ollama";

export type RolePreset = {
  backend: Backend;
  model: string;
  systemPrompt: string;
  description: string;
  skills: Skill[];
};

export const roles: Record<string, RolePreset> = {
  sonnet: {
    backend: "claude",
    model: "claude-sonnet-4-6",
    description: "Coordinator backed by Claude Sonnet",
    systemPrompt:
      "You are a coordinator. When work would be cheaper or faster on a peer agent, call delegate_task. Otherwise answer directly. Stay concise.",
    skills: [
      { id: "coordinate", name: "Coordinate", description: "Plans and delegates complex tasks" },
    ],
  },
  gemma3: {
    backend: "ollama",
    model: "gemma3",
    description: "Fast local generalist (gemma3 via Ollama)",
    systemPrompt: "You are a fast helper. Answer concisely.",
    skills: [
      { id: "general", name: "General", description: "Cheap general-purpose assistant" },
    ],
  },
  gemma4: {
    backend: "ollama",
    model: "gemma4",
    description: "Stronger local model for harder local work",
    systemPrompt: "You are a careful local model. Think before answering.",
    skills: [
      { id: "reasoning", name: "Reasoning", description: "Local reasoning over text" },
    ],
  },
};
```

- [ ] **Step 2: Create `src/config.ts`**

```ts
import { load } from "@std/dotenv";
import { roles, type RolePreset } from "./roles.config.ts";

export type AppConfig = {
  registryPort: number;
  anthropicApiKey: string;
  bearerToken: string;
  ollamaBaseUrl: string;
};

export type AgentSpec = {
  name: string;       // identity (e.g. "gemma3")
  preset: RolePreset; // role config
  model: string;      // resolved model (preset.model or CLI override)
};

export async function loadConfig(): Promise<AppConfig> {
  await load({ export: true });
  const env = Deno.env.toObject();
  return {
    registryPort: Number(env.REGISTRY_PORT ?? 7890),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    bearerToken: env.AGENT_BEARER_TOKEN ?? "local-dev-secret",
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  };
}

// Parse "sonnet,gemma3:llama3.1,code-reviewer" → AgentSpec[]
export function parseAgentsFlag(raw: string): AgentSpec[] {
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [name, modelOverride] = entry.split(":");
    const preset = roles[name];
    if (!preset) throw new Error(`Unknown role: ${name}. Known: ${Object.keys(roles).join(", ")}`);
    return { name, preset, model: modelOverride ?? preset.model };
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/config.ts src/roles.config.ts
git commit -m "feat(config): add env loader and role presets"
```

---

## Task 5: Registry server

**Files:**
- Create: `src/registry/server.ts`
- Test: `tests/registry/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/registry/registry.test.ts
import { assertEquals } from "@std/assert";
import { startRegistry } from "../../src/registry/server.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card = (name: string, port: number): AgentCard => ({
  name,
  description: "test",
  version: "1.0.0",
  url: `http://localhost:${port}`,
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
});

Deno.test("registry: register, list, get, deregister", async () => {
  const reg = await startRegistry(0); // 0 = OS-assigned
  const base = `http://localhost:${reg.port}`;

  const a = card("alpha", 1111);
  await fetch(`${base}/register`, { method: "POST", body: JSON.stringify(a) });

  const list = await (await fetch(`${base}/agents`)).json();
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "alpha");

  const one = await (await fetch(`${base}/agents/alpha`)).json();
  assertEquals(one.url, "http://localhost:1111");

  await fetch(`${base}/register/alpha`, { method: "DELETE" });
  const after = await (await fetch(`${base}/agents`)).json();
  assertEquals(after.length, 0);

  await reg.shutdown();
});

Deno.test("registry: 404 for unknown agent", async () => {
  const reg = await startRegistry(0);
  const res = await fetch(`http://localhost:${reg.port}/agents/nobody`);
  assertEquals(res.status, 404);
  await res.body?.cancel();
  await reg.shutdown();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test tests/registry/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/registry/server.ts`**

```ts
import { Hono } from "hono";
import { type AgentCard, isAgentCard } from "../protocol/types.ts";

export type RegistryHandle = {
  port: number;
  shutdown(): Promise<void>;
};

export async function startRegistry(port: number): Promise<RegistryHandle> {
  const agents = new Map<string, AgentCard>();
  const app = new Hono();

  app.get("/agents", (c) => c.json([...agents.values()]));

  app.get("/agents/:name", (c) => {
    const card = agents.get(c.req.param("name"));
    return card ? c.json(card) : c.json({ error: "not found" }, 404);
  });

  app.post("/register", async (c) => {
    const body = await c.req.json();
    if (!isAgentCard(body)) return c.json({ error: "invalid agent card" }, 400);
    agents.set(body.name, body);
    return c.json({ ok: true });
  });

  app.delete("/register/:name", (c) => {
    agents.delete(c.req.param("name"));
    return c.json({ ok: true });
  });

  const server = Deno.serve({ port, onListen: () => {} }, app.fetch);
  // Deno.serve resolves addr synchronously
  const actualPort = (server.addr as Deno.NetAddr).port;

  return {
    port: actualPort,
    shutdown: async () => {
      await server.shutdown();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test tests/registry/registry.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/registry/server.ts tests/registry/registry.test.ts
git commit -m "feat(registry): in-memory agent registry server"
```

---

## Task 6: Registry client

**Files:**
- Create: `src/registry/client.ts`

- [ ] **Step 1: Implement `src/registry/client.ts`**

```ts
import type { AgentCard } from "../protocol/types.ts";

export class RegistryClient {
  constructor(private baseUrl: string) {}

  async register(card: AgentCard): Promise<void> {
    const res = await fetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
  }

  async deregister(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/register/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
  }

  async list(): Promise<AgentCard[]> {
    try {
      const res = await fetch(`${this.baseUrl}/agents`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async get(name: string): Promise<AgentCard | null> {
    try {
      const res = await fetch(`${this.baseUrl}/agents/${encodeURIComponent(name)}`);
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/registry/client.ts
git commit -m "feat(registry): registry HTTP client"
```

---

## Task 7: Protocol client (HTTP send / SSE stream)

**Files:**
- Create: `src/protocol/client.ts`

- [ ] **Step 1: Implement `src/protocol/client.ts`**

```ts
import type { Message } from "./types.ts";

export type SendOptions = {
  url: string;             // target agent base URL
  token: string;           // bearer
  depth: number;           // current delegation depth (will be sent as x-depth)
  message: Message;
};

export type SendResult = { text: string };

export async function sendMessage(opts: SendOptions): Promise<SendResult> {
  const res = await fetch(`${opts.url}/message/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${opts.token}`,
      "x-depth": String(opts.depth),
    },
    body: JSON.stringify({ message: opts.message }),
  });
  if (res.status === 429) throw new Error("max delegation depth reached");
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { text: String(json.text ?? "") };
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export async function* streamMessage(opts: SendOptions): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${opts.url}/message/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${opts.token}`,
      "x-depth": String(opts.depth),
      "accept": "text/event-stream",
    },
    body: JSON.stringify({ message: opts.message }),
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `stream failed: ${res.status}` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === "[DONE]") {
        yield { type: "done" };
        return;
      }
      try {
        yield JSON.parse(payload) as StreamEvent;
      } catch {
        // ignore malformed frames
      }
    }
  }
  yield { type: "done" };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/protocol/client.ts
git commit -m "feat(protocol): HTTP send + SSE stream client"
```

---

## Task 8: Base agent server (routes, auth, depth guard)

**Files:**
- Create: `src/agent/base.ts`
- Test: `tests/agent/depth-guard.test.ts`
- Test: `tests/agent/auth.test.ts`

- [ ] **Step 1: Write the depth-guard failing test**

```ts
// tests/agent/depth-guard.test.ts
import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "test", description: "t", version: "1.0.0",
  url: "http://localhost:0",
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

Deno.test("base agent: x-depth >= 2 returns 429", async () => {
  const agent = await startAgent({
    card,
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "delta", text: "ok" }; yield { type: "done" }; },
  });
  const url = `http://localhost:${agent.port}/message/send`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok", "x-depth": "2" },
    body: JSON.stringify({ message: { messageId: "1", role: "user", parts: [] } }),
  });
  assertEquals(res.status, 429);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("base agent: x-depth 0 and 1 allowed", async () => {
  const agent = await startAgent({
    card,
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  for (const d of ["0", "1"]) {
    const res = await fetch(`http://localhost:${agent.port}/message/send`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok", "x-depth": d },
      body: JSON.stringify({ message: { messageId: "1", role: "user", parts: [{ type: "text", text: "hi" }] } }),
    });
    assertEquals(res.status, 200, `depth ${d} should be allowed`);
    await res.body?.cancel();
  }
  await agent.shutdown();
});
```

- [ ] **Step 2: Write the auth failing test**

```ts
// tests/agent/auth.test.ts
import { assertEquals } from "@std/assert";
import { startAgent } from "../../src/agent/base.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card: AgentCard = {
  name: "t", description: "t", version: "1.0.0", url: "http://localhost:0",
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
};

const body = JSON.stringify({ message: { messageId: "1", role: "user", parts: [] } });

Deno.test("auth: missing token returns 401", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/message/send`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-depth": "0" },
    body,
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("auth: wrong token returns 401", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/message/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer nope", "x-depth": "0" },
    body,
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
  await agent.shutdown();
});

Deno.test("auth: agent card is public (no token required)", async () => {
  const agent = await startAgent({
    card, bearerToken: "secret",
    handler: async () => ({ text: "" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });
  const res = await fetch(`http://localhost:${agent.port}/.well-known/agent.json`);
  assertEquals(res.status, 200);
  await res.json();
  await agent.shutdown();
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `deno task test tests/agent/`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/agent/base.ts`**

```ts
import { Hono } from "hono";
import { type AgentCard, isMessage, type Message } from "../protocol/types.ts";
import type { StreamEvent } from "../protocol/client.ts";

export type AgentHandlerCtx = {
  depth: number;
  message: Message;
};

export type AgentConfig = {
  card: AgentCard;
  bearerToken: string;
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  streamHandler: (ctx: AgentHandlerCtx) => AsyncGenerator<StreamEvent>;
};

export type AgentHandle = {
  port: number;
  card: AgentCard;
  shutdown(): Promise<void>;
};

export async function startAgent(cfg: AgentConfig): Promise<AgentHandle> {
  const app = new Hono();

  app.get("/.well-known/agent.json", (c) => c.json(cfg.card));

  app.use("/message/*", async (c, next) => {
    const auth = c.req.header("authorization") ?? "";
    if (auth !== `Bearer ${cfg.bearerToken}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const depth = Number(c.req.header("x-depth") ?? "0");
    if (Number.isNaN(depth) || depth >= 2) {
      return c.json({ error: "max delegation depth reached" }, 429);
    }
    c.set("depth", depth);
    await next();
  });

  app.post("/message/send", async (c) => {
    const body = await c.req.json();
    if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
    const depth = c.get("depth") as number;
    try {
      const result = await cfg.handler({ depth, message: body.message });
      return c.json({ text: result.text });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  app.post("/message/stream", async (c) => {
    const body = await c.req.json();
    if (!isMessage(body?.message)) return c.json({ error: "bad message" }, 400);
    const depth = c.get("depth") as number;

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const write = (ev: StreamEvent) =>
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        try {
          for await (const ev of cfg.streamHandler({ depth, message: body.message })) {
            write(ev);
          }
        } catch (e) {
          write({ type: "error", message: (e as Error).message });
        }
        controller.enqueue(enc.encode(`data: [DONE]\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  });

  const server = Deno.serve({ port: 0, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  const card = { ...cfg.card, url: `http://localhost:${port}` };

  return {
    port,
    card,
    shutdown: async () => {
      await server.shutdown();
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `deno task test tests/agent/`
Expected: 5 passed.

- [ ] **Step 6: Commit**

```bash
git add src/agent/base.ts tests/agent/
git commit -m "feat(agent): base server with auth + depth guard + SSE"
```

---

## Task 9: Ollama backend handler

**Files:**
- Create: `src/agent/ollama.ts`
- Test: `tests/agent/ollama.test.ts`

- [ ] **Step 1: Write the failing test (mocked Ollama)**

```ts
// tests/agent/ollama.test.ts
import { assertEquals } from "@std/assert";
import { makeOllamaHandlers } from "../../src/agent/ollama.ts";
import type { ContextStore } from "../../src/store/context.ts";

function mockStore(): ContextStore {
  const data = new Map<string, unknown[]>();
  return {
    get: async (id: string) => (data.get(id) ?? []) as never,
    append: async (id: string, m: unknown) => {
      const arr = data.get(id) ?? [];
      arr.push(m);
      data.set(id, arr);
    },
    clear: async (id: string) => { data.delete(id); },
  } as unknown as ContextStore;
}

Deno.test("ollama handler: forwards prompt and stores history", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit)?.body ?? "{}"));
    assertEquals(body.model, "gemma3");
    return new Response(JSON.stringify({ message: { content: "hi back" } }), { status: 200 });
  }) as typeof fetch;

  const store = mockStore();
  const { handler } = makeOllamaHandlers({
    model: "gemma3",
    systemPrompt: "be brief",
    baseUrl: "http://localhost:11434",
    store,
  });

  const result = await handler({
    depth: 0,
    message: { messageId: "1", role: "user", parts: [{ type: "text", text: "hi" }], contextId: "c1" },
  });

  assertEquals(result.text, "hi back");
  assertEquals((await store.get("c1")).length, 2);
  globalThis.fetch = origFetch;
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno task test tests/agent/ollama.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/agent/ollama.ts`**

```ts
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";

export type OllamaDeps = {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  store: ContextStore;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function buildMessages(system: string, history: StoredMessage[]): StoredMessage[] {
  return [{ role: "system", content: system }, ...history];
}

export function makeOllamaHandlers(deps: OllamaDeps) {
  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const history = await deps.store.get(contextId);
    const res = await fetch(`${deps.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: buildMessages(deps.systemPrompt, history),
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const text: string = json?.message?.content ?? "";
    await deps.store.append(contextId, { role: "assistant", content: text });
    return { text };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const history = await deps.store.get(contextId);
    const res = await fetch(`${deps.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: deps.model,
        messages: buildMessages(deps.systemPrompt, history),
        stream: true,
      }),
    });
    if (!res.ok || !res.body) {
      yield { type: "error", message: `ollama ${res.status}` };
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const delta: string = obj?.message?.content ?? "";
          if (delta) {
            full += delta;
            yield { type: "delta", text: delta };
          }
        } catch { /* skip */ }
      }
    }
    await deps.store.append(contextId, { role: "assistant", content: full });
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno task test tests/agent/ollama.test.ts`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add src/agent/ollama.ts tests/agent/ollama.test.ts
git commit -m "feat(agent): ollama-backed handler with streaming"
```

---

## Task 10: Claude backend handler (with delegation tools)

**Files:**
- Create: `src/agent/claude.ts`

- [ ] **Step 1: Implement `src/agent/claude.ts`**

```ts
import Anthropic from "@anthropic-ai/sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import type { RegistryClient } from "../registry/client.ts";
import { sendMessage } from "../protocol/client.ts";

export type ClaudeDeps = {
  model: string;
  systemPrompt: string;
  apiKey: string;
  store: ContextStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function toAnthropic(history: StoredMessage[]): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

const TOOLS = [
  {
    name: "list_agents",
    description: "List peer agents available for delegation. Returns name, description, and skills for each.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "delegate_task",
    description: "Delegate a task to a peer agent. Returns the peer's text response. Use when another agent is better suited (cheaper, faster, more specialised). Cannot be called recursively past depth 2.",
    input_schema: {
      type: "object" as const,
      properties: {
        agent: { type: "string", description: "Target agent name as returned by list_agents" },
        prompt: { type: "string", description: "What to ask the peer agent" },
      },
      required: ["agent", "prompt"],
    },
  },
];

export function makeClaudeHandlers(deps: ClaudeDeps) {
  const client = new Anthropic({ apiKey: deps.apiKey });

  async function runTool(name: string, args: Record<string, unknown>, depth: number, contextId: string): Promise<string> {
    if (name === "list_agents") {
      const cards = await deps.registry.list();
      const peers = cards.filter((c) => c.name !== deps.selfName);
      return JSON.stringify(peers.map((c) => ({ name: c.name, description: c.description, skills: c.skills })));
    }
    if (name === "delegate_task") {
      const target = String(args.agent);
      const prompt = String(args.prompt);
      const card = await deps.registry.get(target);
      if (!card) return `error: unknown agent ${target}`;
      try {
        const res = await sendMessage({
          url: card.url,
          token: deps.bearerToken,
          depth: depth + 1,
          message: {
            messageId: crypto.randomUUID(),
            role: "agent",
            parts: [{ type: "text", text: prompt }],
            contextId,
          },
        });
        return res.text;
      } catch (e) {
        return `error: ${(e as Error).message}`;
      }
    }
    return `error: unknown tool ${name}`;
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    // Agentic loop with tool use; bounded to avoid runaway.
    let finalText = "";
    const messages = toAnthropic(await deps.store.get(contextId));

    for (let iter = 0; iter < 5; iter++) {
      const resp = await client.messages.create({
        model: deps.model,
        max_tokens: 1024,
        system: deps.systemPrompt,
        tools: TOOLS,
        messages,
      });

      const textBlocks = resp.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
      const toolBlocks = resp.content.filter((b) => b.type === "tool_use") as Array<{
        type: "tool_use"; id: string; name: string; input: Record<string, unknown>;
      }>;

      if (textBlocks.length) finalText = textBlocks.join("\n");

      if (resp.stop_reason !== "tool_use" || toolBlocks.length === 0) break;

      messages.push({ role: "assistant", content: resp.content as never });
      const toolResults = await Promise.all(
        toolBlocks.map(async (tb) => ({
          type: "tool_result" as const,
          tool_use_id: tb.id,
          content: await runTool(tb.name, tb.input, ctx.depth, contextId),
        })),
      );
      messages.push({ role: "user", content: toolResults as never });
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    // V1: stream only the final answer. Tool turns happen behind the scenes.
    const result = await handler(ctx);
    // chunk by ~40 chars for visible streaming feel
    const chunkSize = 40;
    for (let i = 0; i < result.text.length; i += chunkSize) {
      yield { type: "delta", text: result.text.slice(i, i + chunkSize) };
    }
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/agent/claude.ts
git commit -m "feat(agent): Claude backend with list_agents + delegate_task tools"
```

---

## Task 11: REPL

**Files:**
- Create: `src/repl.ts`

- [ ] **Step 1: Implement `src/repl.ts`**

```ts
import { streamMessage } from "./protocol/client.ts";
import type { AgentCard } from "./protocol/types.ts";

export type ReplDeps = {
  agents: Map<string, AgentCard>; // name → card
  bearerToken: string;
};

const PROMPT = "\n> ";

export async function runRepl(deps: ReplDeps): Promise<void> {
  const decoder = new TextDecoder();
  const contextId = crypto.randomUUID();
  Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));

  for await (const chunk of Deno.stdin.readable) {
    const line = decoder.decode(chunk).trim();
    if (!line) {
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }
    if (line === ":quit" || line === ":q") return;

    const match = line.match(/^@(\S+)\s+(.+)$/);
    if (!match) {
      console.log(`(use @<agent> <prompt>; known: ${[...deps.agents.keys()].join(", ")})`);
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }
    const [, name, prompt] = match;
    const card = deps.agents.get(name);
    if (!card) {
      console.log(`unknown agent: ${name}`);
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }

    const enc = new TextEncoder();
    Deno.stdout.writeSync(enc.encode(`[${name}] `));
    try {
      for await (const ev of streamMessage({
        url: card.url,
        token: deps.bearerToken,
        depth: 0,
        message: {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }],
          contextId,
        },
      })) {
        if (ev.type === "delta") Deno.stdout.writeSync(enc.encode(ev.text));
        else if (ev.type === "error") Deno.stdout.writeSync(enc.encode(`\n[error] ${ev.message}`));
        else if (ev.type === "done") break;
      }
    } catch (e) {
      Deno.stdout.writeSync(enc.encode(`\n[error] ${(e as Error).message}`));
    }
    Deno.stdout.writeSync(enc.encode(PROMPT));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/repl.ts
git commit -m "feat(repl): stdin loop with @mention routing and live SSE"
```

---

## Task 12: Orchestrator

**Files:**
- Create: `src/orchestrator.ts`

- [ ] **Step 1: Implement `src/orchestrator.ts`**

```ts
import { type AppConfig, type AgentSpec } from "./config.ts";
import { startRegistry, type RegistryHandle } from "./registry/server.ts";
import { RegistryClient } from "./registry/client.ts";
import { startAgent, type AgentHandle } from "./agent/base.ts";
import { makeOllamaHandlers } from "./agent/ollama.ts";
import { makeClaudeHandlers } from "./agent/claude.ts";
import { ContextStore } from "./store/context.ts";
import { runRepl } from "./repl.ts";
import type { AgentCard } from "./protocol/types.ts";

export async function runOrchestrator(cfg: AppConfig, specs: AgentSpec[]): Promise<void> {
  const registry: RegistryHandle = await startRegistry(cfg.registryPort);
  const registryClient = new RegistryClient(`http://localhost:${registry.port}`);
  const kv = await Deno.openKv();
  const store = new ContextStore(kv);

  console.log(`[registry]   localhost:${registry.port}`);

  const agents = new Map<string, AgentCard>();
  const handles: AgentHandle[] = [];

  for (const spec of specs) {
    try {
      const baseCard: AgentCard = {
        name: spec.name,
        description: spec.preset.description,
        version: "1.0.0",
        url: "http://localhost:0",
        skills: spec.preset.skills,
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ bearer: [] }],
      };

      const handlers = spec.preset.backend === "claude"
        ? makeClaudeHandlers({
            model: spec.model,
            systemPrompt: spec.preset.systemPrompt,
            apiKey: cfg.anthropicApiKey,
            store,
            registry: registryClient,
            bearerToken: cfg.bearerToken,
            selfName: spec.name,
          })
        : makeOllamaHandlers({
            model: spec.model,
            systemPrompt: spec.preset.systemPrompt,
            baseUrl: cfg.ollamaBaseUrl,
            store,
          });

      const handle = await startAgent({
        card: baseCard,
        bearerToken: cfg.bearerToken,
        handler: handlers.handler,
        streamHandler: handlers.streamHandler,
      });
      await registryClient.register(handle.card);
      handles.push(handle);
      agents.set(spec.name, handle.card);
      console.log(`[${spec.name}]   ${handle.card.url}  (${spec.model})`);
    } catch (e) {
      console.error(`[${spec.name}] failed to start: ${(e as Error).message}`);
    }
  }

  const shutdown = async () => {
    console.log("\nshutting down...");
    for (const h of handles) {
      try { await registryClient.deregister(h.card.name); } catch { /* ignore */ }
      try { await h.shutdown(); } catch { /* ignore */ }
    }
    try { await registry.shutdown(); } catch { /* ignore */ }
    kv.close();
    Deno.exit(0);
  };
  Deno.addSignalListener("SIGINT", shutdown);

  await runRepl({ agents, bearerToken: cfg.bearerToken });
  await shutdown();
}
```

- [ ] **Step 2: Commit**

```bash
git add src/orchestrator.ts
git commit -m "feat(orchestrator): boot registry + agents + REPL"
```

---

## Task 13: CLI entry point

**Files:**
- Create: `src/main.ts`

- [ ] **Step 1: Implement `src/main.ts`**

```ts
import { loadConfig, parseAgentsFlag } from "./config.ts";
import { runOrchestrator } from "./orchestrator.ts";

function getAgentsFlag(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--agents=")) return arg.slice("--agents=".length);
  }
  const i = args.indexOf("--agents");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return "sonnet,gemma3";
}

const cfg = await loadConfig();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args));

if (specs.some((s) => s.preset.backend === "claude") && !cfg.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is required for Claude agents. Set it in .env");
  Deno.exit(1);
}

await runOrchestrator(cfg, specs);
```

- [ ] **Step 2: Commit**

```bash
git add src/main.ts
git commit -m "feat(cli): main entry point"
```

---

## Task 14: End-to-end delegation test

**Files:**
- Test: `tests/e2e/delegation.test.ts`

- [ ] **Step 1: Write the e2e test**

```ts
// tests/e2e/delegation.test.ts
import { assert, assertEquals } from "@std/assert";
import { startRegistry } from "../../src/registry/server.ts";
import { RegistryClient } from "../../src/registry/client.ts";
import { startAgent } from "../../src/agent/base.ts";
import { sendMessage } from "../../src/protocol/client.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

function card(name: string): AgentCard {
  return {
    name, description: "t", version: "1.0.0",
    url: "http://localhost:0",
    skills: [{ id: "x", name: "x", description: "x" }],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
  };
}

Deno.test("e2e: agent A delegates to agent B and gets a result", async () => {
  const reg = await startRegistry(0);
  const regClient = new RegistryClient(`http://localhost:${reg.port}`);
  const token = "tok";

  // B: leaf agent that echoes prompt
  let bReceivedDepth = -1;
  const b = await startAgent({
    card: card("bravo"),
    bearerToken: token,
    handler: async (ctx) => {
      bReceivedDepth = ctx.depth;
      const text = ctx.message.parts.find((p) => p.type === "text")?.text ?? "";
      return { text: `B-echo:${text}` };
    },
    streamHandler: async function* () { yield { type: "done" }; },
  });
  await regClient.register(b.card);

  // A: delegates to B
  const a = await startAgent({
    card: card("alpha"),
    bearerToken: token,
    handler: async (ctx) => {
      const peer = await regClient.get("bravo");
      assert(peer, "bravo should be registered");
      const res = await sendMessage({
        url: peer!.url,
        token,
        depth: ctx.depth + 1,
        message: { messageId: "m2", role: "agent", parts: [{ type: "text", text: "hello-from-A" }] },
      });
      return { text: `A-wraps:${res.text}` };
    },
    streamHandler: async function* () { yield { type: "done" }; },
  });
  await regClient.register(a.card);

  const result = await sendMessage({
    url: a.card.url,
    token,
    depth: 0,
    message: { messageId: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
  });

  assertEquals(result.text, "A-wraps:B-echo:hello-from-A");
  assertEquals(bReceivedDepth, 1);

  await a.shutdown();
  await b.shutdown();
  await reg.shutdown();
});

Deno.test("e2e: depth 2 rejection", async () => {
  const b = await startAgent({
    card: card("bravo"),
    bearerToken: "tok",
    handler: async () => ({ text: "ok" }),
    streamHandler: async function* () { yield { type: "done" }; },
  });

  let threw = false;
  try {
    await sendMessage({
      url: b.card.url,
      token: "tok",
      depth: 2,
      message: { messageId: "m", role: "user", parts: [{ type: "text", text: "x" }] },
    });
  } catch (e) {
    threw = (e as Error).message.includes("max delegation depth");
  }
  assert(threw, "should have rejected depth 2");
  await b.shutdown();
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `deno task test tests/e2e/delegation.test.ts`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/delegation.test.ts
git commit -m "test(e2e): two-agent delegation round-trip and depth guard"
```

---

## Task 15: Manual smoke test (no automation)

**Files:** none (validation only)

- [ ] **Step 1: Pull a model in Ollama**

```bash
ollama pull gemma3
```

- [ ] **Step 2: Configure `.env`**

```bash
cp .env.example .env
# edit ANTHROPIC_API_KEY
```

- [ ] **Step 3: Start the orchestrator**

```bash
deno task start --agents="sonnet,gemma3"
```

Expected output:
```
[registry]   localhost:7890
[sonnet]     http://localhost:<port>  (claude-sonnet-4-6)
[gemma3]     http://localhost:<port>  (gemma3)
>
```

- [ ] **Step 4: Direct prompt to gemma3**

```
> @gemma3 say hello in 5 words
```

Expected: streamed tokens forming a short greeting, then a new prompt.

- [ ] **Step 5: Direct prompt to sonnet that should trigger delegation**

```
> @sonnet ask gemma3 what 2+2 is, then explain why
```

Expected: sonnet calls `delegate_task("gemma3", "what is 2+2?")`, gets `"4"` back, then responds to the user. Watch logs for the delegate_task tool call.

- [ ] **Step 6: Verify depth guard**

In another terminal:
```bash
curl -X POST http://localhost:<sonnet-port>/message/send \
  -H "authorization: Bearer $(grep AGENT_BEARER_TOKEN .env | cut -d= -f2)" \
  -H "x-depth: 2" \
  -H "content-type: application/json" \
  -d '{"message":{"messageId":"x","role":"user","parts":[{"type":"text","text":"hi"}]}}'
```

Expected: HTTP 429.

- [ ] **Step 7: Verify registry survives without orchestrator-managed agents**

Kill the orchestrator (`ctrl-c`), restart with just `--agents="gemma3"`. Verify only gemma3 listed in `curl localhost:7890/agents`.

---

## Self-review notes

- All spec sections covered: registry (Task 5/6), depth guard (Task 8/14), auth (Task 8), Ollama backend (Task 9), Claude backend with delegation tools (Task 10), REPL with @mention + SSE (Task 11), orchestrator boot/shutdown (Task 12), dynamic ports (port 0 in startAgent + startRegistry), Deno KV context (Task 3/9/10), shared bearer token (Task 8/14), roles config with model override (Task 4).
- Standalone-agent CLI (`start:agent`) deliberately deferred per spec's "Open Questions".
- Streaming for Claude is "wait then chunk" rather than true token-by-token — matches spec's V1 decision.
- Test fixtures use mocked Anthropic/Ollama. Real-API verification lives in Task 15 manual smoke.
