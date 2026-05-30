# MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the A2A orchestrator as a self-contained MCP server over stdio
so Claude Code (or any MCP client) can drive A2A agents via the existing raw
delegation tools.

**Architecture:** A new `src/mcp.ts` entry point boots the same scaffolding the
REPL orchestrator uses (registry + configured agents + spawn closure), then runs
an MCP stdio server _instead of_ the REPL. The MCP server is a thin adapter: it
re-exposes the already-transport-neutral tool list from `getTools(deps)` and
routes every MCP `CallTool` to the existing `runTool(deps, ...)`. No new tool
logic — the MCP client acts as a depth-0 driver, exactly the role the REPL plays
today.

**Tech Stack:** Deno, `@modelcontextprotocol/sdk` (npm), the existing
`src/agent/tools.ts` runner, Deno KV.

**Decisions locked (from scoping):**

- **Tool surface:** mirror the raw A2A surface verbatim (`list_agents`,
  `list_my_threads`, `delegate_start`, `delegate_continue`, `reset_thread`, plus
  `spawn_agent`/`list_roles`). No `ask()` convenience wrapper.
- **Process model:** self-contained — `src/mcp.ts` boots its own registry +
  agents. It is the sole orchestrator for that KV/registry while running.
- **`web_search`:** not exposed over MCP (the MCP client has its own search).
  `ToolDeps.search` is left unset.

**Critical gotchas this plan must respect:**

1. **stdout is the MCP wire.** On a stdio transport, the server reads/writes
   JSON-RPC on stdout. The orchestrator's `console.log` lines
   (registry/agent/shutdown) MUST be redirected to stderr in MCP mode, or they
   corrupt the protocol stream.
2. **Child agents inherit stdout.** `spawnAgent` launches children with
   `stdout: "inherit"`
   ([src/orchestrator.ts:88-92](../../../src/orchestrator.ts)). In MCP mode
   their registration lines would also land on the MCP stdout. The setup must
   let MCP mode suppress child stdout (`stdout: "null"`; stderr stays inherited
   so real errors still surface).

---

## File Structure

| File                           | Responsibility                                                                                                          | Action |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------ |
| `deno.json`                    | Add MCP SDK import + `mcp` task                                                                                         | Modify |
| `src/config.ts`                | Host shared `getAgentsFlag` (DRY: used by both entries)                                                                 | Modify |
| `src/main.ts`                  | Use shared `getAgentsFlag`                                                                                              | Modify |
| `src/orchestrator.ts`          | Extract `setupOrchestrator()` returning a reusable `OrchestratorContext`; `runOrchestrator` becomes a thin REPL wrapper | Modify |
| `src/mcp-server.ts`            | MCP adapter: `mcpToolList`, `callMcpTool`, `buildMcpServer`, `runMcpServer` (the "driver", sibling to `repl.ts`)        | Create |
| `src/mcp.ts`                   | MCP entry point: redirect stdout-logging, boot scaffolding, run server, wire shutdown                                   | Create |
| `tests/mcp/mcp-server.test.ts` | Unit tests for the helpers + one in-memory SDK client↔server e2e                                                        | Create |
| `scripts/smoke-mcp.ts`         | Manual end-to-end via a real stdio client launching `deno task mcp`                                                     | Create |
| `README.md` / `TODO.md`        | Document the MCP entry; remove the done TODO entry                                                                      | Modify |

---

## Task 1: Add the MCP SDK dependency

**Files:**

- Modify: `deno.json:8-16` (imports) and `deno.json:2-7` (tasks)

- [ ] **Step 1: Add the SDK import-map prefix and the `mcp` task**

Edit `deno.json`. Add a `mcp` task under `tasks` (mirror `start`'s permissions —
it spawns subprocesses, opens KV, and uses the network):

```json
"tasks": {
  "start": "deno run -A --unstable-kv --env-file=.env src/main.ts",
  "start:agent": "deno run -A --unstable-kv --env-file=.env src/agent-entry.ts",
  "mcp": "deno run -A --unstable-kv --env-file=.env src/mcp.ts",
  "test": "deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --allow-sys --unstable-kv",
  "monitor": "deno run --allow-net --allow-env --allow-read --allow-write --unstable-kv --env-file=.env monitor/main.ts"
},
```

