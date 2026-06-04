# A2A Prototype

Deno-based Agent-to-Agent (A2A) prototype: any Claude- or Ollama-backed agent
can delegate work to peers over HTTP, discovered via a local registry. Each
agent runs its own HTTP server, speaks the A2A wire protocol (JSON-RPC-ish over
HTTP + SSE), and authenticates with a shared bearer token.

## Quick start (Ollama + Deno, no API key needed)

The default crew in `agents.example.json` uses one Ollama model (`gemma4:e4b`)
for the local `worker` and Claude Haiku for `coordinator`/`researcher`. If you
only want local models, swap those roles to `backend: "ollama"` in a custom
`agents.json`.

**1. Pull the required model and start Ollama**

```
ollama pull gemma4:e4b
ollama serve
```

**2. Clone, copy env, install**

```
git clone https://github.com/your-org/a2a
cd a2a
cp .env.example .env
# If using any Claude-backed agents, add ANTHROPIC_API_KEY to .env
```

**3. Add to `~/.claude.json` (drive from Claude Code)**

```json
{
  "mcpServers": {
    "a2a": {
      "type": "stdio",
      "command": "deno",
      "args": [
        "run",
        "--allow-all",
        "--unstable-kv",
        "--env-file=/abs/path/to/a2a/.env",
        "/abs/path/to/a2a/src/mcp.ts",
        "--crew=default"
      ],
      "cwd": "/abs/path/to/a2a"
    }
  }
}
```

Replace `/abs/path/to/a2a` with this repo's absolute path. Restart Claude Code
and the `a2a` tools (`list_agents`, `delegate_start`, `delegate_continue`, etc.)
appear automatically.

Or register it via the CLI instead:

```
claude mcp add a2a -- deno run --allow-all --unstable-kv \
  --env-file=.env /abs/path/to/a2a/src/mcp.ts --crew=default
```

---

## Run

    cp .env.example .env
    # edit ANTHROPIC_API_KEY
    deno task start --agents="coordinator,researcher,worker"

In the REPL:

    > @coordinator ask worker to write a haiku about frogs, then make it darker
    > @researcher decompose: what's the difference between TCP and UDP?
    > @worker use list_agents, then delegate a math question to a peer

`@<name>` routes a prompt to that agent. Streaming token output and live
`· tool_name{args}` events appear inline.

## Development

Run this once after cloning to enable the git hooks:

    deno task setup

It points git at `.githooks/` (via `core.hooksPath`) and marks the hooks
executable. The setting is local to your clone (not checked in), so each
contributor runs it once.

| Task                   | Runs                                                       |
| ---------------------- | ---------------------------------------------------------- |
| `deno task check`      | `deno fmt --check`, `deno lint`, and `deno check`          |
| `deno task test`       | full test suite (unit + e2e)                               |
| `deno task test:unit`  | unit tests only (excludes `tests/e2e/`, the `*e2e*` files) |
| `deno task pre-commit` | `check` + unit tests — runs on every commit                |
| `deno task pre-push`   | `check` + full test suite — runs on every push             |

`pre-commit` stays fast by skipping the network/Ollama-dependent e2e tests;
those run at `pre-push`. Bypass a hook with `--no-verify` when you need to.

## Agents

The roster lives in **`agents.example.json`** (committed example) — a JSON
object mapping role name to preset. To use your own roster, copy it to
**`agents.json`** (gitignored); when present it **fully replaces** the example.
The shape of both files is described by `agents.schema.json` (referenced via
`$schema` for editor autocomplete).

Agent names are identities, deliberately **decoupled from the model** that backs
them — so a role can swap models without breaking how peers address it.

| Role          | Backend                         | Tools            | Purpose                                              |
| ------------- | ------------------------------- | ---------------- | ---------------------------------------------------- |
| `coordinator` | Claude API (`claude-haiku-4-5`) | yes              | Answers simple requests; delegates the rest to peers |
| `researcher`  | Claude API (`claude-haiku-4-5`) | yes + web_search | Decomposes questions, delegates, synthesizes         |
| `worker`      | Ollama (`gemma4:e4b`)           | yes              | Local worker: summarize, translate, review, reason   |

**Add or change agents:** copy `agents.example.json` to `agents.json` (it fully
replaces the example roster) and edit to match the shape in
`agents.schema.json`. Restart. No code changes needed.

