import { load } from "@std/dotenv";
import type { RolePreset } from "./roles.ts";

export type AppConfig = {
  registryPort: number;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  bearerToken: string;
  ollamaBaseUrl: string;
  ollamaApiKey: string; // for Ollama's hosted web_search API (empty = no web search)
  monitorUrl: string; // empty string = disabled
  maxDepth: number; // 0 = peg to current agent count; >0 = fixed cap
  roomBrokerPort: number;
  roomMaxTurns: number;
  agentDeadlineMs: number;
  humanDeadlineMs: number;
  humanName: string; // the human's room-member name (REPL participant)
};

export type AgentSpec = {
  name: string; // identity (e.g. "worker")
  preset: RolePreset; // role config
  model: string; // resolved model (preset.model or CLI override)
};

export async function loadConfig(): Promise<AppConfig> {
  await load({ export: true });
  const env = Deno.env.toObject();
  return {
    registryPort: Number(env.REGISTRY_PORT ?? 7890),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    claudeCodeOauthToken: env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    bearerToken: env.AGENT_BEARER_TOKEN ?? "local-dev-secret",
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    ollamaApiKey: env.OLLAMA_API_KEY ?? "",
    monitorUrl: env.A2A_MONITOR_URL ?? "",
    maxDepth: Number(env.A2A_MAX_DEPTH ?? 0),
    roomBrokerPort: Number(env.ROOM_BROKER_PORT ?? 7892),
    roomMaxTurns: Number(env.A2A_ROOM_MAX_TURNS ?? 24),
    agentDeadlineMs: Number(env.A2A_ROOM_AGENT_DEADLINE_MS ?? 120_000),
    humanDeadlineMs: Number(env.A2A_ROOM_HUMAN_DEADLINE_MS ?? 3_600_000),
    humanName: env.A2A_HUMAN_NAME ?? "human",
  };
}

// Throws with an actionable message if any spec's backend lacks its credential.
export function assertBackendCredentials(
  specs: AgentSpec[],
  cfg: AppConfig,
): void {
  const backends = new Set(specs.map((s) => s.preset.backend));
  if (backends.has("claude") && !cfg.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required for claude agents. Set it in .env",
    );
  }
  if (
    backends.has("claude-code") && !cfg.claudeCodeOauthToken &&
    !cfg.anthropicApiKey
  ) {
    throw new Error(
      "claude-code agents require CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Set one in .env",
    );
  }
}

/** Parse the --agents flag (`--agents=a,b` or `--agents a,b`); default "coordinator,worker". */
export function getAgentsFlag(args: string[]): string {
  for (const arg of args) {
    if (arg.startsWith("--agents=")) return arg.slice("--agents=".length);
  }
  const i = args.indexOf("--agents");
  if (i !== -1 && args[i + 1]) return args[i + 1];
  return "coordinator,worker";
}

// Parse "coordinator,worker:gemma3:1b,researcher" → AgentSpec[]
// Splits on the FIRST colon only so model tags like "gemma3:1b" survive.
export function parseAgentsFlag(
  raw: string,
  roles: Record<string, RolePreset>,
): AgentSpec[] {
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map(
    (entry) => {
      const colon = entry.indexOf(":");
      const name = colon === -1 ? entry : entry.slice(0, colon);
      const modelOverride = colon === -1 ? undefined : entry.slice(colon + 1);
      const preset = roles[name];
      if (!preset) {
        throw new Error(
          `Unknown role: ${name}. Known: ${Object.keys(roles).join(", ")}`,
        );
      }
      return { name, preset, model: modelOverride ?? preset.model };
    },
  );
}
