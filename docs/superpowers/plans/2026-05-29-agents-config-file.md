# Agents Config File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-file `agents/` directory with a committed `agents.default.json` roster plus an optional gitignored `agents.json` that fully replaces it, and redefine the roster as 3 light tool-using agents.

**Architecture:** `loadRoles()` becomes file-based: it reads `agents.json` if present, else `agents.default.json`, strips a top-level `$schema`, and validates each `name → preset` entry with the unchanged `validateRolePreset()`. The roster collapses from 9 roles to `coordinator` (Claude Haiku), `researcher` (Claude Haiku + web_search), and `worker` (Ollama gemma4:e4b) — all tool-capable.

**Tech Stack:** Deno + TypeScript, `@std/assert` for tests, JSON config files validated at startup.

---

## File Structure

- **Create** `agents.default.json` — committed default roster (map of `name → RolePreset`).
- **Create** `agents.schema.json` — JSON Schema for the roster map (editor autocomplete).
- **Modify** `src/roles.ts` — rewrite `loadRoles()` from directory-based to file-based; update the file's top doc comment.
- **Modify** `tests/roles.test.ts` — replace the directory-based `loadRoles` tests with file-based tests; keep the `validateRolePreset` tests unchanged.
- **Modify** `.gitignore` — add `agents.json`.
- **Modify** `src/config.ts` — change the default `--agents` flag and its example comments.
- **Modify** `src/agent/tools.ts` — update the delegation-prompt example that names `summarizer`.
- **Modify** `tests/agent/delegation-prompt.test.ts` — pin the two `loadRoles()` calls to the default file so a local `agents.json` can't break them.
- **Modify** `scripts/smoke.ts`, `scripts/smoke-gemma-tools.ts`, `scripts/smoke-streaming-tools.ts`, `scripts/smoke-mcp.ts` — update old role names to the new roster.
- **Modify** `README.md`, `TODO.md` — update roster docs and `--agents` examples.
- **Delete** `agents/` directory (all `*.json` + `role.schema.json`).

`RolePreset`, `Backend`, `isSkill`, and `validateRolePreset` are **unchanged**.

---

## Task 1: Create the roster schema and default file

**Files:**
- Create: `agents.schema.json`
- Create: `agents.default.json`

- [ ] **Step 1: Write `agents.schema.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "A2A Agents Roster",
  "description": "A map of role name to role preset. agents.default.json is committed; an optional gitignored agents.json fully replaces it when present.",
  "type": "object",
  "properties": {
    "$schema": { "type": "string" }
  },
  "additionalProperties": {
    "type": "object",
    "required": ["backend", "model", "description", "systemPrompt", "skills"],
    "additionalProperties": false,
    "properties": {
      "backend": {
        "enum": ["claude", "ollama", "claude-code"],
        "description": "Which inference backend handles this role."
      },
      "model": {
        "type": "string",
        "description": "Backend-specific model identifier (e.g. 'claude-haiku-4-5' or 'gemma4:e4b')."
      },
      "description": {
        "type": "string",
        "description": "One-sentence summary shown to peer agents in list_agents."
      },
      "systemPrompt": {
        "type": "string",
        "description": "System prompt prepended to every conversation."
      },
      "skills": {
        "type": "array",
        "description": "Capabilities surfaced via the Agent Card.",
        "items": {
          "type": "object",
          "required": ["id", "name", "description"],
          "additionalProperties": false,
          "properties": {
            "id": { "type": "string" },
            "name": { "type": "string" },
            "description": { "type": "string" }
          }
        }
      },
      "toolCapable": {
        "type": "boolean",
        "description": "Set true if the model supports function calling. Claude is always true; Ollama models vary."
      },
      "webSearch": {
        "type": "boolean",
        "description": "Claude backend only: expose Anthropic's server-side web_search tool."
      }
    }
  }
}
```

- [ ] **Step 2: Write `agents.default.json`**

