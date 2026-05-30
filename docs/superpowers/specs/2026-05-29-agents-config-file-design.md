# Agents config file: `agents.default.json` + gitignored `agents.json` override

**Date:** 2026-05-29 **Status:** Approved (design)

## Problem

Agent roles live as one JSON file per role under `agents/` (`scout.json`,
`researcher.json`, …), loaded by `loadRoles()` which reads the directory. The
roster is effectively hard-baked: there's no way to tweak the set of agents
locally without editing committed files, and the directory-of-files layout is
heavier than it needs to be for what is really a small map of presets. We want a
committed default roster plus a local, gitignored override, and we want to
redefine the roster as a small set of lightweight, tool-using agents.

## Goals

- A single committed file, `agents.default.json`, holding the default roster.
- An optional gitignored `agents.json` that **fully replaces** the default when
  present.
- Redefine the roster as 3 minimal, `toolCapable` "light" agents: a Claude Haiku
  coordinator and researcher that fan work out to a cheap local Ollama worker.
- Delete the `agents/` directory.
- Keep editor autocomplete via a JSON Schema.
- Update every reference to the old roster across the repo (breaking change,
  accepted).

## Non-goals

- No per-agent or per-field merge between the two files. Override semantics are
  whole-file replacement only.
- No change to `RolePreset` shape or `validateRolePreset()`.
- No change to the `loadRoles()` call sites' signature (still `loadRoles()`).

## Design

### File layout

Two files at repo root replace the `agents/` directory:

- **`agents.default.json`** (committed) — a JSON object mapping role name →
  `RolePreset`.
- **`agents.json`** (gitignored) — optional. If it exists, it is loaded
  **instead of** `agents.default.json` (full replacement). If absent, defaults
  are used.
- **`agents.schema.json`** (committed) — JSON Schema describing the _map_
  (`type: object`, `additionalProperties` = the existing role-preset shape, plus
  an optional `$schema` string). Both files carry a top-level
  `"$schema": "./agents.schema.json"` for editor autocomplete.

Shape:

```jsonc
{
  "$schema": "./agents.schema.json",
  "coordinator": { "backend": "claude", "model": "claude-haiku-4-5", ... },
  "researcher":  { ... },
  "worker":      { ... }
}
```

The top-level `$schema` key is stripped before validation (the current loader
already does this for the per-file `$schema`).

### Loader changes (`src/roles.ts`)

`loadRoles()` becomes file-based:

1. Resolve the source file: if `agents.json` exists, use it; otherwise use
   `agents.default.json`. (Existence check; no merge.)
2. Read and `JSON.parse` the file. On parse failure, throw an error naming the
   file.
3. If the parsed value isn't a plain object, throw.
4. Delete the top-level `$schema` key.
5. For each remaining `[name, value]` entry, validate with the existing
   `validateRolePreset(value, "<file>#<name>")`. The key becomes the role name.
6. Return `Record<string, RolePreset>`.

- Public signature stays `loadRoles()` with no required args, so `main.ts`,
  `mcp.ts`, `agent-entry.ts`, and `scripts/smoke-streaming-tools.ts` need no
  call-site change.
- For testability, accept optional overrides for the two paths, e.g.
  `loadRoles({ overridePath = "agents.json", defaultPath = "agents.default.json" } = {})`,
  so tests can point at temp files. (Internal detail; exact shape decided in the
  plan.)
- `RolePreset`, `Backend`, `isSkill`, and `validateRolePreset` are unchanged.
- Error messages reference `agents.json#<name>` or `agents.default.json#<name>`
  instead of `agents/<file>.json`.

### New roster (`agents.default.json`)

Three agents, all `toolCapable: true`. The Haiku coordinator/researcher fan out
to the local Ollama worker.

| name            | backend  | model              | extra             | role                                                                                                                  |
| --------------- | -------- | ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| **coordinator** | `claude` | `claude-haiku-4-5` | —                 | Answers simple requests directly; delegates or splits work to peers; prefers the cheap local `worker` for grunt work. |
| **researcher**  | `claude` | `claude-haiku-4-5` | `webSearch: true` | Decomposes a question into sub-queries, fans them to peers, searches the web, and synthesizes a cited answer.         |
| **worker**      | `ollama` | `gemma4:e4b`       | —                 | General local worker: summarize, translate, review, reason. Cheap and tool-capable so it can delegate onward.         |

System prompts adapt the existing coordinator/researcher prompts; the worker
prompt folds in the old summarizer/translator/reviewer guidance as a
general-purpose local worker. Each agent advertises a small `skills` array.

`claude-haiku-4-5` is used as the alias, matching the repo's short-alias style
(`claude-sonnet-4-6`). If the alias is not accepted by the backend, fall back to
the dated id `claude-haiku-4-5-20251001`.

### Cleanup and reference migration (breaking change)

Old role names (`scout`, `analyst`, `summarizer`, `translator`, `code-reviewer`,
`coordinator-max`, and the old `coordinator`/`researcher` definitions) are
removed. The roster collapses to `coordinator` / `researcher` / `worker`.
Migration surface:

- **Delete** the `agents/` directory (all `*.json` + `role.schema.json`).
- **`.gitignore`** — add `agents.json`.
- **Functional code:**
  - `src/config.ts:66` — default `--agents` flag value `"coordinator,scout"` → a
    roster that exists (e.g. `"coordinator,worker"`); update the example
    comments at `config.ts:59,69` and `mcp.ts:3`.
  - `src/agent/tools.ts` (~line 230) — delegation prompt text names `summarizer`
    as an example; update to `worker` so agents see a valid peer.
  - `src/config.ts:21` and `src/agent/claude.ts` comments that use old names as
    examples — update to current names where they'd mislead.
- **Loader tests** (`tests/roles.test.ts`) — rewrite the directory-based tests
  (`loadRoles reads the project's agents/ directory`, the temp-dir `bad.json`
  test, the `coordinator-max` test) to the file-based model: defaults load &
  validate; `agents.json` fully replaces defaults when present; a malformed
  entry throws an error naming the offending `file#key`; missing both files
  throws a clear error.
- **Other tests / scripts / docs** — `scripts/smoke-gemma-tools.ts` references
  `roles.scout` / `roles.analyst` directly and must move to new names; other
  test files and `README.md` / `TODO.md` reference old role names as fixtures or
  prose and get updated to the new roster. (~16 files total contain references;
  most are fixtures that can adopt the new names mechanically.)

### Testing

- Loader unit tests as listed above (file-based load, full replacement, per-key
  error path, missing-files error).
- `deno task` test suite passes after the reference migration.
- A smoke check that the default roster boots: coordinator delegates to worker;
  researcher uses web_search + delegation. (Reuse/adapt existing smoke scripts.)

## Risks

- **Breaking change.** Anything referencing old role names breaks until
  migrated; accepted by the user. The reference sweep above is the mitigation.
- **Haiku tool-calling / model id.** If `claude-haiku-4-5` isn't a valid alias,
  fall back to the dated id.
- **Ollama availability.** The `worker` requires a running Ollama with
  `gemma4:e4b`; unchanged from today's local-worker assumption.
