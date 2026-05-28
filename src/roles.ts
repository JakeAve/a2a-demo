// Role presets define what an agent IS (which backend, which model, which
// personality, which skills it advertises). Each role lives in its own
// JSON file under `agents/`. The filename (minus `.json`) becomes the role
// name. `loadRoles()` reads the directory at startup, validates each file,
// and returns a strictly-typed map.

import type { Skill } from "./protocol/types.ts";

export type Backend = "claude" | "ollama";

export type RolePreset = {
  backend: Backend;
  model: string;
  description: string;
  systemPrompt: string;
  skills: Skill[];
  // When true, the agent is wired with the A2A tool runner (list_agents,
  // delegate_start, ...). Claude is always tool-capable; for Ollama, only
  // set this if the model actually supports function calling.
  toolCapable?: boolean;
};

function isSkill(v: unknown): v is Skill {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.id === "string" &&
    typeof s.name === "string" &&
    typeof s.description === "string";
}

export function validateRolePreset(v: unknown, source: string): RolePreset {
  if (!v || typeof v !== "object") {
    throw new Error(`${source}: not an object`);
  }
  const o = v as Record<string, unknown>;
  if (o.backend !== "claude" && o.backend !== "ollama") {
    throw new Error(`${source}: backend must be "claude" or "ollama" (got ${JSON.stringify(o.backend)})`);
  }
  if (typeof o.model !== "string" || !o.model) {
    throw new Error(`${source}: model must be a non-empty string`);
  }
  if (typeof o.description !== "string") {
    throw new Error(`${source}: description must be a string`);
  }
  if (typeof o.systemPrompt !== "string") {
    throw new Error(`${source}: systemPrompt must be a string`);
  }
  if (!Array.isArray(o.skills) || !o.skills.every(isSkill)) {
    throw new Error(`${source}: skills must be an array of { id, name, description }`);
  }
  if (o.toolCapable !== undefined && typeof o.toolCapable !== "boolean") {
    throw new Error(`${source}: toolCapable must be a boolean if present`);
  }
  return {
    backend: o.backend,
    model: o.model,
    description: o.description,
    systemPrompt: o.systemPrompt,
    skills: o.skills,
    toolCapable: o.toolCapable as boolean | undefined,
  };
}

export async function loadRoles(dir = "agents"): Promise<Record<string, RolePreset>> {
  const roles: Record<string, RolePreset> = {};
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch (e) {
    throw new Error(`could not read agents directory "${dir}": ${(e as Error).message}`);
  }
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    if (entry.name.startsWith("role.schema")) continue;
    const path = `${dir}/${entry.name}`;
    const name = entry.name.slice(0, -".json".length);
    let raw;
    try {
      raw = JSON.parse(await Deno.readTextFile(path));
    } catch (e) {
      throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
    }
    // Strip $schema if present (used by editors for autocomplete).
    if (raw && typeof raw === "object") delete raw.$schema;
    roles[name] = validateRolePreset(raw, path);
  }
  return roles;
}
