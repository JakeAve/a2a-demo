# claude-code backend — subscription-auth agents via the Claude Agent SDK

**Date:** 2026-05-28
**Status:** Design approved, ready for implementation plan

## Problem

Today every Claude-backed agent authenticates with an Anthropic API key
(`sk-ant-api...`) via the `@anthropic-ai/sdk` Messages API (`src/agent/claude.ts`).
That path is right for high-traffic, large-API-key usage. But a single user who has
a Claude Pro/Max subscription and **no** API key can't currently run Claude agents.

We want both mechanisms, treated as genuinely distinct:

- **`claude` backend** — direct Messages API, API key, owns its own agentic loop.
  Unchanged. The high-traffic path.
- **`claude-code` backend** (new) — runs through the **Claude Agent SDK**
  (`@anthropic-ai/claude-agent-sdk`), which spawns the bundled `claude` binary and
  authenticates from the environment. It **prefers** a Claude Code OAuth token
  (`CLAUDE_CODE_OAUTH_TOKEN`, `sk-ant-oat...`) and **falls back** to an API key.

Using the Agent SDK (rather than sending the OAuth token directly at the Messages
API) is the **ToS-supported** path: the SDK consumes `CLAUDE_CODE_OAUTH_TOKEN`
natively, and the `claude_code` system-prompt preset keeps the required Claude Code
identity intact. No token-spoofing.

## Goals

- A new `claude-code` backend whose agents are **first-class A2A peers** —
  indistinguishable from `claude` agents in capability, including the full A2A tool
  surface (`delegate_start`, `delegate_continue`, `list_agents`, `spawn_agent`,
  `reset_thread`, `list_my_threads`).
- Deterministic credential resolution: OAuth token preferred, API key fallback.
- Credentials flow by **environment inheritance** — never threaded through A2A
  messages. When Claude Code (later) launches the orchestrator as a child, the
  spawned agents inherit its `CLAUDE_CODE_OAUTH_TOKEN` automatically.
- Design must not block the future MCP server (the `TODO.md` "MCP wrapping" item)
  that exposes this orchestrator as a tool to Claude Code.

## Non-goals (YAGNI)

- Building the MCP stdio server (separate `TODO.md` item; this spec only stays
  compatible with it).
- Per-request credential forwarding (multiple distinct subscription identities
  flowing through a single orchestrator). Static env-inherited credential only.
- Persistent-daemon orchestrator mode. The orchestrator remains a child of the
  Claude Code session; the A2A network lives and dies with that session.
- Rate/cost caps (separate `TODO.md` item).
- Streaming tool-call UI in the REPL.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Auth mechanism | Agent SDK subprocess | ToS-supported; native OAuth; no spoofing |
| Tool surface | Full A2A parity | Subscription agent is a first-class peer |
| Credential order | OAuth → API key → error | Same role works in-session or standalone/CI |
| History model | SDK session resume (A) | Idiomatic for SDK; cheap; cache reuse |
| MCP server | Design-compatible, defer build | Keep this spec focused |
| Orchestrator lifetime | Child of Claude Code session | Matches usage model; cred inherits for free |

## Architecture

