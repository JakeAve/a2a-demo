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
import { makeClaudeHandlers } from "./claude.ts";
import { makeClaudeCodeHandlers } from "./claude-code.ts";
import { makeOllamaHandlers } from "./ollama.ts";

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

export function buildHandlers(d: BuildHandlersDeps): Handlers {
  const { preset, cfg } = d;
  if (preset.backend === "claude") {
    return makeClaudeHandlers({
      model: d.model, systemPrompt: preset.systemPrompt, apiKey: cfg.anthropicApiKey,
      store: d.store, threads: d.threads, registry: d.registry, bearerToken: cfg.bearerToken,
      selfName: d.selfName, spawnAgent: d.spawnAgent, availableRoles: d.availableRoles,
      emit: d.emit,
    });
  }
  if (preset.backend === "claude-code") {
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
        }
      : undefined,
  });
}
