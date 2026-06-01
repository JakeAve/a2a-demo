// Role presets define what an agent IS (which backend, which model, which
// personality, which skills it advertises). The roster lives in a single
// JSON file: `agents.default.json` (committed). An optional gitignored
// `agents.json` is merged on top when present. Each agent entry lives under
// the top-level "agents" key. `loadRoles()` reads the active file(s) at
// startup, strips $schema, merges, validates, and returns an AgentRoster.

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
  // Expose a web_search tool. claude backend uses Anthropic's server-side
  // web_search; a tool-capable ollama backend uses Ollama's hosted search API
  // (needs OLLAMA_API_KEY, else silently absent). Ignored by claude-code.
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

export type CrewDef = {
  agents: string[];
  agentOverrides?: Record<string, Partial<RolePreset>>;
};

export type AgentRoster = {
  agents: Record<string, RolePreset>;
  crews?: Record<string, CrewDef>;
};

// Resolved agent entry returned by getCrew — agent name plus merged config.
export type ResolvedAgent = RolePreset & { name: string };

export function mergeConfig(
  base: AgentRoster,
  override: Partial<AgentRoster>,
): AgentRoster {
  const merged: AgentRoster = {
    agents: { ...base.agents },
    crews: { ...base.crews },
  };
  if (override.agents !== undefined) {
    // Per-agent shallow merge — preserves fields not mentioned in override
    // e.g. override just "model" and keep inherited "role"
    merged.agents = { ...base.agents };
    for (const agentName in override.agents) {
      merged.agents[agentName] = {
        ...(base.agents?.[agentName] ?? {}),
        ...override.agents[agentName],
      } as RolePreset;
    }
  }
  if (override.crews !== undefined) {
    // crews are replaced per-entry, not wholesale
    merged.crews = { ...(base.crews ?? {}), ...override.crews };
  }
  return merged;
}

export function validateCrews(config: AgentRoster): void {
  if (!config.crews) return;
  const errors: string[] = [];
  const availableAgents = Object.keys(config.agents);
  for (const [crewName, crewDef] of Object.entries(config.crews)) {
    if (!crewDef.agents || crewDef.agents.length === 0) {
      errors.push('Crew "' + crewName + '": must have at least one agent');
      continue;
    }
    for (const agentName of crewDef.agents) {
      if (!config.agents[agentName]) {
        errors.push(
          'Crew "' + crewName + '": unknown agent "' + agentName +
            '". Available agents: ' + availableAgents.join(", "),
        );
      }
    }
    if (crewDef.agentOverrides) {
      for (const agentName of Object.keys(crewDef.agentOverrides)) {
        if (!config.agents[agentName]) {
          errors.push(
            'Crew "' + crewName +
              '": agentOverrides references unknown agent "' + agentName +
              '". Available agents: ' + availableAgents.join(", "),
          );
        } else if (!crewDef.agents.includes(agentName)) {
          errors.push(
            'Crew "' + crewName + '": agentOverrides references agent "' +
              agentName + "\" not in this crew's agents list",
          );
        }
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

export function getCrew(config: AgentRoster, name: string): ResolvedAgent[] {
  const crewNames = Object.keys(config.crews ?? {});
  const crewDef = config.crews?.[name];
  if (!crewDef) {
    throw new Error(
      'Unknown crew "' + name + '". Available crews: ' + crewNames.join(", "),
    );
  }
  return crewDef.agents.map((agentName) => {
    const base = config.agents[agentName];
    const overrides = crewDef.agentOverrides?.[agentName] ?? {};
    return { name: agentName, ...base, ...overrides };
  });
}

export function listCrews(config: AgentRoster): string[] {
  return Object.keys(config.crews ?? {});
}

export type LoadRolesOptions = {
  /** Local override file; when it exists it is merged on top of the default. */
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

function parseRosterFile(
  obj: Record<string, unknown>,
  path: string,
): AgentRoster {
  delete obj.$schema;
  // New format: has explicit "agents" key
  if (obj.agents !== undefined) {
    if (typeof obj.agents !== "object" || Array.isArray(obj.agents)) {
      throw new Error(path + ': "agents" must be an object');
    }
    const agentsObj = obj.agents as Record<string, unknown>;
    const agents: Record<string, RolePreset> = {};
    for (const [name, value] of Object.entries(agentsObj)) {
      agents[name] = validateRolePreset(value, path + "#" + name);
    }
    const crews = obj.crews as Record<string, CrewDef> | undefined;
    return { agents, crews };
  }
  // Backward compat: flat format — all remaining keys are role names
  const agents: Record<string, RolePreset> = {};
  for (const [name, value] of Object.entries(obj)) {
    if (name === "crews") continue;
    agents[name] = validateRolePreset(value, path + "#" + name);
  }
  const crews = obj.crews as Record<string, CrewDef> | undefined;
  return { agents, crews };
}

export async function loadRoles(
  opts: LoadRolesOptions = {},
): Promise<AgentRoster> {
  const overridePath = opts.overridePath ?? "agents.json";
  const defaultPath = opts.defaultPath ?? "agents.default.json";

  const readAndParse = async (path: string): Promise<AgentRoster> => {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch (e) {
      throw new Error(
        'could not read agents file "' + path + '": ' + (e as Error).message,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new Error(path + ": invalid JSON: " + (e as Error).message);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        path + ": expected a JSON object mapping role name to preset",
      );
    }
    return parseRosterFile(raw as Record<string, unknown>, path);
  };

  const base = await readAndParse(defaultPath);
  const hasOverride = await fileExists(overridePath);
  const merged = hasOverride
    ? mergeConfig(base, await readAndParse(overridePath))
    : base;
  validateCrews(merged);
  return merged;
}
