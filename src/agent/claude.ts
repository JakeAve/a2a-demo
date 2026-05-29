import Anthropic from "@anthropic-ai/sdk";
import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { RegistryClient } from "../registry/client.ts";
import {
  buildSystemSuffix,
  runTool,
  toAnthropicTools,
  type SpawnResult,
  type ToolDeps,
} from "./tools.ts";
import type { Emitter } from "../observability/emit.ts";
import { now } from "../observability/emit.ts";

export type { SpawnResult };

export type ClaudeDeps = {
  model: string;
  systemPrompt: string;
  apiKey: string;
  store: ContextStore;
  threads: ThreadStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
  spawnAgent?: ToolDeps["spawnAgent"];
  availableRoles?: ToolDeps["availableRoles"];
  emit?: Emitter;
  // When true, expose Anthropic's server-side web_search tool to this agent.
  webSearch?: boolean;
  // When set, room tools are exposed and backed by this broker client.
  rooms?: ToolDeps["rooms"];
  // Mutable per-agent holder for tracking the active room turn.
  roomTurn?: ToolDeps["roomTurn"];
  // Test seam: inject a stub Anthropic client. Production leaves this unset and
  // a real client is constructed from apiKey.
  client?: Anthropic;
};

// Anthropic's server-side web search tool. Claude runs the search itself and
// returns the results inline (as server_tool_use / web_search_tool_result
// blocks we don't treat as client tool calls). Cast because the pinned SDK
// (0.30) predates the server-tool types; the API accepts it at runtime.
const WEB_SEARCH_TOOL = { type: "web_search_20250305", name: "web_search", max_uses: 5 };

// Build the Anthropic tools array: the A2A client tools, plus web_search when
// enabled. Exported for testing.
export function buildAnthropicTools(toolDeps: ToolDeps, webSearch?: boolean): Anthropic.Tool[] {
  const tools = toAnthropicTools(toolDeps) as unknown as Anthropic.Tool[];
  return webSearch ? [...tools, WEB_SEARCH_TOOL as unknown as Anthropic.Tool] : tools;
}

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function toAnthropic(
  history: StoredMessage[],
): Array<{ role: "user" | "assistant"; content: string }> {
  return history
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

export function makeClaudeHandlers(deps: ClaudeDeps) {
  const client = deps.client ?? new Anthropic({ apiKey: deps.apiKey });
  const toolDeps: ToolDeps = {
    store: deps.store,
    threads: deps.threads,
    registry: deps.registry,
    bearerToken: deps.bearerToken,
    selfName: deps.selfName,
    spawnAgent: deps.spawnAgent,
    availableRoles: deps.availableRoles,
    emit: deps.emit,
    rooms: deps.rooms,
    roomTurn: deps.roomTurn,
  };
  const tools = buildAnthropicTools(toolDeps, deps.webSearch);
  const systemSuffix = buildSystemSuffix(toolDeps);

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    // Agentic loop with tool use; bounded to avoid runaway.
    let finalText = "";
    const messages = toAnthropic(await deps.store.get(contextId));

    // Agentic turns can carry large tool-call arguments — e.g. a researcher
    // forwarding compiled web findings to a peer via delegate_start. A small
    // budget truncates mid-tool_use (stop_reason "max_tokens") and the call is
    // silently lost. Start generous and escalate on truncation (see below).
    let maxTokens = 4096;
    const MAX_TOKENS_CAP = 16384;

    for (let iter = 0; iter < 8; iter++) {
      const resp = await client.messages.create({
        model: deps.model,
        max_tokens: maxTokens,
        system: deps.systemPrompt + systemSuffix,
        tools,
        messages,
      });

      const textBlocks = resp.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text);
      const toolBlocks = resp.content.filter((b) => b.type === "tool_use") as Array<{
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }>;

      // Surface Anthropic's server-side web_search calls as tool.call events so
      // they render as round arrows in the monitor, just like client tools.
      if (deps.emit) {
        for (const b of resp.content) {
          if ((b as { type?: string }).type === "server_tool_use") {
            const sb = b as { name?: string; input?: Record<string, unknown> };
            void deps.emit({
              sessionId: ctx.sessionId, requestId: ctx.requestId, agent: deps.selfName,
              depth: ctx.depth, ts: now(), type: "tool.call",
              data: { tool: sb.name ?? "web_search", args: JSON.stringify(sb.input ?? {}).slice(0, 120) },
            });
          }
        }
      }

      // A server tool (web_search) ran and Claude needs another turn to finish.
      // Resend the assistant content unchanged — there are no client
      // tool_results to add; the search results are already in resp.content.
      // Cast: the pinned SDK (0.30) predates the "pause_turn" stop reason, but
      // the API returns it when a server tool needs another turn.
      if ((resp.stop_reason as string) === "pause_turn") {
        messages.push({ role: "assistant", content: resp.content as never });
        continue;
      }

      // Truncated mid-generation (commonly a long tool-call argument, e.g. a
      // researcher forwarding compiled findings via delegate_start). The
      // `messages` array is still valid — we haven't appended this partial
      // turn — so retry it verbatim with a larger budget instead of silently
      // dropping the (possibly incomplete) tool call. Escalates up to a cap.
      if (resp.stop_reason === "max_tokens" && maxTokens < MAX_TOKENS_CAP) {
        maxTokens = Math.min(maxTokens * 2, MAX_TOKENS_CAP);
        continue;
      }

      if (textBlocks.length) finalText = textBlocks.join("\n");

      if (resp.stop_reason !== "tool_use" || toolBlocks.length === 0) break;

      messages.push({ role: "assistant", content: resp.content as never });
      const toolResults = await Promise.all(
        toolBlocks.map(async (tb) => ({
          type: "tool_result" as const,
          tool_use_id: tb.id,
          content: await runTool(toolDeps, tb.name, tb.input, ctx.depth, contextId, {
            sessionId: ctx.sessionId, requestId: ctx.requestId,
          }),
        })),
      );
      messages.push({ role: "user", content: toolResults as never });
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(
    ctx: AgentHandlerCtx,
  ): AsyncGenerator<StreamEvent> {
    // V1: stream only the final answer. Tool turns happen behind the scenes.
    const result = await handler(ctx);
    const chunkSize = 40;
    for (let i = 0; i < result.text.length; i += chunkSize) {
      yield { type: "delta", text: result.text.slice(i, i + chunkSize) };
    }
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
