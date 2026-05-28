# claude-code Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `claude-code` agent backend that runs Claude agents through the Claude Agent SDK, authenticating with a Claude subscription OAuth token (falling back to an Anthropic API key), with full A2A tool parity — alongside the existing API-key `claude` backend.

**Architecture:** A new backend value `"claude-code"` joins `"claude"` and `"ollama"`. Its handler module drives the Agent SDK's `query()` with the `claude_code` system-prompt preset, exposes the existing A2A tool runner to the SDK as an in-process MCP server, and continues conversations via SDK session resume keyed by A2A `contextId`. Credentials flow by environment inheritance; the backend passes exactly one resolved credential to the subprocess.

**Tech Stack:** Deno + TypeScript, `@anthropic-ai/claude-agent-sdk` (npm), `zod` (npm), Deno KV, Hono (existing), `@std/assert` for tests.

**Spec:** `docs/superpowers/specs/2026-05-28-claude-code-backend-design.md`

---

## File Structure

- **Create** `src/agent/claude-code.ts` — `makeClaudeCodeHandlers()` + `resolveClaudeCodeEnv()`; drives `query()`, maps the stream to A2A `{handler, streamHandler}`.
- **Create** `src/agent/claude-code-tools.ts` — `buildA2aMcpServer()`, `a2aToolNames()`, `makeToolHandler()`; bridges the existing `runTool` to the SDK as in-process MCP tools.
- **Create** `src/agent/handlers.ts` — shared `buildHandlers()` factory; the single 3-way backend switch used by both call sites.
- **Create** `src/store/sessions.ts` — `SessionStore`; KV map `contextId → session_id`.
- **Create** `agents/opus-sub.json` — example `claude-code` role.
- **Modify** `src/roles.ts` — add `"claude-code"` to `Backend` + validation.
- **Modify** `agents/role.schema.json` — add `"claude-code"` to the `backend` enum.
- **Modify** `src/config.ts` — add `claudeCodeOauthToken`; add `assertBackendCredentials()` helper.
- **Modify** `src/main.ts`, `src/agent-entry.ts` — use `assertBackendCredentials()` + `buildHandlers()` + `SessionStore`.
- **Modify** `src/orchestrator.ts` — use `buildHandlers()` + `SessionStore`; add subprocess permission flags for `claude-code`.
- **Modify** `deno.json` — add SDK + zod imports; add `--allow-run/--allow-write/--allow-sys` to relevant tasks.
- **Modify** `README.md` — auth/cost section + "prefer Ollama under Claude Code" guidance.
- **Modify** `scripts/smoke.ts` — optional `claude-code` round-trip gated on a credential.
- **Test** `tests/roles.test.ts`, `tests/config.test.ts` (new), `tests/store/sessions.test.ts` (new), `tests/agent/claude-code-tools.test.ts` (new), `tests/agent/claude-code.test.ts` (new), `tests/agent/handlers.test.ts` (new).

---

## Task 0: Deno + Agent SDK spike (GATE — do not proceed until green)

The SDK is Node-first and spawns a bundled `claude` binary. Prove it runs under Deno with the OAuth token before building anything. This is throwaway code.

**Files:**
- Create (temporary): `scripts/spike-agent-sdk.ts`

- [ ] **Step 1: Add the SDK + zod imports to `deno.json`**

In `deno.json`, add these two lines to the `imports` object (versions confirmed live: SDK `0.3.154`, zod `4.4.3`; the SDK peers on `zod@^4` and `@anthropic-ai/sdk@>=0.93.0`):

```json
    "@anthropic-ai/claude-agent-sdk": "npm:@anthropic-ai/claude-agent-sdk@^0.3.154",
    "zod": "npm:zod@^4.4.3"
```

> NOTE: The existing `@anthropic-ai/sdk@^0.30.0` pin stays for `claude.ts`. If Deno reports a peer-version conflict during this spike, bump `@anthropic-ai/sdk` to `^0.93.0` and re-run the existing tests (`deno task test`) to confirm `claude.ts` still type-checks. Record the outcome in the commit message.

- [ ] **Step 2: Write the spike script**

Create `scripts/spike-agent-sdk.ts`:

```ts
// THROWAWAY spike: proves @anthropic-ai/claude-agent-sdk runs under Deno
// with a subscription token. Delete after Task 0.
import { query } from "@anthropic-ai/claude-agent-sdk";

const token = Deno.env.get("CLAUDE_CODE_OAUTH_TOKEN");
const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
const env = { ...Deno.env.toObject() };
if (token) { env.CLAUDE_CODE_OAUTH_TOKEN = token; delete env.ANTHROPIC_API_KEY; }
else if (apiKey) { env.ANTHROPIC_API_KEY = apiKey; delete env.CLAUDE_CODE_OAUTH_TOKEN; }
else { console.error("set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY"); Deno.exit(2); }

for await (const msg of query({
  prompt: "Reply with exactly the word: PONG",
  options: {
    systemPrompt: { type: "preset", preset: "claude_code", append: "Be terse." },
    model: "claude-opus-4-8",
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    env,
  },
})) {
  if (msg.type === "system" && msg.subtype === "init") {
    console.log("[init] model:", msg.model, "session:", msg.session_id);
  } else if (msg.type === "assistant") {
    console.log("[assistant]", JSON.stringify(msg.message.content));
  } else if (msg.type === "result") {
    console.log("[result]", msg.subtype, "->", "result" in msg ? msg.result : msg.errors);
  }
}
```