Add the SDK to `imports` (the trailing-slash prefix lets us import SDK subpaths
the Deno way):

```json
"zod": "npm:zod@^4.4.3",
"@modelcontextprotocol/sdk/": "npm:/@modelcontextprotocol/sdk@^1.18.0/"
```

- [ ] **Step 2: Verify the SDK resolves and the symbols we need exist**

Run:
`deno eval 'import { Server } from "@modelcontextprotocol/sdk/server/index.js"; import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"; import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"; import { Client } from "@modelcontextprotocol/sdk/client/index.js"; import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"; console.log(typeof Server, typeof StdioServerTransport, typeof CallToolRequestSchema, typeof Client, typeof InMemoryTransport);'`

Expected: `function function object function function` (the request schemas are
zod objects; classes are functions). If any subpath 404s, the installed major
version differs — run
`deno eval 'console.log((await import("@modelcontextprotocol/sdk/server/index.js")))'`
to inspect, and adjust the version in `deno.json` to the latest `1.x`.

- [ ] **Step 3: Commit**

```bash
git add deno.json deno.lock
git commit -m "build: add @modelcontextprotocol/sdk dependency and mcp task"
```

---

## Task 2: Extract `getAgentsFlag` into config (DRY)

`getAgentsFlag` currently lives only in `src/main.ts`. Both entry points need
it; move it to `config.ts`.

**Files:**

- Modify: `src/config.ts` (add export)
- Modify: `src/main.ts:5-12` (remove local copy, import instead)

- [ ] **Step 1: Add `getAgentsFlag` to `src/config.ts`**

Append to `src/config.ts` (after the existing exports):

```ts
/** Parse the --agents flag (`--agents=a,b` or `--agents a,b`); default "coordinator,scout". */
export function getAgentsFlag(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--agents=")) return arg.slice("--agents=".length);
  }
  const i = args.indexOf("--agents");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return "coordinator,scout";
}
```

- [ ] **Step 2: Update `src/main.ts` to import it**

Replace the top of `src/main.ts` (lines 1-16) so the local `getAgentsFlag` is
removed and the import is used:

```ts
import {
  assertBackendCredentials,
  getAgentsFlag,
  loadConfig,
  parseAgentsFlag,
} from "./config.ts";
import { loadRoles } from "./roles.ts";
import { runOrchestrator } from "./orchestrator.ts";

const cfg = await loadConfig();
const roles = await loadRoles();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles);
```

(Keep the existing `assertBackendCredentials` try/catch and
`await runOrchestrator(...)` lines that follow.)

- [ ] **Step 3: Verify the existing suite still passes**

Run: `deno task test` Expected: PASS (same count as before; this is a pure
refactor).

- [ ] **Step 4: Commit**

```bash
git add src/config.ts src/main.ts
git commit -m "refactor: move getAgentsFlag into config for reuse"
```

---

## Task 3: Extract `setupOrchestrator` from `runOrchestrator`

Split the orchestrator into (a) `setupOrchestrator()` that boots everything and
returns a reusable `OrchestratorContext`, and (b) `runOrchestrator()` that calls
setup + the REPL. This lets the MCP entry reuse identical boot logic without the
REPL. Also make child-process stdout configurable so MCP mode can suppress it.

**Files:**

- Modify: `src/orchestrator.ts` (whole file)

- [ ] **Step 1: Replace `src/orchestrator.ts` with the extracted version**

Rewrite `src/orchestrator.ts`. Keep all imports as-is, then:

```ts
export type OrchestratorContext = {
  registryClient: RegistryClient;
  store: ContextStore;
  threads: ThreadStore;
  agents: Map<string, AgentCard>;
  spawnAgent: (
    role: string,
    name?: string,
    model?: string,
  ) => Promise<SpawnResult>;
  availableRoles: () => Array<
    { name: string; description: string; backend: string; defaultModel: string }
  >;
  emit: ReturnType<typeof createEmitter>;
  bearerToken: string;
  registryPort: number;
  /** Idempotent cleanup: deregister + kill children + shut down agents/registry + close KV. Does NOT exit the process. */
  shutdown: () => Promise<void>;
};

export type SetupOpts = {
  /** stdio mode for spawned child agents. "null" suppresses their stdout (use in MCP mode). Default "inherit". */
  childStdout?: "inherit" | "null";
};

export async function setupOrchestrator(
  cfg: AppConfig,
  specs: AgentSpec[],
  roles: Record<string, RolePreset>,
  opts: SetupOpts = {},
): Promise<OrchestratorContext> {
  const childStdout = opts.childStdout ?? "inherit";
  const registry: RegistryHandle = await startRegistry(cfg.registryPort);
  const registryClient = new RegistryClient(
    `http://localhost:${registry.port}`,
  );
  const kv = await Deno.openKv();
  const emit = createEmitter(cfg.monitorUrl || undefined, cfg.bearerToken);
  const resolveMaxDepth = async () =>
    cfg.maxDepth > 0
      ? cfg.maxDepth
      : Math.max(2, (await registryClient.list()).length);
  const store = new ContextStore(kv);
  const threads = new ThreadStore(kv);
  const sessions = new SessionStore(kv);

  console.log(`[registry]   localhost:${registry.port}`);

  const agents = new Map<string, AgentCard>();
  const handles: AgentHandle[] = [];
  const children = new Map<string, Deno.ChildProcess>();

  const availableRoles = () =>
    Object.entries(roles).map(([name, r]) => ({
      name,
      description: r.description,
      backend: r.backend,
      defaultModel: r.model,
    }));

  const spawnAgent = async (
    role: string,
    customName?: string,
    modelOverride?: string,
  ): Promise<SpawnResult> => {
    const preset = roles[role];
    if (!preset) return { ok: false, error: `unknown role ${role}` };
    const name = customName ?? role;
    if (agents.has(name) || children.has(name)) {
      return { ok: false, error: `agent "${name}" already running` };
    }
    const perms = [
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "--unstable-kv",
    ];
    if (preset.backend === "claude-code") {
      perms.push("--allow-run", "--allow-write", "--allow-sys");
    }
    const args = [
      "run",
      "--env-file=.env",
      ...perms,
      "src/agent-entry.ts",
      `--role=${role}`,
      `--name=${name}`,
      `--registry=http://localhost:${registry.port}`,
    ];
    if (modelOverride) args.push(`--model=${modelOverride}`);
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args,
        stdout: childStdout,
        stderr: "inherit",
      }).spawn();
      children.set(name, child);
      const ok = await waitForRegistration(registryClient, name);
      if (!ok) {
        try {
          child.kill("SIGTERM");
        } catch { /* ignore */ }
        children.delete(name);
        return {
          ok: false,
          error: `agent "${name}" failed to register within timeout`,
        };
      }
      const card = await registryClient.get(name);
      if (card) agents.set(name, card);
      console.log(`[${name}]   spawned (${preset.backend}/${role})`);
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

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

      const handlers = await buildHandlers({
        model: spec.model,
        preset: spec.preset,
        cfg,
        store,
        threads,
        sessions,
        registry: registryClient,
        selfName: spec.name,
        spawnAgent,
        availableRoles,
        emit,
      });

      const handle = await startAgent({
        card: baseCard,
        bearerToken: cfg.bearerToken,
        handler: handlers.handler,
        streamHandler: handlers.streamHandler,
        emit,
        maxDepth: resolveMaxDepth,
      });
      await registryClient.register(handle.card);
      handles.push(handle);
      agents.set(spec.name, handle.card);
      console.log(`[${spec.name}]   ${handle.card.url}  (${spec.model})`);
    } catch (e) {
      console.error(`[${spec.name}] failed to start: ${(e as Error).message}`);
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down...");
    for (const [name, child] of children) {
      try {
        await registryClient.deregister(name);
      } catch { /* ignore */ }
      try {
        child.kill("SIGTERM");
      } catch { /* ignore */ }
    }
    for (const h of handles) {
      try {
        await registryClient.deregister(h.card.name);
      } catch { /* ignore */ }
      try {
        await h.shutdown();
      } catch { /* ignore */ }
    }
    try {
      await registry.shutdown();
    } catch { /* ignore */ }
    kv.close();
  };

  return {
    registryClient,
    store,
    threads,
    agents,
    spawnAgent,
    availableRoles,
    emit,
    bearerToken: cfg.bearerToken,
    registryPort: registry.port,
    shutdown,
  };
}

