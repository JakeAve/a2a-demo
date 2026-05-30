import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadRoles, validateRolePreset } from "../src/roles.ts";

const GOOD = {
  backend: "ollama",
  model: "gemma3:1b",
  description: "test",
  systemPrompt: "be brief",
  skills: [{ id: "x", name: "x", description: "x" }],
  toolCapable: false,
};

Deno.test("validateRolePreset accepts a complete role", () => {
  const r = validateRolePreset(GOOD, "test");
  assertEquals(r.backend, "ollama");
  assertEquals(r.toolCapable, false);
});

Deno.test("validateRolePreset accepts claude-code backend", () => {
  const r = validateRolePreset({ ...GOOD, backend: "claude-code" }, "test");
  assertEquals(r.backend, "claude-code");
});

Deno.test("validateRolePreset rejects unknown backend", () => {
  assertThrows(
    () => validateRolePreset({ ...GOOD, backend: "vllm" }, "test"),
    Error,
    "backend",
  );
});

Deno.test("validateRolePreset rejects missing model", () => {
  const bad = { ...GOOD } as Record<string, unknown>;
  delete bad.model;
  assertThrows(() => validateRolePreset(bad, "test"), Error, "model");
});

Deno.test("validateRolePreset rejects malformed skills", () => {
  assertThrows(
    () => validateRolePreset({ ...GOOD, skills: [{ id: "x" }] }, "test"),
    Error,
    "skills",
  );
});

Deno.test("validateRolePreset rejects non-boolean toolCapable", () => {
  assertThrows(
    () => validateRolePreset({ ...GOOD, toolCapable: "yes" }, "test"),
    Error,
    "toolCapable",
  );
});

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
    {
      "agents.default.json": {
        "$schema": "x",
        coordinator: { ...GOOD, toolCapable: true },
      },
    },
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
      assert(
        !roles.coordinator,
        "defaults must NOT leak through when override exists",
      );
      assert(
        !roles.worker,
        "defaults must NOT leak through when override exists",
      );
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
      await assertRejects(
        () => loadRoles(opts),
        Error,
        "agents.default.json#broken",
      );
    },
  );
});

Deno.test("loadRoles rejects a non-object roster file", async () => {
  await withRoster(
    { "agents.default.json": [1, 2, 3] },
    async (opts) => {
      await assertRejects(
        () => loadRoles(opts),
        Error,
        "expected a JSON object",
      );
    },
  );
});

Deno.test("loadRoles errors clearly when no roster file exists", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(
    () =>
      loadRoles({
        overridePath: `${dir}/agents.json`,
        defaultPath: `${dir}/agents.default.json`,
      }),
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