- [ ] **Step 3: Run the spike**

Run: `deno run --env-file=.env --allow-net --allow-env --allow-read --allow-run --allow-write --allow-sys scripts/spike-agent-sdk.ts`

Expected: an `[init]` line with a model + session id, an `[assistant]` line containing `PONG`, and `[result] success -> PONG`.

**If the bundled binary path fails to resolve** (error mentions a missing `claude` executable): add `pathToClaudeCodeExecutable` to the `options` pointing at the binary under the Deno npm cache (`~/Library/Caches/deno/npm/registry.npmjs.org/@anthropic-ai/claude-agent-sdk/*/`), re-run, and record the resolved path approach in the commit message so later tasks can reuse it.

- [ ] **Step 4: Decision gate**

If the spike cannot be made to print `PONG` after the `pathToClaudeCodeExecutable` fallback, STOP and report back — the design's transport assumption is invalid and needs revisiting before further work.

- [ ] **Step 5: Delete the spike and commit the deps**

```bash
rm scripts/spike-agent-sdk.ts
git add deno.json deno.lock
git commit -m "build: add claude-agent-sdk + zod deps (Deno spike verified)"
```

---

## Task 1: Add `claude-code` to the Backend type

**Files:**
- Modify: `src/roles.ts:9`, `src/roles.ts:36-38`
- Test: `tests/roles.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/roles.test.ts`:

```ts
Deno.test("validateRolePreset accepts claude-code backend", () => {
  const r = validateRolePreset({ ...GOOD, backend: "claude-code" }, "test");
  assertEquals(r.backend, "claude-code");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/roles.test.ts`
Expected: FAIL — the new test throws because `validateRolePreset` rejects `"claude-code"`.

- [ ] **Step 3: Implement**

In `src/roles.ts`, change the `Backend` type (line 9):

```ts
export type Backend = "claude" | "ollama" | "claude-code";
```

And the validation check (lines 36-38):

```ts
  if (o.backend !== "claude" && o.backend !== "ollama" && o.backend !== "claude-code") {
    throw new Error(`${source}: backend must be "claude", "ollama", or "claude-code" (got ${JSON.stringify(o.backend)})`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/roles.test.ts`
Expected: PASS (all role tests, including the existing "rejects unknown backend" with `"vllm"`).

- [ ] **Step 5: Commit**

```bash
git add src/roles.ts tests/roles.test.ts
git commit -m "feat: accept claude-code as a backend value"
```

---

## Task 2: Schema enum + example role file

**Files:**
- Modify: `agents/role.schema.json:10`
- Create: `agents/opus-sub.json`
- Test: `tests/roles.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/roles.test.ts`:

```ts
Deno.test("loadRoles loads the opus-sub claude-code role", async () => {
  const roles = await loadRoles();
  assert(roles["opus-sub"], "opus-sub should be loaded");
  assertEquals(roles["opus-sub"].backend, "claude-code");
  assertEquals(roles["opus-sub"].toolCapable, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/roles.test.ts`
Expected: FAIL — `roles["opus-sub"]` is undefined.

- [ ] **Step 3: Implement — schema enum**

In `agents/role.schema.json`, change the `backend` enum (line 10):

```json
      "enum": ["claude", "ollama", "claude-code"],
```

- [ ] **Step 4: Implement — example role**

Create `agents/opus-sub.json`:

```json
{
  "$schema": "./role.schema.json",
  "backend": "claude-code",
  "model": "claude-opus-4-8",
  "description": "Coordinator backed by a Claude subscription (Agent SDK)",
  "systemPrompt": "You are a coordinator backed by a Claude subscription. Delegate when work would be cheaper or faster on a peer. To conserve subscription credit, prefer delegating to Ollama-backed peers and reserve subscription-backed (claude-code) peers for tasks that genuinely need their capability. Stay concise.",
  "skills": [
    { "id": "coordinate", "name": "Coordinate", "description": "Plans and delegates complex tasks" }
  ],
  "toolCapable": true
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/roles.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add agents/role.schema.json agents/opus-sub.json tests/roles.test.ts
git commit -m "feat: add opus-sub example claude-code role + schema enum"
```

---

## Task 3: Config — load the OAuth token

**Files:**
- Modify: `src/config.ts:4-9`, `src/config.ts:17-26`
- Test: `tests/config.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { loadConfig } from "../src/config.ts";

Deno.test("loadConfig surfaces CLAUDE_CODE_OAUTH_TOKEN", async () => {
  Deno.env.set("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-test");
  const cfg = await loadConfig();
  assertEquals(cfg.claudeCodeOauthToken, "sk-ant-oat-test");
  Deno.env.delete("CLAUDE_CODE_OAUTH_TOKEN");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/config.test.ts`
Expected: FAIL — `cfg.claudeCodeOauthToken` does not exist (type error / undefined).

- [ ] **Step 3: Implement**

In `src/config.ts`, add to the `AppConfig` type (after `anthropicApiKey`):

```ts
  claudeCodeOauthToken: string;
```

And in `loadConfig`'s return object (after `anthropicApiKey`):