```json
{
  "$schema": "./agents.schema.json",
  "coordinator": {
    "backend": "claude",
    "model": "claude-haiku-4-5",
    "description": "Lightweight coordinator (Claude Haiku). Answers simple requests directly and delegates the rest to peers.",
    "systemPrompt": "You are a coordinator. For a simple request, answer directly. Delegate when a peer is better suited — a better capability or a cheaper/faster model — or when the work splits into independent parts. Prefer the cheap local 'worker' peer for grunt work. When the user names a peer or asks you to route work to one (e.g. \"have the researcher do X\", \"forward this to the worker\"), delegate it as asked rather than answering in their place. Stay concise.",
    "skills": [
      { "id": "coordinate", "name": "Coordinate", "description": "Plans and delegates complex tasks" }
    ],
    "toolCapable": true
  },
  "researcher": {
    "backend": "claude",
    "model": "claude-haiku-4-5",
    "description": "Lightweight research coordinator (Claude Haiku). Decomposes a question, fans sub-queries to peers, searches the web, and synthesizes.",
    "systemPrompt": "You are a research coordinator. Your strength is breaking a question into independent sub-questions, fanning them out to peer agents, and synthesizing the returns. You also have a web_search tool — use it for current, factual, or verifiable information instead of relying on memory or guessing. For a broad or multi-part question, decompose and delegate: call list_agents first, then delegate a few standalone sub-questions on distinct threads (prefer the cheap local 'worker' for grunt work), and synthesize the results into one answer that cites which peer contributed what. For a narrow question you can answer well in one turn, just answer it (searching the web as needed). When you're asked to route a result onward — e.g. forward your findings to a peer — actually call the delegation tool to do it; don't just say you will. Use the 'worker' peer for any long text you need condensed.",
    "skills": [
      { "id": "research", "name": "Research", "description": "Decomposes questions and synthesizes peer responses" },
      { "id": "synthesis", "name": "Synthesis", "description": "Combines partial answers from peers into one coherent reply" }
    ],
    "toolCapable": true,
    "webSearch": true
  },
  "worker": {
    "backend": "ollama",
    "model": "gemma4:e4b",
    "description": "Fast local worker (gemma4:e4b). Summarizes, translates, reviews code, and reasons over text. Cheap and tool-capable.",
    "systemPrompt": "You are a fast, capable local worker. You handle focused tasks directly and concisely: summarizing long text into a few key bullets, translating between human languages or structured formats (JSON, SQL, regex, etc.), reviewing code or diffs for bugs and style, and general reasoning over text. Default to a tight, no-preamble answer in whatever shape the task implies — bullets for summaries, raw output for format conversions, a terse severity-tagged findings list for reviews. Preserve specific names, dates, numbers, and decisions; drop hedges and filler. You are tool-capable: you can call list_agents and delegate a narrow sub-question to a peer when it clearly helps, but usually just do the work yourself.",
    "skills": [
      { "id": "summarize", "name": "Summarize", "description": "Condenses long text into bulleted key points" },
      { "id": "translate", "name": "Translate", "description": "Converts between human languages and structured formats" },
      { "id": "review", "name": "Review", "description": "Reviews code and diffs for bugs and style" },
      { "id": "reason", "name": "Reason", "description": "General reasoning over text" }
    ],
    "toolCapable": true
  }
}
```

- [ ] **Step 3: Verify both files parse and every entry is a valid preset**

Run:
```bash
deno eval '
import { validateRolePreset } from "./src/roles.ts";
const raw = JSON.parse(await Deno.readTextFile("agents.default.json"));
delete raw.$schema;
for (const [name, v] of Object.entries(raw)) { validateRolePreset(v, "agents.default.json#" + name); }
JSON.parse(await Deno.readTextFile("agents.schema.json"));
console.log("OK:", Object.keys(raw).join(", "));
'
```
Expected: `OK: coordinator, researcher, worker`