```
┌─ Live Claude Code session (MCP client — NOT an A2A peer) ─┐
│   calls MCP tool (future): delegate / spawn / list         │
└───────────────┬────────────────────────────────────────────┘
                │ stdio (MCP) — future, out of scope here
                ▼
┌─ MCP server = orchestrator (child process) ────────────────┐
│  registry + ContextStore + ThreadStore + spawnAgent         │
│  inherits CLAUDE_CODE_OAUTH_TOKEN from Claude Code env       │
│                                                             │
│   ┌── A2A network (real agent-to-agent) ─────────────────┐ │
│   │  opus-sub ──delegate──▶ researcher                    │ │
│   │  (claude-code backend; each an HTTP server + card)    │ │
│   └───────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

The live Claude Code session is a **client/driver**, not a node in the graph
(it has no Agent Card, no inbound endpoint). Real A2A traffic happens among the
spawned agents behind the MCP boundary.

## Components

### 1. Backend type

Add `"claude-code"` as a third `Backend` value:

- `src/roles.ts` — `export type Backend = "claude" | "ollama" | "claude-code"` and
  the `validateRolePreset` backend check.
- `agents/role.schema.json` — add to the `backend` enum.
- New example role file, e.g. `agents/opus-sub.json`:
  ```json
  {
    "$schema": "./role.schema.json",
    "backend": "claude-code",
    "model": "claude-opus-4-8",
    "description": "Coordinator backed by a Claude subscription (Agent SDK)",
    "systemPrompt": "You are a coordinator. Delegate when cheaper or faster on a peer. Stay concise.",
    "skills": [{ "id": "coordinate", "name": "Coordinate", "description": "Plans and delegates" }],
    "toolCapable": true
  }
  ```

`RolePreset` shape is unchanged. Additional sonnet/haiku subscription roles are
just more JSON files.

### 2. Credential plumbing

`src/config.ts` — add to `AppConfig`:
```ts
claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
```
(`anthropicApiKey` already exists.)

**Resolution (deterministic, explicit precedence).** The `claude-code` backend
resolves its credential at agent construction and passes an `env` object to
`query()` containing **only the chosen credential** — never both — so behavior does
not depend on the CLI's internal tie-break:

```ts
const env = { ...Deno.env.toObject() };
if (oauthToken) {
  env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  delete env.ANTHROPIC_API_KEY;
} else if (apiKey) {
  env.ANTHROPIC_API_KEY = apiKey;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
} else {
  throw new Error("claude-code backend requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY");
}
```

**Startup validation** (mirrors the existing `ANTHROPIC_API_KEY` guard at
`src/main.ts:18` and `src/agent-entry.ts:49`):

- `claude` backend present → require `ANTHROPIC_API_KEY` (unchanged).
- `claude-code` backend present → require `CLAUDE_CODE_OAUTH_TOKEN` **or**
  `ANTHROPIC_API_KEY`; fail only if **neither** is set.

The `claude_code` system-prompt preset is used in **both** credential modes
(required under OAuth, harmless under an API key) — no prompt branching.

### 3. Handler module — `src/agent/claude-code.ts`

`makeClaudeCodeHandlers(deps)` returns `{ handler, streamHandler }`, the same
interface `startAgent` consumes (`src/agent/base.ts`). `deps` mirrors `ClaudeDeps`
but carries `oauthToken` and `apiKey` instead of a single `apiKey`, plus a
`SessionStore` (section 5).

The handler drives the Agent SDK `query()`:

```ts
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const q = query({
  prompt: userText,                        // just the new turn; resume carries history
  options: {
    systemPrompt: { type: "preset", preset: "claude_code", append: deps.systemPrompt },
    model: deps.model,
    maxTurns: 8,                            // matches the existing claude.ts loop bound
    permissionMode: "bypassPermissions",    // headless — no interactive prompts
    env,                                    // section 2 (only the chosen credential)
    mcpServers: { a2a: bridge },            // section 4
    allowedTools: ["mcp__a2a__delegate_start", "mcp__a2a__delegate_continue",
                   "mcp__a2a__list_agents", "mcp__a2a__spawn_agent",
                   "mcp__a2a__reset_thread", "mcp__a2a__list_my_threads"],
    resume: sessionId,                      // section 5; omitted on first turn
  },
});
```

Stream handling:

- `streamHandler` iterates `q`; on `assistant` messages it emits
  `{ type: "delta", text }` from the message's text blocks; at the `result`
  message it captures the final text and yields `{ type: "done" }`. This is
  **real streaming**, an upgrade over the post-hoc chunking in `claude.ts:106`.
- `handler` consumes the same stream and returns `{ text: finalText }` (where
  `finalText` is the `result` message's `result`, falling back to accumulated
  assistant text).

The raw `query()` call sits behind a small injectable seam (e.g. a `runQuery`
field on `deps`, defaulting to the real SDK) so unit tests stub it without
spawning a subprocess.

### 4. A2A tool bridge

A `createSdkMcpServer({ name: "a2a", tools })` whose tools wrap the **existing**
`runTool` from `src/agent/tools.ts`. Tool *logic* is reused verbatim; only
registration is adapted:

```ts
tool("delegate_start", "Delegate a task to a peer agent",
  { agent: z.string(), task: z.string() },
  async (args) => {
    const text = await runTool(toolDeps, "delegate_start", args, depth, contextId);
    return { content: [{ type: "text", text }] };
  });