```ts
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: load CLAUDE_CODE_OAUTH_TOKEN into AppConfig"
```

---

## Task 4: Credential resolver

A pure function that picks exactly one credential (OAuth preferred) and returns the env to hand the subprocess.

**Files:**
- Create: `src/agent/claude-code.ts`
- Test: `tests/agent/claude-code.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/agent/claude-code.test.ts`:

```ts
import { assertEquals, assertThrows } from "@std/assert";
import { resolveClaudeCodeEnv } from "../../src/agent/claude-code.ts";

Deno.test("resolveClaudeCodeEnv prefers OAuth and drops the API key", () => {
  const env = resolveClaudeCodeEnv({ ANTHROPIC_API_KEY: "sk-api", FOO: "bar" }, "sk-oat", "sk-api");
  assertEquals(env.CLAUDE_CODE_OAUTH_TOKEN, "sk-oat");
  assertEquals("ANTHROPIC_API_KEY" in env, false);
  assertEquals(env.FOO, "bar");
});

Deno.test("resolveClaudeCodeEnv falls back to API key when no OAuth token", () => {
  const env = resolveClaudeCodeEnv({ CLAUDE_CODE_OAUTH_TOKEN: "stale" }, "", "sk-api");
  assertEquals(env.ANTHROPIC_API_KEY, "sk-api");
  assertEquals("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
});

Deno.test("resolveClaudeCodeEnv throws when neither credential is set", () => {
  assertThrows(() => resolveClaudeCodeEnv({}, "", ""), Error, "requires");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code.test.ts`
Expected: FAIL — module/function does not exist.

- [ ] **Step 3: Implement (minimal file)**

Create `src/agent/claude-code.ts` with just the resolver for now:

```ts
// Subscription-backed Claude agents via the Claude Agent SDK.
// Prefers a Claude Code OAuth token, falls back to an Anthropic API key.

export function resolveClaudeCodeEnv(
  baseEnv: Record<string, string>,
  oauthToken: string,
  apiKey: string,
): Record<string, string> {
  const env = { ...baseEnv };
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    throw new Error(
      "claude-code backend requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  }
  return env;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude-code.ts tests/agent/claude-code.test.ts
git commit -m "feat: claude-code credential resolver (OAuth preferred, API-key fallback)"
```

---

## Task 5: Startup credential validation helper

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/config.test.ts`:

```ts
import { assertThrows } from "@std/assert";
import { assertBackendCredentials } from "../src/config.ts";
import type { AppConfig } from "../src/config.ts";
import type { AgentSpec } from "../src/config.ts";

const baseCfg: AppConfig = {
  registryPort: 1, anthropicApiKey: "", claudeCodeOauthToken: "",
  bearerToken: "t", ollamaBaseUrl: "x",
};
const spec = (backend: string): AgentSpec => ({
  name: "a", model: "m",
  preset: { backend, model: "m", description: "", systemPrompt: "", skills: [] } as never,
});

Deno.test("assertBackendCredentials requires API key for claude backend", () => {
  assertThrows(() => assertBackendCredentials([spec("claude")], baseCfg), Error, "ANTHROPIC_API_KEY");
});

Deno.test("assertBackendCredentials accepts claude-code with only OAuth token", () => {
  assertBackendCredentials([spec("claude-code")], { ...baseCfg, claudeCodeOauthToken: "sk-oat" });
});

Deno.test("assertBackendCredentials accepts claude-code with only API key", () => {
  assertBackendCredentials([spec("claude-code")], { ...baseCfg, anthropicApiKey: "sk-api" });
});