- [ ] **Step 4: Commit**

```bash
git add agents.default.json agents.schema.json
git commit -m "feat(agents): add agents.default.json roster + agents.schema.json"
```

---

## Task 2: Rewrite `loadRoles()` to be file-based (TDD)

**Files:**
- Modify: `src/roles.ts:70-94` (replace `loadRoles`) and `src/roles.ts:1-5` (doc comment)
- Test: `tests/roles.test.ts:54-79` (replace the three directory-based tests; keep `validateRolePreset` tests at lines 1-52)

- [ ] **Step 1: Replace the directory-based loader tests with file-based tests**

In `tests/roles.test.ts`, **delete** the three existing tests below the `validateRolePreset` tests (the current lines 54-79: `loadRoles reads the project's agents/ directory`, `loadRoles surfaces errors with file path`, and `loadRoles loads the coordinator-max claude-code role`). Keep everything from line 1 through the `rejects non-boolean toolCapable` test unchanged. Append the following:

```typescript
// Helper: write roster files into a temp dir and run loadRoles against them.
async function withRoster(
  files: Record<string, unknown>,
  run: (opts: { overridePath: string; defaultPath: string }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const opts = {
    overridePath: `${dir}/agents.json`,
    defaultPath: `${dir}/agents.default.json`,
  };
  for (const [name, value] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${name}`, JSON.stringify(value));
  }
  try {
    await run(opts);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadRoles loads the default roster and strips $schema", async () => {
  await withRoster(
    { "agents.default.json": { "$schema": "x", coordinator: { ...GOOD, toolCapable: true } } },
    async (opts) => {
      const roles = await loadRoles(opts);
      assert(roles.coordinator, "coordinator should load");
      assertEquals(roles.coordinator.toolCapable, true);
      assert(!("$schema" in roles), "$schema must not become a role");
    },
  );
});

Deno.test("agents.json fully replaces the default when present", async () => {
  await withRoster(
    {
      "agents.default.json": { coordinator: GOOD, worker: GOOD },
      "agents.json": { mybot: GOOD },
    },
    async (opts) => {
      const roles = await loadRoles(opts);
      assert(roles.mybot, "override role should load");
      assert(!roles.coordinator, "defaults must NOT leak through when override exists");
      assert(!roles.worker, "defaults must NOT leak through when override exists");
    },
  );
});

Deno.test("loadRoles falls back to the default when override is absent", async () => {
  await withRoster(
    { "agents.default.json": { coordinator: GOOD } },
    async (opts) => {
      const roles = await loadRoles(opts);
      assert(roles.coordinator, "default loads when agents.json absent");
    },
  );
});

Deno.test("loadRoles surfaces validation errors with file#key", async () => {
  await withRoster(
    { "agents.default.json": { broken: { backend: "nope" } } },
    async (opts) => {
      await assertRejects(() => loadRoles(opts), Error, "agents.default.json#broken");
    },
  );
});

Deno.test("loadRoles rejects a non-object roster file", async () => {
  await withRoster(
    { "agents.default.json": [1, 2, 3] },
    async (opts) => {
      await assertRejects(() => loadRoles(opts), Error, "expected a JSON object");
    },
  );
});

Deno.test("loadRoles errors clearly when no roster file exists", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(
    () => loadRoles({ overridePath: `${dir}/agents.json`, defaultPath: `${dir}/agents.default.json` }),
    Error,
    "could not read agents file",
  );
  await Deno.remove(dir, { recursive: true });
});