export async function runOrchestrator(
  cfg: AppConfig,
  specs: AgentSpec[],
  roles: Record<string, RolePreset>,
): Promise<void> {
  const ctx = await setupOrchestrator(cfg, specs, roles);
  Deno.addSignalListener("SIGINT", () => {
    ctx.shutdown().then(() => Deno.exit(0));
  });
  await runRepl({
    agents: ctx.agents,
    bearerToken: ctx.bearerToken,
    emit: ctx.emit,
  });
  await ctx.shutdown();
  Deno.exit(0);
}
```

> Two behavior-preserving changes to note: `buildHandlers` is now `await`ed (it
> is `async` — the original `runOrchestrator` already called it without await,
> which worked only because the returned promise resolved before first use;
> awaiting is correct and matches `agent-entry.ts:77`). And `shutdown()` no
> longer calls `Deno.exit` itself — the caller does, so both entry points
> control their own exit.

- [ ] **Step 2: Verify nothing regressed**

Run: `deno task test` Expected: PASS (no test drives `runOrchestrator` directly;
e2e tests use `startAgent`).

- [ ] **Step 3: Smoke the REPL path still boots**

Run: `printf ':q\n' | deno task start --agents="scout" 2>&1 | head -5` Expected:
prints `[registry] localhost:7890`, `[scout] http://...`, then exits cleanly on
`:q`. (Requires Ollama for `scout`; if unavailable, substitute a role you can
run, or skip — the unit suite already covers correctness.)

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts
git commit -m "refactor: extract setupOrchestrator for reuse by non-REPL drivers"
```

---

## Task 4: MCP adapter helpers (`src/mcp-server.ts`)

The pure, testable core: convert the existing tool list to MCP's `inputSchema`
shape, and route a tool call through `runTool`. The MCP client is a depth-0
driver, so we pass `depth = 0` (delegations then go out at depth 1, exactly like
the REPL).

**Files:**

- Create: `src/mcp-server.ts`
- Test: `tests/mcp/mcp-server.test.ts`

- [ ] **Step 1: Write the failing unit tests**

Create `tests/mcp/mcp-server.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { callMcpTool, mcpToolList } from "../../src/mcp-server.ts";
import type { ToolDeps } from "../../src/agent/tools.ts";
import { RegistryClient } from "../../src/registry/client.ts";
import type { EmitEvent } from "../../src/observability/events.ts";

// A registry stub serving an empty agent list on /agents.
function emptyRegistry(): {
  client: RegistryClient;
  stop: () => Promise<void>;
} {
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
  return {
    client: new RegistryClient(`http://localhost:${port}`),
    stop: () => server.shutdown(),
  };
}

function depsFor(registry: RegistryClient, events: EmitEvent[]): ToolDeps {
  return {
    store: null as never,
    threads: null as never,
    registry,
    bearerToken: "t",
    selfName: "mcp",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    // spawnAgent/availableRoles omitted -> spawn tools should NOT be listed.
  };
}

Deno.test("mcpToolList without spawn deps lists only base tools, in MCP inputSchema shape", () => {
  const deps = depsFor(new RegistryClient("http://localhost:1"), []);
  const tools = mcpToolList(deps);
  const names = tools.map((t) => t.name);
  assertEquals(names, [
    "list_agents",
    "list_my_threads",
    "delegate_start",
    "delegate_continue",
    "reset_thread",
  ]);
  // Each tool carries an MCP-shaped JSON Schema under inputSchema (not `parameters`).
  const start = tools.find((t) => t.name === "delegate_start")!;
  assertEquals(start.inputSchema.type, "object");
  assert(start.inputSchema.required.includes("agent"));
});

