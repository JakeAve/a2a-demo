// Role presets define what an agent IS (which backend, which model, which
// personality, which skills it advertises). The roster lives in a single
// JSON file: `agents.default.json` (committed). An optional gitignored
// `agents.json` fully replaces it when present. Each top-level key is a role
// name. `loadRoles()` reads the active file at startup, strips $schema, and
// validates each preset into a strictly-typed map.

import type { Skill } from "./protocol/types.ts";

export type Backend = "claude" | "ollama" | "claude-code";

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
  // Claude backend only: expose Anthropic's server-side web_search tool.
  webSearch?: boolean;
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
  if (
    o.backend !== "claude" && o.backend !== "ollama" &&
    o.backend !== "claude-code"
  ) {
    throw new Error(
      `${source}: backend must be "claude", "ollama", or "claude-code" (got ${
        JSON.stringify(o.backend)
      })`,
    );
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
    throw new Error(
      `${source}: skills must be an array of { id, name, description }`,
    );
  }
  if (o.toolCapable !== undefined && typeof o.toolCapable !== "boolean") {
    throw new Error(`${source}: toolCapable must be a boolean if present`);
  }
  if (o.webSearch !== undefined && typeof o.webSearch !== "boolean") {
    throw new Error(`${source}: webSearch must be a boolean if present`);
  }
  return {
    backend: o.backend,
    model: o.model,
    description: o.description,
    systemPrompt: o.systemPrompt,
    skills: o.skills,
    toolCapable: o.toolCapable as boolean | undefined,
    webSearch: o.webSearch as boolean | undefined,
  };
}

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
    throw new Error(
      `could not read agents file "${path}": ${(e as Error).message}`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: invalid JSON: ${(e as Error).message}`);
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `${path}: expected a JSON object mapping role name to preset`,
    );
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
