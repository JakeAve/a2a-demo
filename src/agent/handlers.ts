import type { AppConfig } from "../config.ts";
import type { RolePreset } from "../roles.ts";
import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { RegistryClient } from "../registry/client.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { AgentHandlerCtx } from "./base.ts";
import type { ToolDeps } from "./tools.ts";
import type { Emitter } from "../observability/emit.ts";
import { selectSearchProvider } from "./web-search.ts";
import { makeClaudeHandlers } from "./claude.ts";
import { makeOllamaHandlers } from "./ollama.ts";
// NOTE: claude-code.ts is imported lazily inside buildHandlers (not at module
// top) because it pulls in @anthropic-ai/claude-agent-sdk, which calls
// os.homedir() at import time and so requires --allow-sys. Only claude-code
// agents get that permission; a static import here would crash every Ollama /
// claude agent on boot (they'd never register). Loading it on demand keeps
// their permission set minimal and skips the heavy SDK init they never use.

export type Handlers = {
  handler: (ctx: AgentHandlerCtx) => Promise<{ text: string }>;
  streamHandler: (ctx: AgentHandlerCtx) => AsyncGenerator<StreamEvent>;
};

export type BuildHandlersDeps = {
  model: string;
  preset: RolePreset;
  cfg: AppConfig;
  store: ContextStore;
  threads: ThreadStore;
  sessions: SessionStore;
  registry: RegistryClient;
  selfName: string;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
  emit?: Emitter;
};

export async function buildHandlers(d: BuildHandlersDeps): Promise<Handlers> {
  const { preset, cfg } = d;
  if (preset.backend === "claude") {
    return makeClaudeHandlers({
      model: d.model, systemPrompt: preset.systemPrompt, apiKey: cfg.anthropicApiKey,
      store: d.store, threads: d.threads, registry: d.registry, bearerToken: cfg.bearerToken,
      selfName: d.selfName, spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
      emit: d.emit, webSearch: preset.webSearch,
    });
  }
  if (preset.backend === "claude-code") {
    const { makeClaudeCodeHandlers } = await import("./claude-code.ts");
    return makeClaudeCodeHandlers({
      model: d.model, systemPrompt: preset.systemPrompt,
      oauthToken: cfg.claudeCodeOauthToken, apiKey: cfg.anthropicApiKey,
      store: d.store, threads: d.threads, sessions: d.sessions, registry: d.registry,
      bearerToken: cfg.bearerToken, selfName: d.selfName,
      spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
      emit: d.emit,
    });
  }
  return makeOllamaHandlers({
    model: d.model, systemPrompt: preset.systemPrompt, baseUrl: cfg.ollamaBaseUrl, store: d.store,
    tools: preset.toolCapable
      ? {
          store: d.store, threads: d.threads, registry: d.registry, bearerToken: cfg.bearerToken,
          selfName: d.selfName, spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
          emit: d.emit,
          search: preset.webSearch ? selectSearchProvider(cfg) : undefined,
        }
      : undefined,
  });
}
