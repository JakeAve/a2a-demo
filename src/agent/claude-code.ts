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
      allowedTools: a2aToolNames(toolDeps),
    };
    if (resume) options.resume = resume;
    return { contextId, prompt, options };
  }

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const { contextId, prompt, options } = await prepare(ctx);
    let finalText = "";
    let sessionId: string | undefined;
    for await (const msg of runQuery({ prompt, options })) {
      if (msg.type === "assistant") {
        sessionId ??= msg.session_id;
        const text = assistantText(msg as never);
        if (text) finalText = text;
      } else if (msg.type === "result") {
        sessionId ??= msg.session_id;
        const r = msg as { subtype: string; result?: string; errors?: string[] };
        if (r.subtype === "success") {
          if (typeof r.result === "string") finalText = r.result;
        } else {
          throw new Error(`claude-code query failed (${r.subtype}): ${(r.errors ?? []).join("; ")}`);
        }
      }
    }
    if (sessionId) await deps.sessions.set(contextId, sessionId);
    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(ctx: AgentHandlerCtx): AsyncGenerator<StreamEvent> {
    const { contextId, prompt, options } = await prepare(ctx);
    let finalText = "";
    let sessionId: string | undefined;
    for await (const msg of runQuery({ prompt, options })) {
      if (msg.type === "assistant") {
        sessionId ??= msg.session_id;
        const text = assistantText(msg as never);
        if (text) { finalText = text; yield { type: "delta", text }; }
      } else if (msg.type === "result") {
        sessionId ??= msg.session_id;
        const r = msg as { subtype: string; result?: string; errors?: string[] };
        if (r.subtype === "success") {
          if (typeof r.result === "string") finalText = r.result;
        } else {
          yield { type: "error", message: `claude-code query failed (${r.subtype}): ${(r.errors ?? []).join("; ")}` };
        }
      }
    }
    if (sessionId) await deps.sessions.set(contextId, sessionId);
    await deps.store.append(contextId, { role: "assistant", content: finalText });
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
