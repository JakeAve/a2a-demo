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

Deno.test("loadRoles reads the project's agents/ directory", async () => {
  const roles = await loadRoles();
  // Filenames become role names.
  assert(roles.coordinator, "coordinator should be loaded");
  assert(roles.scout, "scout should be loaded");
  assert(roles.analyst, "analyst should be loaded");
  // toolCapable propagates correctly.
  assertEquals(roles.coordinator.toolCapable, true);
  assertEquals(roles.analyst.toolCapable, true);
  // role.schema.json is ignored.
  assert(!("role.schema" in roles), "role.schema should not be a role");
});

Deno.test("loadRoles surfaces errors with file path", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/bad.json`, '{"backend":"nope"}');
  await assertRejects(() => loadRoles(dir), Error, "bad.json");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("loadRoles loads the coordinator-max claude-code role", async () => {
  const roles = await loadRoles();
  assert(roles["coordinator-max"], "coordinator-max should be loaded");
  assertEquals(roles["coordinator-max"].backend, "claude-code");
  assertEquals(roles["coordinator-max"].toolCapable, true);
});
