// Subscription-backed Claude agents via the Claude Agent SDK.
// Prefers a Claude Code OAuth token, falls back to an Anthropic API key.

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { SessionStore } from "../store/sessions.ts";
import type { RegistryClient } from "../registry/client.ts";
import type { ToolDeps } from "./tools.ts";
import { a2aToolNames, buildA2aMcpServer } from "./claude-code-tools.ts";

export function resolveClaudeCodeEnv(
  baseEnv: Record<string, string>,
  oauthToken: string,
  apiKey: string,
): Record<string, string> {
  const env = { ...baseEnv };
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    delete env.ANTHROPIC_API_KEY;
  } else if (apiKey) {
    env.ANTHROPIC_API_KEY = apiKey;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    throw new Error(
      "claude-code backend requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  }
  return env;
}

// Minimal view of the SDK messages we consume; injectable for tests.
type SdkMessage =
  | { type: "assistant"; session_id: string; message: { content: Array<{ type: string; text?: string }> } }
  | { type: "result"; subtype: string; session_id: string; result?: string; errors?: string[] }
  | { type: string; session_id?: string; [k: string]: unknown };

export type QueryFn = (
  input: { prompt: string; options: Record<string, unknown> },
) => AsyncIterable<SdkMessage>;

export type ClaudeCodeDeps = {
  model: string;
  systemPrompt: string;
  oauthToken: string;
  apiKey: string;
  store: ContextStore;
  threads: ThreadStore;
  sessions: SessionStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
  runQuery?: QueryFn; // defaults to the real SDK query()
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function assistantText(msg: { message: { content: Array<{ type: string; text?: string }> } }): string {
  return (msg.message?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

type Accumulator = { finalText: string; sessionId?: string };

// Process one SDK message: update the accumulator and report an optional
// text delta to stream and/or a terminal error message.
function step(msg: SdkMessage, acc: Accumulator): { delta?: string; error?: string } {
  if (msg.type === "assistant") {
    const am = msg as Extract<SdkMessage, { type: "assistant" }>;
    acc.sessionId ??= am.session_id;
    const text = assistantText(am);
    if (text) {
      acc.finalText = text;
      return { delta: text };
    }
    return {};
  }
  if (msg.type === "result") {
    const r = msg as Extract<SdkMessage, { type: "result" }>;
    acc.sessionId ??= r.session_id;
    if (r.subtype === "success") {
      // Prefer the SDK's final result string; otherwise keep the last
      // assistant text block we accumulated.
      if (typeof r.result === "string") acc.finalText = r.result;
      return {};
    }
    return { error: `claude-code query failed (${r.subtype}): ${(r.errors ?? []).join("; ")}` };
  }
  return {};
}

export function makeClaudeCodeHandlers(deps: ClaudeCodeDeps) {
  const toolDeps: ToolDeps = {
    store: deps.store,
    threads: deps.threads,
    registry: deps.registry,
    bearerToken: deps.bearerToken,
    selfName: deps.selfName,
    spawnAgent: deps.spawnAgent,
    availableRoles: deps.availableRoles,
  };
  const allowedTools = a2aToolNames(toolDeps);
  const runQuery = deps.runQuery ?? (sdkQuery as unknown as QueryFn);

  async function prepare(ctx: AgentHandlerCtx) {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });
    const resume = await deps.sessions.get(contextId);
    const env = resolveClaudeCodeEnv(Deno.env.toObject(), deps.oauthToken, deps.apiKey);
    const server = buildA2aMcpServer(toolDeps, ctx.depth, contextId);
    const options: Record<string, unknown> = {
      systemPrompt: { type: "preset", preset: "claude_code", append: deps.systemPrompt },
      model: deps.model,
      maxTurns: 8,
      permissionMode: "bypassPermissions",
      env,
      mcpServers: { a2a: server },
      allowedTools,
    };
    if (resume) options.resume = resume;
    return { contextId, prompt, options };
  }

  // Persist the SDK session id and mirror the assistant turn to the audit store.
  // Only called on a successful run (a failed query records nothing).
  async function finishSession(contextId: string, acc: Accumulator): Promise<void> {
    if (acc.sessionId) await deps.sessions.set(contextId, acc.sessionId);
    await deps.store.append(contextId, { role: "assistant", content: acc.finalText });
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const { contextId, prompt, options } = await prepare(ctx);
    const acc: Accumulator = { finalText: "" };
    for await (const msg of runQuery({ prompt, options })) {
      const { error } = step(msg, acc);
      if (error) throw new Error(error);
    }
    await finishSession(contextId, acc);
    return { text: acc.finalText };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    const { contextId, prompt, options } = await prepare(ctx);
    const acc: Accumulator = { finalText: "" };
    for await (const msg of runQuery({ prompt, options })) {
      const { delta, error } = step(msg, acc);
      if (delta) yield { type: "delta", text: delta };
      if (error) {
        // Surface the error and stop; record nothing (mirrors handler's throw).
        yield { type: "error", message: error };
        return;
      }
    }
    await finishSession(contextId, acc);
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
