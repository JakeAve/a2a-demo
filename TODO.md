# TODO

Follow-ups deferred from the prototype scope. Each is independent;
implement in any order.

## MCP wrapping

Expose the orchestrator as an MCP server so Claude Code (or any MCP
client) can invoke A2A agents as tools.

- New entry point that speaks MCP over stdio.
- Tools mirror the A2A surface: `delegate_start`, `delegate_continue`,
  `list_agents`, `list_my_threads`, `spawn_agent`, `reset_thread`.
- Optionally reuses the existing orchestrator process — MCP just bridges
  stdin/stdout to the in-process registry + tool runner.

**Rough scope:** 100-150 lines. The `@modelcontextprotocol/sdk` npm
package handles the framing. Most work is mapping each MCP tool call
to the existing `runTool` in `src/agent/tools.ts`.

## Thread browser CLI

A read-only inspector for ThreadStore so you can audit what an agent
talked to its peers about.

```
$ deno task threads
parent: 4f3a-... (sonnet REPL session, started 12 min ago)
  ├─ gemma3/0b75d791 "Frog haiku" — 2 turns, last 8m ago
  ├─ gemma3/7921d67c "Sky color"   — 1 turn,  last 5m ago
  └─ gemma-helper/2e9611d4 "Fruits" — 1 turn, last 2m ago

$ deno task threads show 0b75d791
[user]      Please write a haiku about frogs.
[assistant] Green skin, silent leap, ...
[user]      darker version
[assistant] Green skin, soft and slow, ...
```

**Rough scope:** 50-80 lines. Opens the same Deno KV the orchestrator
uses, iterates `["thread"]` and `["context"]` prefixes, prints a tree.

## Multi-machine support

Push the registry behind a real hostname + TLS so agents can run on
remote boxes. Currently every URL is `http://localhost:<port>`.

- Make `bind host` configurable (currently hardcoded to `127.0.0.1`
  via Deno default).
- Replace `http://localhost:<port>` in registered Agent Cards with an
  externally-reachable URL (env var override).
- Require TLS for any non-loopback agent.
- mTLS or signed Agent Cards become more important; the bearer-token
  model is fine for trusted internal use but not the open internet.

**Rough scope:** 100+ lines plus infra setup (certs, hostnames). The
A2A protocol itself doesn't change; only deployment shape does.

## Consolidate Agent Card creation

`AgentCard` is built in two places today (`src/orchestrator.ts` ~L99
and `src/agent-entry.ts` ~L58), with identical shape and duplicated
`securitySchemes` / `security` boilerplate. Both also work in lockstep
with `startAgent()` in `src/agent/base.ts`, which rewrites the URL
after binding.

Refactor target: a single `buildAgentCard(name, preset)` helper (in
`src/agent/base.ts` or `src/roles.ts`) that produces the card from a
role name + RolePreset. Both call sites become one-liners. Reduces the
risk of the two diverging.

## Other ideas captured during development

- **Reset / forget tool for sonnet**: `forget(threadId)` or just deeper
  use of `reset_thread`. Already implemented at the protocol level —
  just needs UX guidance in the system prompt.
- **Standalone agent reconnect**: today, a standalone agent dies if
  the registry restarts (its registration is lost). It should retry
  registration periodically.
- **Per-agent rate limiting / cost caps**: prevent runaway loops or
  unintended bills. Especially relevant for Claude-backed agents in
  spawned-by-agent scenarios.
- **Agent Card signing**: TOFU pin a public key per agent, sign cards
  on register, verify on consume. Resists card spoofing.
- **Structured artifacts**: A2A spec supports `parts: [{type:"data",
  data: ...}]` and `{type:"file"}` — we only use text parts. Worth
  exposing if peers need to exchange structured JSON or files.