```

Details:

- The server is constructed **per request inside `handler`**, so each `query()`
  closes over the correct `contextId` and `depth`.
- Input schemas are hand-written **`zod`** shapes mirroring the current tool inputs
  (the tool set is small and known). Adds a `zod` dependency, which the SDK already
  expects.
- SDK MCP tools are auto-namespaced `mcp__a2a__<name>`; those names go in
  `allowedTools` and, with `permissionMode: "bypassPermissions"`, run without
  stalling on permission prompts.
- The spawn tools are only registered when `deps.spawnAgent` is present (matching
  the existing rule that spawned agents cannot spawn further agents —
  `src/agent-entry.ts:79`).

### 5. Session / history mapping (Approach A)

A minimal session store keyed by `contextId`:

- New KV mapping `["cc-session", contextId] → session_id` (a small `SessionStore`
  over the same `Deno.openKv()` the orchestrator already uses; mirrors the
  `ContextStore`/`ThreadStore` pattern).
- First turn for a context: no `resume`; capture `session_id` from the stream and
  persist it.
- Later turns: pass `resume: session_id`. The SDK session is the model's working
  memory.
- We still append final user/assistant text to `ContextStore` as the **audit
  mirror**, so the thread browser and the rest of the system observe the
  conversation. Two stores with clearly divided roles: SDK session = model memory,
  ContextStore = audit log.

### 6. Dispatch wiring + subprocess permissions

- The backend ternary in `src/orchestrator.ts:111` and `src/agent-entry.ts:69`
  becomes a third branch. Since this is now a 3-way build duplicated across two
  files, extract a shared `buildHandlers(preset, deps)` helper (targeted cleanup
  that directly serves adding the third backend — not unrelated refactoring).
- `spawnAgent` command args (`src/orchestrator.ts:64`): when
  `preset.backend === "claude-code"`, add `--allow-run` and `--allow-write` (the
  SDK spawns the bundled `claude` binary and writes session transcripts). Env is
  inherited by `Deno.Command` by default plus `--env-file=.env`, so the resolved
  credential flows to the child.

### 7. Dependencies & runtime permissions

- `deno.json` imports: add `@anthropic-ai/claude-agent-sdk` (npm) and `zod` (npm).
- `deno.json` tasks: the `start:agent` task (and any task that may host a
  `claude-code` agent) gains `--allow-run` and `--allow-write` (and likely
  `--allow-sys`). The `start` task already has `--allow-run`; add `--allow-write`.

### 8. MCP-readiness (deferred build)

No blockers introduced. Because credentials come from env and the orchestrator is
a child of the Claude Code session, the future MCP stdio server simply exposes
`runTool` over stdio and inherits the token automatically. Not built in this spec.

## Risks & de-risking

1. **Agent SDK under Deno (highest risk).** The SDK is Node-first; subprocess
   spawning and bundled-binary path resolution are the friction points.
   **Implementation step one is a throwaway spike**: a ~15-line `query()`
   "hello world" under Deno authenticated with the OAuth token. If the bundled
   binary path does not resolve, fall back to `pathToClaudeCodeExecutable`. Do not
   build the backend until the spike passes. (A Deno + Agent SDK starter exists
   publicly, so this is expected to be tractable.)
2. **`process.env` shim under Deno.** Mitigated by passing `Deno.env.toObject()`
   explicitly to the `env` option rather than relying on `process.env`.
3. **Headless permission stalls.** Mitigated by `permissionMode: "bypassPermissions"`
   plus explicit `allowedTools`.
4. **Two stores of record drift** (SDK session vs ContextStore). Mitigated by the
   clear role split; ContextStore is audit-only for this backend.

## Testing

- **Unit:** role validation accepts `"claude-code"`; config validation errors only
  when neither credential is set; credential resolver picks OAuth over API key and
  passes exactly one; tool-bridge handler delegates to `runTool`; handler builds the
  expected `query()` options (via the injectable `runQuery` seam).
- **Smoke/integration:** a `scripts/smoke.ts`-style check gated on a credential
  being present in `.env`, spinning up one `claude-code` agent and round-tripping a
  message (mirrors the existing smoke pattern).
- Follow existing patterns under `tests/`.

## Implementation order (for the plan)

1. Deno + Agent SDK spike (gate). 
2. Backend type + role schema + example role.
3. Config + credential resolver + startup validation.
4. `SessionStore`.
5. Tool bridge (`createSdkMcpServer` + zod shapes over `runTool`).
6. `claude-code.ts` handler/streamHandler with the injectable seam.
7. `buildHandlers` extraction + 3-way dispatch in both call sites.
8. `spawnAgent` permission flags + `deno.json` deps/tasks.
9. Tests + smoke.