Deno.test("the committed agents.default.json is the light tool-using roster", async () => {
  // Pin to the default file so a local (gitignored) agents.json can't affect this.
  const roles = await loadRoles({ overridePath: "agents.default.json" });
  assert(roles.coordinator, "coordinator present");
  assert(roles.researcher, "researcher present");
  assert(roles.worker, "worker present");
  assertEquals(roles.coordinator.backend, "claude");
  assertEquals(roles.researcher.webSearch, true);
  assertEquals(roles.worker.backend, "ollama");
  assertEquals(roles.coordinator.toolCapable, true);
  assertEquals(roles.worker.toolCapable, true);
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `deno task test -- tests/roles.test.ts`
Expected: FAIL — `loadRoles` still has the old `(dir = "agents")` signature, so the `opts`-object calls read a path like `[object Object]` and the default-file test/error-message assertions don't match.

- [ ] **Step 3: Rewrite `loadRoles` in `src/roles.ts`**

Replace the function at `src/roles.ts:70-94` with:

```typescript
export type LoadRolesOptions = {
  /** Local override file; when it exists it fully replaces the default. */
  overridePath?: string;
  /** Committed default roster file. */
  defaultPath?: string;
};

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

export async function loadRoles(
  opts: LoadRolesOptions = {},
): Promise<Record<string, RolePreset>> {
  const overridePath = opts.overridePath ?? "agents.json";
  const defaultPath = opts.defaultPath ?? "agents.default.json";

  // The override fully replaces the default when present — no merge.
  const path = (await fileExists(overridePath)) ? overridePath : defaultPath;

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    throw new Error(`could not read agents file "${path}": ${(e as Error).message}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${path}: expected a JSON object mapping role name to preset`);
  }

  const obj = raw as Record<string, unknown>;
  // Strip $schema (used by editors for autocomplete), not a role.
  delete obj.$schema;

  const roles: Record<string, RolePreset> = {};
  for (const [name, value] of Object.entries(obj)) {
    roles[name] = validateRolePreset(value, `${path}#${name}`);
  }
  return roles;
}
```

- [ ] **Step 4: Update the file's top doc comment**

Replace `src/roles.ts:1-5` with:

```typescript
// Role presets define what an agent IS (which backend, which model, which
// personality, which skills it advertises). The roster lives in a single
// JSON file: `agents.default.json` (committed). An optional gitignored
// `agents.json` fully replaces it when present. Each top-level key is a role
// name. `loadRoles()` reads the active file at startup, strips $schema, and
// validates each preset into a strictly-typed map.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `deno task test -- tests/roles.test.ts`
Expected: PASS (all `validateRolePreset` tests plus the seven new `loadRoles` tests).

- [ ] **Step 6: Commit**

```bash
git add src/roles.ts tests/roles.test.ts
git commit -m "feat(roles): file-based loadRoles with full-replacement override"
```

---

## Task 3: Delete the old `agents/` directory and gitignore the override

**Files:**
- Delete: `agents/` (directory)
- Modify: `.gitignore`

- [ ] **Step 1: Add `agents.json` to `.gitignore`**

The current `.gitignore` is:
```
.env
.DS_Store
deno.lock
.superpowers/
a2a-monitor.db*
```
Append a line so it reads:
```
.env
.DS_Store
deno.lock
.superpowers/
a2a-monitor.db*
agents.json
```

- [ ] **Step 2: Delete the old directory**

Run:
```bash
git rm -r agents/
```
Expected: removes `agents/analyst.json`, `code-reviewer.json`, `coordinator-max.json`, `coordinator.json`, `researcher.json`, `role.schema.json`, `scout.json`, `summarizer.json`, `translator.json`.

- [ ] **Step 3: Verify the loader still works against the committed default**

Run: `deno task test -- tests/roles.test.ts`
Expected: PASS (unchanged — the loader reads `agents.default.json`, not `agents/`).

- [ ] **Step 4: Commit**

```bash
git add .gitignore agents/
git commit -m "chore(agents): delete agents/ directory, gitignore agents.json"
```

---

## Task 4: Update functional code references (config default + delegation prompt)

**Files:**
- Modify: `src/config.ts:59,66,69` and `src/mcp.ts:3`
- Modify: `src/agent/tools.ts` (~line 230)
- Modify: `tests/agent/delegation-prompt.test.ts:37,53`

