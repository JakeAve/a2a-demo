import { load } from "@std/dotenv";
import { roles, type RolePreset } from "./roles.config.ts";

export type AppConfig = {
  registryPort: number;
  anthropicApiKey: string;
  bearerToken: string;
  ollamaBaseUrl: string;
};

export type AgentSpec = {
  name: string;       // identity (e.g. "gemma3")
  preset: RolePreset; // role config
  model: string;      // resolved model (preset.model or CLI override)
};

export async function loadConfig(): Promise<AppConfig> {
  await load({ export: true });
  const env = Deno.env.toObject();
  return {
    registryPort: Number(env.REGISTRY_PORT ?? 7890),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    bearerToken: env.AGENT_BEARER_TOKEN ?? "local-dev-secret",
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  };
}

// Parse "sonnet,gemma3:gemma3:1b,code-reviewer" → AgentSpec[]
// Splits on the FIRST colon only so model tags like "gemma3:1b" survive.
export function parseAgentsFlag(raw: string): AgentSpec[] {
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const colon = entry.indexOf(":");
    const name = colon === -1 ? entry : entry.slice(0, colon);
    const modelOverride = colon === -1 ? undefined : entry.slice(colon + 1);
    const preset = roles[name];
    if (!preset) throw new Error(`Unknown role: ${name}. Known: ${Object.keys(roles).join(", ")}`);
    return { name, preset, model: modelOverride ?? preset.model };
  });
}
