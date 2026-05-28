import { loadConfig, parseAgentsFlag } from "./config.ts";
import { loadRoles } from "./roles.ts";
import { runOrchestrator } from "./orchestrator.ts";

function getAgentsFlag(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--agents=")) return arg.slice("--agents=".length);
  }
  const i = args.indexOf("--agents");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return "sonnet,gemma3";
}

const cfg = await loadConfig();
const roles = await loadRoles();
const specs = parseAgentsFlag(getAgentsFlag(Deno.args), roles);

if (specs.some((s) => s.preset.backend === "claude") && !cfg.anthropicApiKey) {
  console.error("ANTHROPIC_API_KEY is required for Claude agents. Set it in .env");
  Deno.exit(1);
}

await runOrchestrator(cfg, specs, roles);