- [ ] **Step 1: Update the delegation-prompt tests to pin to the default file**

In `tests/agent/delegation-prompt.test.ts`, change both occurrences of:
```typescript
  const roles = await loadRoles();
```
to:
```typescript
  // Pin to the committed defaults so a local agents.json can't affect this.
  const roles = await loadRoles({ overridePath: "agents.default.json" });
```
(There are two — one in the `researcher prompt defaults to decompose-and-delegate` test at line 37, one in the `coordinator prompt honors named-peer routing` test at line 53.)

- [ ] **Step 2: Run the delegation-prompt tests to verify they still pass**

Run: `deno task test -- tests/agent/delegation-prompt.test.ts`
Expected: PASS — the new `researcher` prompt contains "breaking"/"sub-question"/"decompose" and "delegat"; the new `coordinator` prompt contains "route". (If a test fails, the prompt text in `agents.default.json` is missing an asserted phrase — fix the prompt, not the test.)

- [ ] **Step 3: Change the default `--agents` flag in `src/config.ts`**

At `src/config.ts:59`, change the JSDoc comment:
```typescript
/** Parse the --agents flag (`--agents=a,b` or `--agents a,b`); default "coordinator,worker". */
```
At `src/config.ts:66`, change the fallback return:
```typescript
  return "coordinator,worker";
```
At `src/config.ts:69`, change the example comment:
```typescript
// Parse "coordinator,worker:gemma3:1b,researcher" → AgentSpec[]
```

- [ ] **Step 4: Update the `--agents` example comment in `src/mcp.ts`**

At `src/mcp.ts:3`, change:
```typescript
//   deno task mcp --agents="coordinator,worker"
```

- [ ] **Step 5: Update the delegation-prompt example in `src/agent/tools.ts`**

At `src/agent/tools.ts` (~line 230), in the paragraph beginning "If you are explicitly asked to delegate", change the example so it names a real peer:
```
hand a result onward (e.g. "have the researcher do X", "forward this to the
worker"), then do it — actually call the delegation tool. An explicit
```
(Only the word `summarizer` → `worker` changes; the rest of the sentence is unchanged.)

- [ ] **Step 6: Verify config and tools type-check**

Run: `deno check src/config.ts src/mcp.ts src/agent/tools.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/mcp.ts src/agent/tools.ts tests/agent/delegation-prompt.test.ts
git commit -m "feat: point default roster + delegation prompt at coordinator/researcher/worker"
```

---

## Task 5: Update the smoke scripts to the new roster

**Files:**
- Modify: `scripts/smoke.ts`
- Modify: `scripts/smoke-gemma-tools.ts`
- Modify: `scripts/smoke-streaming-tools.ts`
- Modify: `scripts/smoke-mcp.ts`

Name mapping for these scripts: `scout` → `worker`, `analyst` → `worker`, `coordinator-max` → `coordinator`. (The scripts only need *some* valid role; `worker` is the local Ollama agent that replaces both `scout` and `analyst`.)

- [ ] **Step 1: Update `scripts/smoke.ts`**

Replace every `roles.scout` with `roles.worker`, every `"scout"` string literal with `"worker"`, and the variable/label `scout` with `worker` (lines ~38, 43, 125). The `coordinator` references (lines ~95-108, 143-161) are unchanged. For the `coordinator-max` block (lines ~191-199), change `roles["coordinator-max"]` → `roles.coordinator`, `selfName: "coordinator-max"` → `selfName: "coordinator"`, and `baseCard("coordinator-max", ...)` → `baseCard("coordinator", ...)` — OR delete that block if it only existed to exercise the claude-code backend (the new default roster has no claude-code role). Prefer deleting the `coordinator-max` block, since the roster no longer ships a claude-code role.

