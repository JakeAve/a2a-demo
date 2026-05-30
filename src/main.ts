import {
  assertBackendCredentials,
  getAgentsFlag,
  loadConfig,
  parseAgentsFlag,
} from "./config.ts";
import { loadRoles } from "./roles.ts";
import { runOrchestrator } from "./orchestrator.ts";

const cfg = await loadConfig();
const roles = await loadRoles();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles);

try {
  assertBackendCredentials(specs, cfg);
} catch (e) {
  console.error((e as Error).message);
  Deno.exit(1);
}

await runOrchestrator(cfg, specs, roles);