**Override a model at the CLI:** `--agents="coordinator,worker:gemma3:1b"` runs
the `worker` role with the `gemma3:1b` tag.

## Architecture

```
deno task start --agents="coordinator,researcher,worker"

  [registry]      localhost:7890          (only fixed port)
  [coordinator]   localhost:<dynamic>     (HTTP server, Agent Card at /.well-known/agent.json)
  [researcher]    localhost:<dynamic>
  [worker]        localhost:<dynamic>
  [REPL]          stdin/stdout            (@mentions, live SSE)
```

Each agent registers its Agent Card with the registry on boot. Peers discover
each other via `GET /agents`. Delegations are bearer-token authenticated HTTP
calls between agents.

### Delegation threads

A tool-capable agent has five tools for managing sub-conversations:

- `list_agents()` — see peers
- `list_my_threads()` — see active sub-conversations
- `delegate_start(agent, prompt, title?)` — open a new thread, returns
  `{ threadId, text }`
- `delegate_continue(threadId, prompt)` — continue an existing thread (peer sees
  prior turns)
- `reset_thread(threadId)` — drop a finished thread

Threads are scoped to the parent's contextId, persisted in Deno KV.
Cross-conversation thread access is rejected.

### Spawning agents at runtime

An agent in the orchestrator can launch new peers on demand:

- `list_roles()` — see available role presets
- `spawn_agent(role, name?, model?)` — boot a new agent as its own subprocess
  (Deno.Command + `src/agent-entry.ts`). Returns once the new peer has
  registered.

Spawned agents have their own KV (isolated history). The orchestrator kills them
on shutdown. Standalone agents (no orchestrator) do not get spawn capability —
that authority lives only with the orchestrator.

### Depth guard

Each `delegate_*` call increments an `x-depth` header. A request whose depth
reaches the cap is rejected with HTTP 429. The cap is **pegged to the current
registered-agent count** (floored at 2), so a bigger swarm can fan out deeper —
e.g. with `coordinator, researcher, worker` registered,
`REPL → coordinator →
researcher → worker` is allowed. Set `A2A_MAX_DEPTH` to a
fixed number to override (e.g. `A2A_MAX_DEPTH=2` restores the original
`REPL → A → B` budget).

Note: a delegating role (e.g. `researcher`, whose job is to decompose and
delegate) only fans out usefully when it sits high enough in the tree to have
remaining depth budget — chaining two delegating roles needs the cap to allow
it.

### Standalone agents

Spin up an agent in another terminal — it joins the same registry:

    deno task start:agent --role=worker --name=remote --registry=http://localhost:7890