- [ ] **Step 2: Update `scripts/smoke-gemma-tools.ts`**

This script boots a tool-capable agent that delegates to a passive worker. Replace:
- `roles.scout` → `roles.worker` (lines ~39, 44) and the `"scout"` label/card name → `"worker"` (lines ~44, 50, 84, 103).
- `roles.analyst` → `roles.worker` and the `"analyst"` label/card name/`selfName` → a second instance name like `"captain"` (lines ~55, 63, 68, 74, 84, 102, 108).

Since both old roles now map to `worker`, give the two agents distinct **instance names** while sharing the `worker` preset, e.g.:
```typescript
// passive worker instance (no tools)
const worker = await startAgent({
  card: baseCard("scout", roles.worker),
  // ...
});
```
becomes
```typescript
const helper = await startAgent({
  card: baseCard("helper", roles.worker),
  // ...
});
```
and the tool-capable instance uses `baseCard("captain", roles.worker)` with `selfName: "captain"`. Update the `ask(...)` target strings and prompt text (lines ~100-109) to reference `captain`/`helper` instead of `analyst`/`scout`. Update the leading comment block (lines 1-4) to describe captain/helper.

- [ ] **Step 3: Update `scripts/smoke-streaming-tools.ts`**

Same pattern as Step 2: `roles.scout` → `roles.worker` (lines ~35, 40), `roles.analyst` → `roles.worker` (line ~49), and rename the instance labels/`selfName` (`"scout"`/`"analyst"`, lines ~40, 57, 61) to distinct instance names sharing the `worker` preset.

- [ ] **Step 4: Update `scripts/smoke-mcp.ts`**

At `scripts/smoke-mcp.ts:5` (comment) and `:18` (arg), change `--agents=scout` → `--agents=worker`.

- [ ] **Step 5: Verify all smoke scripts type-check**

Run: `deno check scripts/smoke.ts scripts/smoke-gemma-tools.ts scripts/smoke-streaming-tools.ts scripts/smoke-mcp.ts`
Expected: no errors. (These scripts hit Ollama/Claude at runtime; type-checking is the gate here, not execution.)

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke.ts scripts/smoke-gemma-tools.ts scripts/smoke-streaming-tools.ts scripts/smoke-mcp.ts
git commit -m "chore(scripts): update smoke scripts to coordinator/researcher/worker roster"
```

---

## Task 6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `TODO.md`

- [ ] **Step 1: Replace the README "Agents" section**

Replace `README.md:24-47` (from `## Agents` through the `--override a model` paragraph) with:

````markdown
## Agents

The roster lives in **`agents.default.json`** (committed) — a JSON object
mapping role name to preset. To customize locally, create **`agents.json`**
(gitignored); when present it **fully replaces** the default roster. The shape
of both files is described by `agents.schema.json` (referenced via `$schema`
for editor autocomplete).

Agent names are identities, deliberately **decoupled from the model** that
backs them — so a role can swap models without breaking how peers address it.

| Role | Backend | Tools | Purpose |
|---|---|---|---|
| `coordinator` | Claude API (`claude-haiku-4-5`) | yes | Answers simple requests; delegates the rest to peers |
| `researcher` | Claude API (`claude-haiku-4-5`) | yes + web_search | Decomposes questions, delegates, synthesizes |
| `worker` | Ollama (`gemma4:e4b`) | yes | Local worker: summarize, translate, review, reason |

**Add or change agents:** create `agents.json` (it fully replaces the default
roster) with one entry per role matching the shape in `agents.schema.json`.
Restart. No code changes needed.

**Override a model at the CLI:** `--agents="coordinator,worker:gemma3:1b"`
runs the `worker` role with the `gemma3:1b` tag.
````

- [ ] **Step 2: Update the remaining README `--agents` examples and role mentions**

