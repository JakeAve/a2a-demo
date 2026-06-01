import {
  assertBackendCredentials,
  getAgentsFlag,
  loadConfig,
  parseAgentsFlag,
} from "./config.ts";
import type { AgentSpec } from "./config.ts";
import { getCrew, listCrews, loadRoles } from "./roles.ts";
import { runOrchestrator } from "./orchestrator.ts";

function getCrewFlag(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--crew=")) return arg.slice("--crew=".length);
    if (arg === "--crew" && i + 1 < args.length) return args[i + 1];
  }
  return Deno.env.get("AGENT_CREW");
}

function hasAgentsFlag(args: string[]): boolean {
  return args.some((a) => a.startsWith("--agents=") || a === "--agents");
}

const cfg = await loadConfig();
const roles = await loadRoles();

let specs: AgentSpec[];
const crewName = getCrewFlag(Deno.args);

if (crewName !== undefined) {
  let crew;
  try {
    crew = getCrew(roles, crewName);
  } catch (e) {
    console.error((e as Error).message);
    console.error("Available crews: " + listCrews(roles).join(", "));
    Deno.exit(1);
  }
  console.log("Running crew: " + crewName);
  specs = crew!.map(({ name, ...preset }) => ({
    name,
    preset,
    model: preset.model,
  }));
} else if (!hasAgentsFlag(Deno.args) && roles.crews?.default) {
  const crew = getCrew(roles, "default");
  console.log("Running crew: default");
  specs = crew.map(({ name, ...preset }) => ({
    name,
    preset,
    model: preset.model,
  }));
} else {
  specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles.agents);
}

try {
  assertBackendCredentials(specs, cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}

await runOrchestrator(cfg, specs, roles.agents);
