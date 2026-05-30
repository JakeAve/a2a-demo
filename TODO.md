# TODO

Follow-ups deferred from the prototype scope. Each is independent;
implement in any order.

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

## REPL: signal direct-send vs room-post mode

**Priority: high (UX trap, hit on the first Plan-2 smoke test).** When no
room is focused, typing `@agent <prompt>` silently does a 1:1 direct send
(the intended escape) — but there is no cue, so it's easy to believe you
posted to a room when you didn't. Observed live: `@worker …` typed before
`:room new` went out as a direct send and created no room, with no signal.

Fix: echo a one-line cue on the direct-send path, e.g.
`(direct send — no room focused; use :room new / :room join to start one)`,
and consider showing the focused room in the prompt itself (e.g.
`[hotdog debate] > ` vs the bare `> `).

Lives in `src/repl.ts`: `classifyLine` already returns `{kind:"direct"}`;
the cue goes in the `runRepl` dispatch for that branch, and the prompt
string is the `PROMPT`/`write(...)` calls. The design spec
(`docs/superpowers/specs/2026-05-29-agent-rooms-design.md`) explicitly
flags the focused-room input model as the expected iteration point.

**Rough scope:** ~10 lines, REPL-only — no broker or protocol change.

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
- **REPL bare `@name` post** (minor): typing just `@member` with no text
  while a room is focused posts the literal `"@name"` as the message body
  instead of erroring. Guard in `classifyLine` (`src/repl.ts`).