Find them:
```bash
grep -nE "coordinator,scout,analyst|\bscout\b|\banalyst\b|coordinator-max|--agents=scout|--role=analyst" README.md
```
Update each:
- `--agents="coordinator,scout,analyst"` (lines ~13, 52, 145, 162, 174) → `--agents="coordinator,researcher,worker"`.
- The architecture block lane labels `[scout]` / `[analyst]` (lines ~56-57) → `[researcher]` / `[worker]`.
- `> @analyst use list_agents...` / `ask scout to...` example REPL lines (lines ~17, 19) → use `worker`.
- `deno task start:agent --role=analyst ...` (line ~111) → `--role=worker`.
- The `scripts/smoke-gemma-tools.ts` description (line ~120) referencing `analyst` → describe the captain/helper worker probe from Task 5.
- The depth example `coordinator, researcher, scout` (line ~98) → `coordinator, researcher, worker`.

- [ ] **Step 3: Update `TODO.md`**

Find the reference:
```bash
grep -niE "scout|analyst|summarizer|translator|code-reviewer|coordinator-max" TODO.md
```
Update any old role name to the nearest new role (`worker` for the Ollama workers, `coordinator`/`researcher` for the Claude roles). If a TODO item is specifically about a now-removed role, reword it to the new roster or delete it if obsolete.

- [ ] **Step 4: Verify no stale role names remain in docs**

Run:
```bash
grep -rnE "\bscout\b|\banalyst\b|\bsummarizer\b|\btranslator\b|code-reviewer|coordinator-max" README.md TODO.md
```
Expected: no output (or only intentional historical mentions you've consciously kept).

- [ ] **Step 5: Commit**

```bash
git add README.md TODO.md
git commit -m "docs: document agents.default.json roster + new coordinator/researcher/worker set"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `deno task test`
Expected: PASS. Pure-fixture tests that use the strings `"scout"`/`"coordinator"` (e.g. `tests/repl-parse.test.ts`, `tests/monitor/layout.test.ts`) do **not** load real roles and pass unchanged — leave them as-is.

- [ ] **Step 2: Type-check the whole project**

Run: `deno check src/main.ts src/mcp.ts src/agent-entry.ts`
Expected: no errors.

- [ ] **Step 3: Confirm no code reads the deleted `agents/` directory**

Run:
```bash
grep -rnE "\"agents\"|'agents'|agents/role\.schema|readDir" src/ scripts/
```
Expected: no references to the old `agents/` directory or `Deno.readDir` for roles. (`/agents/:name` registry HTTP routes in `src/registry/` are unrelated and expected.)

- [ ] **Step 4: Smoke-boot the default roster (optional, requires API key + Ollama)**

Run: `deno task start --agents="coordinator,worker"`
Expected: registry + coordinator + worker boot with no role-loading errors; Ctrl-C to exit. Skip if no Ollama/API key is available — the test suite is the gate.

---

## Self-Review Notes

- **Spec coverage:** file layout (Task 1), full-replacement loader (Task 2), `$schema` stripping (Tasks 1-2), delete `agents/` + gitignore (Task 3), 3-agent light roster (Task 1), reference migration — config default, tools prompt, loader tests, smoke scripts, docs (Tasks 4-6), testing (Tasks 2 & 7). All spec sections map to a task.
- **Prompt assertions:** the `researcher`/`coordinator` prompts in Task 1 are written to satisfy `tests/agent/delegation-prompt.test.ts` (contain "decompose/break/sub-question", "delegat", "route"; omit the forbidden "that's usually the right call" / "don't split a question you could answer yourself" / "answer most requests yourself" phrasings).
- **Type consistency:** `LoadRolesOptions { overridePath?, defaultPath? }` is defined in Task 2 and used in Tasks 2 & 4 with the same field names. `loadRoles()` keeps a zero-arg call for all production callers.
- **Override safety:** every test that asserts on the committed defaults pins via `{ overridePath: "agents.default.json" }` so a developer's local `agents.json` cannot break the suite.