Useful for running peers on different machines (subject to network config — see
`TODO.md`'s multi-machine entry).

## Scripts

- `scripts/smoke.ts` — full Tier C round-trip (Claude + Ollama, delegate_start +
  delegate_continue + spawn_agent)
- `scripts/smoke-gemma-tools.ts` — tool-capable `captain` delegating to a
  passive `helper` (both Ollama `worker`), no Claude in the loop
- `scripts/smoke-streaming-tools.ts` — verify streaming token output through the
  tool loop
- `scripts/kv-dump.ts` — dump every thread + conversation history in the local
  Deno KV

Run any of them with:

    REGISTRY_PORT=0 deno run --env-file=.env --allow-net --allow-env --allow-read --allow-run --unstable-kv scripts/<file>.ts

(The `REGISTRY_PORT=0` lets them use an OS-assigned port so they don't conflict
with a running orchestrator on 7890.)

## Web UI monitor (optional)

Visualize a run as a swimlane diagram. The monitor is a standalone service; the
app works exactly the same with it off.

```
# terminal 1 — start the monitor
deno task monitor                       # http://localhost:7891

# terminal 2 — point agents at it
A2A_MONITOR_URL=http://localhost:7891 \
  deno task start --agents="coordinator,researcher,worker"
```

Open http://localhost:7891, pick a session, and watch delegations stream in.
With `A2A_MONITOR_URL` unset, no events are emitted and behavior is unchanged.

Config: `MONITOR_PORT` (default 7891), `MONITOR_KV_PATH` (default
`./a2a-monitor.db`), and `AGENT_BEARER_TOKEN` (optional shared secret on
`/ingest`). See `docs/superpowers/specs/2026-05-28-web-ui-monitor-design.md`.

## MCP server (drive A2A from Claude Code)

Expose the orchestrator as an MCP server over stdio, so Claude Code (or any MCP
client) can call A2A agents through the raw delegation tools — instead of the
`@agent` REPL.

```
deno task mcp --agents="coordinator,researcher,worker"
```

This boots a self-contained orchestrator (registry + the named agents) and
serves MCP on stdin/stdout. It is the sole orchestrator for its registry/KV
while running — don't run `deno task start` against the same registry port
(`REGISTRY_PORT`, default 7890) or default Deno KV at the same time.

See the **Quick start** section above for the `~/.claude.json` entry and the
`claude mcp add` equivalent.

The client sees the raw A2A surface as MCP tools: `list_agents`,
`list_my_threads`, `delegate_start`, `delegate_continue`, `reset_thread`, and
(when an orchestrator-backed spawn closure is present, which it always is here)
`spawn_agent` / `list_roles`. The client is the depth-0 driver, so its
`delegate_*` calls reach peers at depth 1 — identical to the REPL. With
`A2A_MONITOR_URL` set, MCP-driven runs appear in the swimlane monitor under the
`mcp` lane.

Note: tool calls are blocking request/response — `delegate_*` returns the peer's
final text (no token streaming over MCP).

## Configuration

`.env` (see `.env.example`):

| Variable                  | Default                       | Purpose                                                                        |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------ |
| `REGISTRY_PORT`           | `7890`                        | Registry's fixed port                                                          |
| `ANTHROPIC_API_KEY`       | —                             | Required for any `claude`-backed agent; fallback for `claude-code`             |
| `CLAUDE_CODE_OAUTH_TOKEN` | —                             | Preferred auth for `claude-code` agents (`claude setup-token`)                 |
| `AGENT_BEARER_TOKEN`      | `local-dev-secret`            | Shared secret on all A2A calls                                                 |
| `OLLAMA_BASE_URL`         | `http://localhost:11434`      | Where to find Ollama                                                           |
| `OLLAMA_API_KEY`          | _(unset — no Ollama search)_  | Enables `web_search` for tool-capable Ollama agents with `webSearch: true`     |
| `A2A_MONITOR_URL`         | _(unset — monitor disabled)_  | Point agents at a running monitor for swimlane tracing                         |
| `A2A_MAX_DEPTH`           | `0` _(pegged to agent count)_ | Force a fixed max delegation depth (e.g. `2`); `0`/unset scales with the swarm |

## Design + roadmap

- `docs/superpowers/specs/2026-05-28-a2a-design.md` — full design spec
  (architecture, protocol, security, threading, spawning, etc.)
- `docs/superpowers/plans/2026-05-28-a2a-prototype.md` — implementation plan (15
  tasks, all done)
- `TODO.md` — follow-ups: thread-browser CLI, multi-machine, agent-card
  consolidation, others

## Claude backends & cost

Two Claude backends exist, chosen per role via the `backend` field:

- **`claude`** — direct Anthropic Messages API with `ANTHROPIC_API_KEY`. Best
  for high-traffic, large-API-key usage.
- **`claude-code`** — runs through the Claude Agent SDK. Prefers
  `CLAUDE_CODE_OAUTH_TOKEN` (a subscription token from `claude setup-token`) and
  falls back to `ANTHROPIC_API_KEY`. Lets a user without an API key run Claude
  agents on their Pro/Max/Team/Enterprise subscription.

**Cost note (effective June 15, 2026):** Agent SDK usage — including these
`claude-code` agents — draws from a separate monthly Agent SDK credit (Pro $20 /
Max 5x $100 / Max 20x $200 / Team & Enterprise per plan), not your interactive
Claude limits. Once that credit is spent, usage either bills at standard API
rates (if usage credits are enabled) or stops until the credit refreshes. **When
driving this orchestrator from Claude Code under a subscription, prefer
Ollama-backed peers for delegated work and reserve `claude-code` agents for
tasks that genuinely need them** — every `claude-code` agent you spawn draws
from that monthly credit. See
`docs/superpowers/specs/2026-05-28-claude-code-backend-design.md` for details.