Deno.test("mcpToolList with spawn deps adds spawn_agent and list_roles", () => {
  const deps = depsFor(new RegistryClient("http://localhost:1"), []);
  deps.spawnAgent = () => Promise.resolve({ ok: true, name: "x" });
  deps.availableRoles = () => [];
  const names = mcpToolList(deps).map((t) => t.name);
  assert(names.includes("spawn_agent"));
  assert(names.includes("list_roles"));
});

Deno.test("callMcpTool routes to runTool and wraps the result as text content", async () => {
  const reg = emptyRegistry();
  const events: EmitEvent[] = [];
  const deps = depsFor(reg.client, events);

  const res = await callMcpTool(deps, "ctx-1", "sess-1", "list_agents", {});
  await reg.stop();

  assertEquals(res.content, [{ type: "text", text: "[]" }]);
  assertEquals(res.isError, undefined);
  // It emitted a tool.call carrying the MCP session/request ids and selfName.
  const call = events.find((e) => e.type === "tool.call")!;
  assertEquals(call.data.tool, "list_agents");
  assertEquals(call.sessionId, "sess-1");
  assertEquals(call.agent, "mcp");
});

Deno.test("callMcpTool flags an error result with isError", async () => {
  const reg = emptyRegistry();
  const deps = depsFor(reg.client, []);
  // Unknown tool -> runTool returns {"error":"unknown tool ..."} JSON, never throws.
  const res = await callMcpTool(deps, "ctx-1", "sess-1", "nope", {});
  await reg.stop();
  assertEquals(res.isError, true);
  assert(res.content[0].text.includes("unknown tool"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run:
`deno test tests/mcp/mcp-server.test.ts --allow-net --allow-env --allow-read --unstable-kv`
Expected: FAIL — `Module not found "src/mcp-server.ts"`.

- [ ] **Step 3: Implement `src/mcp-server.ts`**

Create `src/mcp-server.ts`:

```ts
// MCP adapter / driver. Sibling to repl.ts: where the REPL drives agents via
// @mentions on stdin, this drives them by exposing the raw A2A delegation tools
// to an MCP client. The client acts as the depth-0 driver, so runTool is called
// with depth 0 (delegations then go out at depth 1, exactly like the REPL).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type BaseTool,
  getTools,
  runTool,
  type ToolDeps,
} from "./agent/tools.ts";
import type { OrchestratorContext } from "./orchestrator.ts";

export type McpTool = {
  name: string;
  description: string;
  inputSchema: BaseTool["parameters"];
};

export type McpToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/** The MCP tool list = the existing transport-neutral tools, reshaped to MCP's `inputSchema` key. */
export function mcpToolList(deps: ToolDeps): McpTool[] {
  return getTools(deps).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters,
  }));
}

/** Run one tool via the shared runner and wrap it as an MCP tool result. runTool never throws
 *  (it returns an {error} JSON on failure), so we detect that to set isError. */
export async function callMcpTool(
  deps: ToolDeps,
  contextId: string,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const text = await runTool(deps, name, args, 0, contextId, {
    sessionId,
    requestId: crypto.randomUUID(),
  });
  let isError = false;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      isError = true;
    }
  } catch { /* non-JSON result is a success */ }
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/** Build (but do not connect) an MCP Server wired to these deps. Split out so tests can
 *  attach an in-memory transport instead of stdio. */
export function buildMcpServer(
  deps: ToolDeps,
  contextId: string,
  sessionId: string,
): Server {
  const server = new Server(
    { name: "a2a", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(
    ListToolsRequestSchema,
    () => ({ tools: mcpToolList(deps) }),
  );
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    callMcpTool(
      deps,
      contextId,
      sessionId,
      req.params.name,
      (req.params.arguments ?? {}) as Record<string, unknown>,
    ));
  return server;
}

/** Build a ToolDeps for the MCP driver from a booted orchestrator context.
 *  selfName "mcp" identifies the driver in emitted events / the monitor.
 *  web_search is intentionally not exposed (search left unset). */
export function mcpToolDeps(ctx: OrchestratorContext): ToolDeps {
  return {
    store: ctx.store,
    threads: ctx.threads,
    registry: ctx.registryClient,
    bearerToken: ctx.bearerToken,
    selfName: "mcp",
    emit: ctx.emit,
    spawnAgent: ctx.spawnAgent,
    availableRoles: ctx.availableRoles,
  };
}

/** Run the MCP server on stdio until the client disconnects (stdin closes). */
export async function runMcpServer(ctx: OrchestratorContext): Promise<void> {
  const deps = mcpToolDeps(ctx);
  const contextId = crypto.randomUUID(); // one session/thread namespace per server lifetime
  const server = buildMcpServer(deps, contextId, contextId);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run:
`deno test tests/mcp/mcp-server.test.ts --allow-net --allow-env --allow-read --unstable-kv`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts tests/mcp/mcp-server.test.ts
git commit -m "feat(mcp): A2A tool adapter (mcpToolList, callMcpTool, buildMcpServer)"
```

---

## Task 5: End-to-end test over an in-memory MCP transport

Prove the real SDK wiring works: a real `Client` linked to `buildMcpServer`'s
`Server` via the SDK's in-memory transport, listing tools and calling one for
real.

**Files:**

- Modify: `tests/mcp/mcp-server.test.ts` (append)

- [ ] **Step 1: Append the e2e test**

Add to `tests/mcp/mcp-server.test.ts`:

```ts
import { buildMcpServer } from "../../src/mcp-server.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

Deno.test("e2e: an MCP client lists tools and calls list_agents through the server", async () => {
  const reg = emptyRegistry();
  const deps = depsFor(reg.client, []);

  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const server = buildMcpServer(deps, "ctx-e2e", "sess-e2e");
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" }, {
    capabilities: {},
  });
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  assert(names.includes("delegate_start"));
  assert(names.includes("list_agents"));

  const result = await client.callTool({ name: "list_agents", arguments: {} });
  assertEquals((result.content as { type: string; text: string }[])[0], {
    type: "text",
    text: "[]",
  });

  await client.close();
  await server.close();
  await reg.stop();
});
```

- [ ] **Step 2: Run to verify it passes**

Run:
`deno test tests/mcp/mcp-server.test.ts --allow-net --allow-env --allow-read --unstable-kv`
Expected: PASS (5 tests total).

- [ ] **Step 3: Run the full suite**

Run: `deno task test` Expected: PASS (prior count + 5).

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/mcp-server.test.ts
git commit -m "test(mcp): e2e client<->server over in-memory transport"
```

---

## Task 6: MCP entry point (`src/mcp.ts`)

Boot the scaffolding (no REPL) and run the server. Redirect all in-process
orchestrator logging off stdout (stdout is the MCP wire), and suppress
child-agent stdout via `childStdout: "null"`.

**Files:**

- Create: `src/mcp.ts`

- [ ] **Step 1: Implement `src/mcp.ts`**

Create `src/mcp.ts`:

```ts
// MCP entry point. Run with:
//
//   deno task mcp --agents="coordinator,scout,analyst"
//
// Boots the same scaffolding as the REPL orchestrator (registry + agents +
// spawn closure) but serves an MCP stdio server instead of the REPL. This
// process is the sole orchestrator for its registry/KV while running.
//
// CRITICAL: on a stdio transport, stdout carries the MCP JSON-RPC stream.
// Anything else written to stdout corrupts the protocol. So:
//   1. We redirect console.log -> console.error (the orchestrator logs
//      registry/agent/shutdown lines via console.log).
//   2. setupOrchestrator is told childStdout:"null" so spawned agents' stdout
//      can't reach our stdout either (their stderr still surfaces real errors).
console.log = (...args: unknown[]) => console.error(...args);

import {
  assertBackendCredentials,
  getAgentsFlag,
  loadConfig,
  parseAgentsFlag,
} from "./config.ts";
import { loadRoles } from "./roles.ts";
import { setupOrchestrator } from "./orchestrator.ts";
import { runMcpServer } from "./mcp-server.ts";

const cfg = await loadConfig();
const roles = await loadRoles();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles);

try {
  assertBackendCredentials(specs, cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}

const ctx = await setupOrchestrator(cfg, specs, roles, { childStdout: "null" });

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await ctx.shutdown();
  } catch { /* ignore */ }
  Deno.exit(0);
};
Deno.addSignalListener("SIGINT", () => {
  void shutdown();
});
Deno.addSignalListener("SIGTERM", () => {
  void shutdown();
});

console.error("[mcp] A2A MCP server ready on stdio");
await runMcpServer(ctx); // resolves when the client disconnects
await shutdown();
```

- [ ] **Step 2: Type-check the new entry**

Run: `deno check src/mcp.ts` Expected: no errors.

- [ ] **Step 3: Confirm stdout stays clean (manual smoke without a client)**

Run:
`printf '' | deno task mcp --agents="scout" 1>/tmp/a2a-mcp-stdout.txt 2>/tmp/a2a-mcp-stderr.txt; echo "stdout bytes: $(wc -c < /tmp/a2a-mcp-stdout.txt)"; echo "--- stderr head ---"; head -5 /tmp/a2a-mcp-stderr.txt`

Expected: **`stdout bytes: 0`** (nothing leaked to the MCP wire — this is the
key assertion), and stderr shows `[registry] ...`, `[scout] ...`,
`[mcp] A2A MCP server ready on stdio`. With empty stdin the transport closes
immediately and the process exits. (Requires Ollama for `scout`; otherwise pick
a runnable role — the point is only that stdout is empty.)

- [ ] **Step 4: Commit**

```bash
git add src/mcp.ts
git commit -m "feat(mcp): stdio entry point booting a self-contained orchestrator"
```

---

## Task 7: Manual end-to-end smoke script

A runnable check that launches the real server as a subprocess over stdio (the
way Claude Code will), lists tools, and calls one — proving the full stdio path,
not just in-memory.

**Files:**

- Create: `scripts/smoke-mcp.ts`

- [ ] **Step 1: Implement `scripts/smoke-mcp.ts`**

Create `scripts/smoke-mcp.ts`:

```ts
// Manual end-to-end smoke for the MCP server over a real stdio subprocess.
//
//   deno run -A --unstable-kv --env-file=.env scripts/smoke-mcp.ts
//
// Launches `deno run src/mcp.ts --agents=scout`, connects an MCP client over
// stdio, lists tools, and calls list_agents. Prints PASS/FAIL.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: Deno.execPath(),
  args: [
    "run",
    "-A",
    "--unstable-kv",
    "--env-file=.env",
    "src/mcp.ts",
    "--agents=scout",
  ],
});