Deno.test("assertBackendCredentials rejects claude-code with neither credential", () => {
  assertThrows(() => assertBackendCredentials([spec("claude-code")], baseCfg), Error, "claude-code");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/config.test.ts`
Expected: FAIL — `assertBackendCredentials` does not exist.

- [ ] **Step 3: Implement**

In `src/config.ts`, add (after `parseAgentsFlag`):

```ts
// Throws with an actionable message if any spec's backend lacks its credential.
export function assertBackendCredentials(specs: AgentSpec[], cfg: AppConfig): void {
  const backends = new Set(specs.map((s) => s.preset.backend));
  if (backends.has("claude") && !cfg.anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for claude agents. Set it in .env");
  }
  if (backends.has("claude-code") && !cfg.claudeCodeOauthToken && !cfg.anthropicApiKey) {
    throw new Error(
      "claude-code agents require CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Set one in .env",
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into entry points**

In `src/main.ts`, replace the existing guard (lines 18-21):

```ts
if (specs.some((s) => s.preset.backend === "claude") && !cfg.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is required for Claude agents. Set it in .env");
  Deno.exit(1);
}
```

with:

```ts
try {
  const { assertBackendCredentials } = await import("./config.ts");
  assertBackendCredentials(specs, cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}
```

> Simpler alternative if you prefer top-level import: add `assertBackendCredentials` to the existing `import { loadConfig, parseAgentsFlag } from "./config.ts"` line and call it directly inside the try.

In `src/agent-entry.ts`, replace the guard (lines 49-52):

```ts
if (preset.backend === "claude" && !cfg.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is required for Claude agents.");
  Deno.exit(1);
}
```

with (add `assertBackendCredentials` to the `./config.ts` import at the top of the file first):

```ts
try {
  assertBackendCredentials([{ name: agentName, preset, model }], cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}
```

- [ ] **Step 6: Run full test suite + commit**

Run: `deno task test`
Expected: PASS (no regressions).

```bash
git add src/config.ts src/main.ts src/agent-entry.ts tests/config.test.ts
git commit -m "feat: centralize backend credential validation"
```

---

## Task 6: SessionStore

**Files:**
- Create: `src/store/sessions.ts`
- Test: `tests/store/sessions.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/store/sessions.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { SessionStore } from "../../src/store/sessions.ts";

Deno.test("SessionStore round-trips a session id by contextId", async () => {
  const kv = await Deno.openKv(":memory:");
  const sessions = new SessionStore(kv);
  assertEquals(await sessions.get("ctx-1"), undefined);
  await sessions.set("ctx-1", "sess-abc");
  assertEquals(await sessions.get("ctx-1"), "sess-abc");
  assertEquals(await sessions.get("ctx-2"), undefined);
  kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/store/sessions.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/store/sessions.ts`:

```ts
// Maps an A2A contextId to the Claude Agent SDK session id, so the
// claude-code backend can `resume` a conversation across turns.
export class SessionStore {
  constructor(private kv: Deno.Kv) {}

  async get(contextId: string): Promise<string | undefined> {
    const res = await this.kv.get<string>(["cc-session", contextId]);
    return res.value ?? undefined;
  }

  async set(contextId: string, sessionId: string): Promise<void> {
    await this.kv.set(["cc-session", contextId], sessionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/store/sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/sessions.ts tests/store/sessions.test.ts
git commit -m "feat: SessionStore mapping contextId to SDK session id"
```

---

## Task 7: A2A tool bridge

Expose the existing `runTool` surface to the SDK as in-process MCP tools. Reuses `getTools()` from `tools.ts` for both the tool list (incl. spawn-gating) and descriptions; only the zod input shapes are new.

**Files:**
- Create: `src/agent/claude-code-tools.ts`
- Test: `tests/agent/claude-code-tools.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/agent/claude-code-tools.test.ts`:

```ts
import { assert, assertEquals } from "@std/assert";
import { a2aToolNames, makeToolHandler } from "../../src/agent/claude-code-tools.ts";
import type { ToolDeps } from "../../src/agent/tools.ts";

const baseDeps = { selfName: "me", bearerToken: "t" } as unknown as ToolDeps;
const spawnDeps = { ...baseDeps, spawnAgent: async () => ({ ok: true }) } as unknown as ToolDeps;

Deno.test("a2aToolNames omits spawn tools without spawnAgent", () => {
  const names = a2aToolNames(baseDeps);
  assert(names.includes("mcp__a2a__delegate_start"));
  assert(!names.includes("mcp__a2a__spawn_agent"));
});

Deno.test("a2aToolNames includes spawn tools with spawnAgent", () => {
  const names = a2aToolNames(spawnDeps);
  assert(names.includes("mcp__a2a__spawn_agent"));
  assert(names.includes("mcp__a2a__list_roles"));
});

Deno.test("makeToolHandler delegates to the runner with depth + contextId and wraps the result", async () => {
  let captured: unknown[] = [];
  const fakeRun = async (...a: unknown[]) => { captured = a; return '{"ok":true}'; };
  const handler = makeToolHandler(baseDeps, "delegate_start", 1, "ctx-9", fakeRun);
  const out = await handler({ agent: "peer", prompt: "hi" });
  assertEquals(out, { content: [{ type: "text", text: '{"ok":true}' }] });
  assertEquals(captured[1], "delegate_start");
  assertEquals(captured[2], { agent: "peer", prompt: "hi" });
  assertEquals(captured[3], 1);
  assertEquals(captured[4], "ctx-9");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code-tools.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/agent/claude-code-tools.ts`:

```ts
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getTools, runTool, type ToolDeps } from "./tools.ts";

export type ToolRunner = (
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
) => Promise<string>;

// zod input shapes mirroring the parameter schemas in tools.ts.
const SHAPES: Record<string, z.ZodRawShape> = {
  list_agents: {},
  list_my_threads: {},
  delegate_start: {
    agent: z.string().describe("Target agent name"),
    prompt: z.string().describe("What to ask the peer agent"),
    title: z.string().optional().describe("Optional short label for this thread"),
  },
  delegate_continue: {
    threadId: z.string().describe("threadId to continue"),
    prompt: z.string().describe("Next message in the thread"),
  },
  reset_thread: {
    threadId: z.string().describe("threadId to delete"),
  },
  list_roles: {},
  spawn_agent: {
    role: z.string().describe("Role name from list_roles"),
    name: z.string().optional().describe("Optional unique name (defaults to role)"),
    model: z.string().optional().describe("Optional model override (e.g. 'gemma3:1b')"),
  },
};

// Namespaced tool names the SDK will expose (used for allowedTools).
export function a2aToolNames(deps: ToolDeps): string[] {
  return getTools(deps).map((t) => `mcp__a2a__${t.name}`);
}

// One MCP tool handler: delegate to the A2A tool runner, wrap as CallToolResult.
export function makeToolHandler(
  deps: ToolDeps,
  name: string,
  depth: number,
  contextId: string,
  run: ToolRunner = runTool,
) {
  return async (args: Record<string, unknown>) => {
    const text = await run(deps, name, args ?? {}, depth, contextId);
    return { content: [{ type: "text" as const, text }] };
  };
}

// Build the in-process MCP server exposing the A2A tools for one request.
export function buildA2aMcpServer(
  deps: ToolDeps,
  depth: number,
  contextId: string,
  run: ToolRunner = runTool,
) {
  const tools = getTools(deps).map((t) =>
    tool(t.name, t.description, SHAPES[t.name], makeToolHandler(deps, t.name, depth, contextId, run))
  );
  return createSdkMcpServer({ name: "a2a", version: "1.0.0", tools });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code-tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude-code-tools.ts tests/agent/claude-code-tools.test.ts
git commit -m "feat: A2A-to-SDK in-process MCP tool bridge"
```

---

## Task 8: claude-code handler + streamHandler

**Files:**
- Modify: `src/agent/claude-code.ts`
- Test: `tests/agent/claude-code.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/agent/claude-code.test.ts`:

```ts
import { ContextStore } from "../../src/store/context.ts";
import { ThreadStore } from "../../src/store/threads.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import { makeClaudeCodeHandlers, type QueryFn } from "../../src/agent/claude-code.ts";
import type { RegistryClient } from "../../src/registry/client.ts";
import type { AgentHandlerCtx } from "../../src/agent/base.ts";

function ctx(text: string, contextId: string): AgentHandlerCtx {
  return { depth: 0, message: { messageId: "m", role: "user", parts: [{ type: "text", text }], contextId } };
}

async function makeDeps() {
  const kv = await Deno.openKv(":memory:");
  return {
    kv,
    deps: {
      model: "claude-opus-4-8", systemPrompt: "be brief",
      oauthToken: "sk-oat", apiKey: "",
      store: new ContextStore(kv), threads: new ThreadStore(kv), sessions: new SessionStore(kv),
      registry: {} as RegistryClient, bearerToken: "t", selfName: "opus-sub",
    },
  };
}

Deno.test("handler returns result text, records session, and resumes next turn", async () => {
  const { kv, deps } = await makeDeps();
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const fakeQuery: QueryFn = (input) => {
    calls.push(input);
    return (async function* () {
      yield { type: "assistant", session_id: "S1", message: { content: [{ type: "text", text: "partial" }] } };
      yield { type: "result", subtype: "success", session_id: "S1", result: "FINAL" };
    })();
  };
  const { handler } = makeClaudeCodeHandlers({ ...deps, runQuery: fakeQuery });

  const r1 = await handler(ctx("hello", "c1"));
  assertEquals(r1.text, "FINAL");
  assertEquals(calls[0].options.resume, undefined);
  assertEquals(await deps.sessions.get("c1"), "S1");
  assertEquals((await deps.store.get("c1")).map((m) => m.role), ["user", "assistant"]);

  await handler(ctx("again", "c1"));
  assertEquals(calls[1].options.resume, "S1");
  kv.close();
});

Deno.test("handler throws a clear error on a failed result", async () => {
  const { kv, deps } = await makeDeps();
  const fakeQuery: QueryFn = () => (async function* () {
    yield { type: "result", subtype: "error_during_execution", session_id: "S2", errors: ["out of credit"] };
  })();
  const { handler } = makeClaudeCodeHandlers({ ...deps, runQuery: fakeQuery });
  await assertRejects(() => handler(ctx("x", "c2")), Error, "out of credit");
  kv.close();
});

Deno.test("streamHandler yields deltas then done", async () => {
  const { kv, deps } = await makeDeps();
  const fakeQuery: QueryFn = () => (async function* () {
    yield { type: "assistant", session_id: "S3", message: { content: [{ type: "text", text: "chunk" }] } };
    yield { type: "result", subtype: "success", session_id: "S3", result: "chunk" };
  })();
  const { streamHandler } = makeClaudeCodeHandlers({ ...deps, runQuery: fakeQuery });
  const events = [];
  for await (const ev of streamHandler(ctx("y", "c3"))) events.push(ev);
  assertEquals(events[0], { type: "delta", text: "chunk" });
  assertEquals(events.at(-1), { type: "done" });
  kv.close();
});
```

Also add `assertRejects` to the import at the top of the file: `import { assertEquals, assertRejects, assertThrows } from "@std/assert";`

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code.test.ts`
Expected: FAIL — `makeClaudeCodeHandlers` / `QueryFn` not exported.

- [ ] **Step 3: Implement**

Append to `src/agent/claude-code.ts` (keep the existing `resolveClaudeCodeEnv`):

```ts
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { RegistryClient } from "../registry/client.ts";
import type { ToolDeps } from "./tools.ts";
import { a2aToolNames, buildA2aMcpServer } from "./claude-code-tools.ts";

// Minimal view of the SDK messages we consume; injectable for tests.
type SdkMessage =
  | { type: "assistant"; session_id: string; message: { content: Array<{ type: string; text?: string }> } }
  | { type: "result"; subtype: string; session_id: string; result?: string; errors?: string[] }
  | { type: string; session_id?: string; [k: string]: unknown };

export type QueryFn = (
  input: { prompt: string; options: Record<string, unknown> },
) => AsyncIterable<SdkMessage>;

export type ClaudeCodeDeps = {
  model: string;
  systemPrompt: string;
  oauthToken: string;
  apiKey: string;
  store: ContextStore;
  threads: ThreadStore;
  sessions: SessionStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
  runQuery?: QueryFn; // defaults to the real SDK query()
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function assistantText(msg: { message: { content: Array<{ type: string; text?: string }> } }): string {
  return (msg.message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function makeClaudeCodeHandlers(deps: ClaudeCodeDeps) {
  const toolDeps: ToolDeps = {
    store: deps.store,
    threads: deps.threads,
    registry: deps.registry,
    bearerToken: deps.bearerToken,
    selfName: deps.selfName,
    spawnAgent: deps.spawnAgent,
    availableRoles: deps.availableRoles,
  };
  const runQuery = deps.runQuery ?? (sdkQuery as unknown as QueryFn);

  async function prepare(ctx: AgentHandlerCtx) {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const resume = await deps.sessions.get(contextId);
    const env = resolveClaudeCodeEnv(Deno.env.toObject(), deps.oauthToken, deps.apiKey);
    const server = buildA2aMcpServer(toolDeps, ctx.depth, contextId);
    const options: Record<string, unknown> = {
      systemPrompt: { type: "preset", preset: "claude_code", append: deps.systemPrompt },
      model: deps.model,
      maxTurns: 8,
      permissionMode: "bypassPermissions",
      env,
      mcpServers: { a2a: server },
      allowedTools: a2aToolNames(toolDeps),
    };
    if (resume) options.resume = resume;
    return { contextId, prompt, options };
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const { contextId, prompt, options } = await prepare(ctx);
    let finalText = "";
    let sessionId: string | undefined;
    for await (const msg of runQuery({ prompt, options })) {
      if (msg.type === "assistant") {
        sessionId ??= msg.session_id;
        const text = assistantText(msg as never);
        if (text) finalText = text;
      } else if (msg.type === "result") {
        sessionId ??= msg.session_id;
        const r = msg as { subtype: string; result?: string; errors?: string[] };
        if (r.subtype === "success") {
          if (typeof r.result === "string") finalText = r.result;
        } else {
          throw new Error(`claude-code query failed (${r.subtype}): ${(r.errors ?? []).join("; ")}`);
        }
      }
    }
    if (sessionId) await deps.sessions.set(contextId, sessionId);
    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    const { contextId, prompt, options } = await prepare(ctx);
    let finalText = "";
    let sessionId: string | undefined;
    for await (const msg of runQuery({ prompt, options })) {
      if (msg.type === "assistant") {
        sessionId ??= msg.session_id;
        const text = assistantText(msg as never);
        if (text) { finalText = text; yield { type: "delta", text }; }
      } else if (msg.type === "result") {
        sessionId ??= msg.session_id;
        const r = msg as { subtype: string; result?: string; errors?: string[] };
        if (r.subtype === "success") {
          if (typeof r.result === "string") finalText = r.result;
        } else {
          yield { type: "error", message: `claude-code query failed (${r.subtype}): ${(r.errors ?? []).join("; ")}` };
        }
      }
    }
    if (sessionId) await deps.sessions.set(contextId, sessionId);
    await deps.store.append(contextId, { role: "assistant", content: finalText });
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
```

> NOTE: deltas are emitted per complete assistant message block, not per token (the SDK delivers assistant messages whole when the input prompt is a plain string). This is still real streaming and an improvement over `claude.ts`'s post-hoc chunking; token-level streaming can be a later refinement.

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/claude-code.test.ts`
Expected: PASS (all five tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/agent/claude-code.ts tests/agent/claude-code.test.ts
git commit -m "feat: claude-code handler + streamHandler over the Agent SDK"
```

---

## Task 9: Shared `buildHandlers` factory + wiring

**Files:**
- Create: `src/agent/handlers.ts`
- Modify: `src/orchestrator.ts`, `src/agent-entry.ts`
- Test: `tests/agent/handlers.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/agent/handlers.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { buildHandlers } from "../../src/agent/handlers.ts";
import { ContextStore } from "../../src/store/context.ts";
import { ThreadStore } from "../../src/store/threads.ts";
import { SessionStore } from "../../src/store/sessions.ts";
import type { RegistryClient } from "../../src/registry/client.ts";
import type { AppConfig } from "../../src/config.ts";
import type { RolePreset } from "../../src/roles.ts";

Deno.test("buildHandlers returns handler + streamHandler for a claude-code preset", async () => {
  const kv = await Deno.openKv(":memory:");
  const preset: RolePreset = {
    backend: "claude-code", model: "claude-opus-4-8", description: "", systemPrompt: "s",
    skills: [], toolCapable: true,
  };
  const cfg: AppConfig = {
    registryPort: 1, anthropicApiKey: "", claudeCodeOauthToken: "sk-oat",
    bearerToken: "t", ollamaBaseUrl: "x",
  };
  const h = buildHandlers({
    model: "claude-opus-4-8", preset, cfg,
    store: new ContextStore(kv), threads: new ThreadStore(kv), sessions: new SessionStore(kv),
    registry: {} as RegistryClient, selfName: "opus-sub",
  });
  assertEquals(typeof h.handler, "function");
  assertEquals(typeof h.streamHandler, "function");
  kv.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/handlers.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the factory**

Create `src/agent/handlers.ts`:

```ts
import type { AppConfig } from "../config.ts";
import type { RolePreset } from "../roles.ts";
import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { RegistryClient } from "../registry/client.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { AgentHandlerCtx } from "./base.ts";
import type { ToolDeps } from "./tools.ts";
import { makeClaudeHandlers } from "./claude.ts";
import { makeClaudeCodeHandlers } from "./claude-code.ts";
import { makeOllamaHandlers } from "./ollama.ts";

export type Handlers = {
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  streamHandler: (ctx: AgentHandlerCtx) => AsyncGenerator<StreamEvent>;
};

export type BuildHandlersDeps = {
  model: string;
  preset: RolePreset;
  cfg: AppConfig;
  store: ContextStore;
  threads: ThreadStore;
  sessions: SessionStore;
  registry: RegistryClient;
  selfName: string;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
};

export function buildHandlers(d: BuildHandlersDeps): Handlers {
  const { preset, cfg } = d;
  if (preset.backend === "claude") {
    return makeClaudeHandlers({
      model: d.model, systemPrompt: preset.systemPrompt, apiKey: cfg.anthropicApiKey,
      store: d.store, threads: d.threads, registry: d.registry, bearerToken: cfg.bearerToken,
      selfName: d.selfName, spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
    });
  }
  if (preset.backend === "claude-code") {
    return makeClaudeCodeHandlers({
      model: d.model, systemPrompt: preset.systemPrompt,
      oauthToken: cfg.claudeCodeOauthToken, apiKey: cfg.anthropicApiKey,
      store: d.store, threads: d.threads, sessions: d.sessions, registry: d.registry,
      bearerToken: cfg.bearerToken, selfName: d.selfName,
      spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
    });
  }
  return makeOllamaHandlers({
    model: d.model, systemPrompt: preset.systemPrompt, baseUrl: cfg.ollamaBaseUrl, store: d.store,
    tools: preset.toolCapable
      ? {
          store: d.store, threads: d.threads, registry: d.registry, bearerToken: cfg.bearerToken,
          selfName: d.selfName, spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
        }
      : undefined,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `deno test --env-file=.env.example --allow-net --allow-env --allow-read --allow-write --unstable-kv tests/agent/handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire `buildHandlers` into `orchestrator.ts`**

In `src/orchestrator.ts`: add imports near the top:

```ts
import { SessionStore } from "./store/sessions.ts";
import { buildHandlers } from "./agent/handlers.ts";
```

Add a `SessionStore` next to the other stores (after `const threads = new ThreadStore(kv);`):

```ts
  const sessions = new SessionStore(kv);
```

Replace the `const handlers = spec.preset.backend === "claude" ? makeClaudeHandlers({...}) : makeOllamaHandlers({...});` block (lines 111-140) with:

```ts
      const handlers = buildHandlers({
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
      });
```

Remove the now-unused `makeClaudeHandlers` / `makeOllamaHandlers` imports if they are no longer referenced (keep `type SpawnResult` import from `./agent/claude.ts` — `spawnAgent`'s return type still uses it).

- [ ] **Step 6: Wire `buildHandlers` into `agent-entry.ts`**

In `src/agent-entry.ts`: add imports:

```ts
import { SessionStore } from "./store/sessions.ts";
import { buildHandlers } from "./agent/handlers.ts";
```

Add after `const threads = new ThreadStore(kv);`:

```ts
const sessions = new SessionStore(kv);
```

Replace the `const handlers = preset.backend === "claude" ? makeClaudeHandlers({...}) : makeOllamaHandlers({...});` block (lines 69-98) with:

```ts
const handlers = buildHandlers({
  model,
  preset,
  cfg,
  store,
  threads,
  sessions,
  registry,
  selfName: agentName,
  // Spawned agents cannot spawn further agents — no spawnAgent/availableRoles.
});
```

Remove now-unused `makeClaudeHandlers` / `makeOllamaHandlers` imports.

- [ ] **Step 7: Run full suite + commit**

Run: `deno task test`
Expected: PASS (no regressions).

```bash
git add src/agent/handlers.ts src/orchestrator.ts src/agent-entry.ts tests/agent/handlers.test.ts
git commit -m "refactor: extract buildHandlers factory; wire claude-code into both entry points"
```

---

## Task 10: Subprocess permissions + deno.json tasks

**Files:**
- Modify: `src/orchestrator.ts` (the `spawnAgent` arg list, ~lines 64-76)
- Modify: `deno.json`

- [ ] **Step 1: Add permission flags for claude-code spawns**

In `src/orchestrator.ts`, the `spawnAgent` closure builds an `args` array. Replace the array literal (lines 64-75) with a form that injects extra permissions for `claude-code` roles before the script path:

```ts
    const perms = ["--allow-net", "--allow-env", "--allow-read", "--unstable-kv"];
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
```

(`preset` is already in scope — it's resolved at the top of `spawnAgent` from `roles[role]`.)

- [ ] **Step 2: Update `deno.json` tasks**

In `deno.json`, update the `start` task to add `--allow-write` and `--allow-sys` (it already has `--allow-run`), and the `start:agent` task to add `--allow-run`, `--allow-write`, and `--allow-sys`:

```json
    "start": "deno run --env-file=.env --allow-net --allow-env --allow-read --allow-run --allow-write --allow-sys --unstable-kv src/main.ts",
    "start:agent": "deno run --env-file=.env --allow-net --allow-env --allow-read --allow-run --allow-write --allow-sys --unstable-kv src/agent-entry.ts",
```

- [ ] **Step 3: Verify the orchestrator still boots (Ollama-only, no SDK needed)**

Run: `timeout 8 deno task start --agents=gemma3 || true`
Expected: registry + gemma3 agent log lines appear with no permission errors (it will block on the REPL; the timeout ends it). This confirms the arg/permission changes didn't break startup.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator.ts deno.json
git commit -m "feat: grant claude-code subprocesses run/write/sys permissions"
```

---

## Task 11: Docs + cost guidance

**Files:**
- Modify: `README.md`
- Modify: `.env.example` (already has the keys — verify only)

- [ ] **Step 1: Verify `.env.example`**

Confirm `.env.example` already contains `CLAUDE_CODE_OAUTH_TOKEN=sk-replace-me` (it does). No change needed; if missing, add it under `ANTHROPIC_API_KEY`.

- [ ] **Step 2: Add an auth/cost section to `README.md`**

Append to `README.md`:

```markdown
## Claude backends & cost

Two Claude backends exist, chosen per role via the `backend` field:

- **`claude`** — direct Anthropic Messages API with `ANTHROPIC_API_KEY`. Best for
  high-traffic, large-API-key usage.
- **`claude-code`** — runs through the Claude Agent SDK. Prefers
  `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`) and
  falls back to `ANTHROPIC_API_KEY`. Lets a user without an API key run Claude
  agents on their Pro/Max/Team/Enterprise subscription.

**Cost note (effective June 15, 2026):** Agent SDK usage — including these
`claude-code` agents — draws from a separate monthly Agent SDK credit
(Pro $20 / Max 5x $100 / Max 20x $200 / Team & Enterprise per plan), not your
interactive Claude limits. Once that credit is spent, usage either bills at
standard API rates (if usage credits are enabled) or stops until the credit
refreshes. **When driving this orchestrator from Claude Code under a
subscription, prefer Ollama-backed peers for delegated work and reserve
`claude-code` agents for tasks that genuinely need them** — every `claude-code`
agent you spawn draws from that monthly credit. See
`docs/superpowers/specs/2026-05-28-claude-code-backend-design.md` for details.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document claude-code backend, auth, and Agent SDK cost guidance"
```

---

## Task 12: Optional smoke round-trip

**Files:**
- Modify: `scripts/smoke.ts`

- [ ] **Step 1: Add a gated claude-code agent to the smoke script**

In `scripts/smoke.ts`, after the existing agents are started, add (near the other `makeXHandlers` blocks; import what's needed at the top):

```ts
// Optional: exercise the claude-code backend if a credential is present.
if (cfg.claudeCodeOauthToken || cfg.anthropicApiKey) {
  const { makeClaudeCodeHandlers } = await import("../src/agent/claude-code.ts");
  const { SessionStore } = await import("../src/store/sessions.ts");
  const ccHandlers = makeClaudeCodeHandlers({
    model: roles["opus-sub"].model,
    systemPrompt: roles["opus-sub"].systemPrompt,
    oauthToken: cfg.claudeCodeOauthToken,
    apiKey: cfg.anthropicApiKey,
    store, threads, sessions: new SessionStore(kv), registry: registryClient,
    bearerToken: cfg.bearerToken, selfName: "opus-sub",
  });
  const ccAgent = await startAgent({
    card: baseCard("opus-sub", roles["opus-sub"]),
    bearerToken: cfg.bearerToken,
    handler: ccHandlers.handler, streamHandler: ccHandlers.streamHandler,
  });
  await registryClient.register(ccAgent.card);
  const res = await sendMessage({
    url: ccAgent.card.url, token: cfg.bearerToken, depth: 0,
    message: { messageId: crypto.randomUUID(), role: "user",
      parts: [{ type: "text", text: "Reply with one word: PONG" }], contextId: crypto.randomUUID() },
  });
  console.log(`[opus-sub] -> ${res.text}`);
  await ccAgent.shutdown();
}
```

- [ ] **Step 2: Run the smoke script (only meaningful with a real credential + the Task 0 spike having passed)**

Run: `deno run --env-file=.env --allow-net --allow-env --allow-read --allow-run --allow-write --allow-sys --unstable-kv scripts/smoke.ts`
Expected: among the existing output, a `[opus-sub] -> PONG` line (or close). If no credential is set, the block is skipped silently.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.ts
git commit -m "test: optional claude-code round-trip in smoke script"
```

---

## Final verification

- [ ] **Run the whole suite**

Run: `deno task test`
Expected: all tests pass.

- [ ] **Type-check the whole project**

Run: `deno check src/main.ts src/agent-entry.ts scripts/smoke.ts`
Expected: no type errors.

- [ ] **Confirm clean tree**

Run: `git status`
Expected: clean (all work committed; `scripts/spike-agent-sdk.ts` deleted in Task 0).