const client = new Client({ name: "smoke-mcp", version: "1.0.0" }, {
  capabilities: {},
});
await client.connect(transport);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
if (!tools.tools.some((t) => t.name === "delegate_start")) {
  console.error("FAIL: delegate_start not advertised");
  await client.close();
  Deno.exit(1);
}

const res = await client.callTool({ name: "list_agents", arguments: {} });
const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
console.log("list_agents ->", text);

await client.close();
console.log("PASS");
Deno.exit(0);
```

- [ ] **Step 2: Run the smoke (requires Ollama for the `scout` role)**

Run: `deno run -A --unstable-kv --env-file=.env scripts/smoke-mcp.ts` Expected:
prints the tool names (including `delegate_start`), `list_agents -> [...]`
(peers minus self), then `PASS`. (If Ollama isn't running, swap `--agents=scout`
for a role you can boot; the smoke only needs one registered agent.)

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-mcp.ts
git commit -m "test(mcp): stdio subprocess smoke script"
```

---

## Task 8: Documentation

**Files:**

- Modify: `README.md` (add an MCP section; update the roadmap bullet)
- Modify: `TODO.md` (remove the now-done "MCP wrapping" entry)

- [ ] **Step 1: Add an MCP section to `README.md`**

Insert after the "Web UI monitor (optional)" section (before "Configuration"):

```markdown
## MCP server (drive A2A from Claude Code)

Expose the orchestrator as an MCP server over stdio, so Claude Code (or any MCP
client) can call A2A agents through the raw delegation tools — instead of the
`@agent` REPL.

    deno task mcp --agents="coordinator,scout,analyst"

This boots a self-contained orchestrator (registry + the named agents) and
serves MCP on stdin/stdout. It is the sole orchestrator for its registry/KV
while running — don't run `deno task start` against the same registry port
(`REGISTRY_PORT`, default 7890) or default Deno KV at the same time.

Register it with Claude Code:

    claude mcp add a2a -- deno run -A --unstable-kv --env-file=.env \
      /abs/path/to/a2a/src/mcp.ts --agents="coordinator,scout,analyst"

The client sees the raw A2A surface as MCP tools: `list_agents`,
`list_my_threads`, `delegate_start`, `delegate_continue`, `reset_thread`, and
(when an orchestrator-backed spawn closure is present, which it always is here)
`spawn_agent` / `list_roles`. The client is the depth-0 driver, so its
`delegate_*` calls reach peers at depth 1 — identical to the REPL. With
`A2A_MONITOR_URL` set, MCP-driven runs appear in the swimlane monitor under the
`mcp` lane.

Note: tool calls are blocking request/response — `delegate_*` returns the peer's
final text (no token streaming over MCP).
```

- [ ] **Step 2: Update the roadmap bullet in `README.md`**

In the "Design + roadmap" list, change the `TODO.md` line so it no longer lists
MCP wrapping as a follow-up:

```markdown
- `TODO.md` — follow-ups: thread-browser CLI, multi-machine, agent-card
  consolidation, others
```

- [ ] **Step 3: Remove the done entry from `TODO.md`**

Delete the entire "## MCP wrapping" section (`TODO.md:6-19`, through the blank
line before "## Thread browser CLI").

- [ ] **Step 4: Verify docs reference real commands**

Run: `grep -n "deno task mcp\|claude mcp add" README.md` Expected: both present.
Confirm `deno task mcp` exists: `deno task 2>&1 | grep mcp` → shows the `mcp`
task.

- [ ] **Step 5: Final full-suite run**

Run: `deno task test` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md TODO.md
git commit -m "docs(mcp): document the MCP server entry; drop done TODO"
```

---

## Self-Review notes

- **Spec coverage:** TODO's required surface — `delegate_start`,
  `delegate_continue`, `list_agents`, `list_my_threads`, `spawn_agent`,
  `reset_thread` — all flow through `getTools(deps)` →
  `mcpToolList`/`callMcpTool` (Task 4), verified by the unit test asserting the
  exact name list and the spawn-tools test. "New entry point that speaks MCP
  over stdio" = Task 6. "Reuses the existing orchestrator process / in-process
  registry + tool runner" = Tasks 3+6 (self-contained boot) + the `runTool`
  reuse in Task 4.
- **Type consistency:** `OrchestratorContext`/`SetupOpts` (Task 3) are consumed
  unchanged by `mcpToolDeps`/`runMcpServer` (Task 4). `mcpToolList` returns
  `McpTool` with `inputSchema: BaseTool["parameters"]`; `BaseTool` is already
  exported from `tools.ts`. `callMcpTool` signature
  `(deps, contextId, sessionId, name, args)` matches every call site (tests,
  `buildMcpServer`).
- **Deferred / out of scope (intentionally):** no `ask()` convenience tool
  (locked: mirror raw surface); `web_search` not exposed (`search` unset); no
  token streaming over MCP (tool calls are blocking — documented).
  Multi-machine, agent-card consolidation, thread-browser CLI remain separate
  TODO entries.
- **Version risk:** the only external unknown is the installed
  `@modelcontextprotocol/sdk` major (Task 1 Step 2 verifies the import subpaths
  before any code depends on them). If the org pins a different major, adjust
  subpaths there.

```
```
