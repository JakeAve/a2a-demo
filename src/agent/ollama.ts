import type { AgentHandlerCtx } from "./base.ts";
import type { StreamEvent } from "../protocol/client.ts";
import type { ContextStore, StoredMessage } from "../store/context.ts";
import {
  buildSystemSuffix,
  runTool,
  toOllamaTools,
  type ToolDeps,
} from "./tools.ts";

export type OllamaDeps = {
  model: string;
  systemPrompt: string;
  baseUrl: string;
  store: ContextStore;
  // When provided, this Ollama agent is wired with the A2A tool runner (and,
  // if the ToolDeps has a `search` provider, the web_search tool too). Requires
  // a tool-capable model on the Ollama side.
  tools?: ToolDeps;
};

// The Ollama-format tool list, derived from the shared tool runner's getTools
// (which already includes web_search when ToolDeps.search is set). Exported for
// testing.
export function buildOllamaTools(deps: OllamaDeps) {
  return deps.tools ? toOllamaTools(deps.tools) : [];
}

type OllamaToolCall = {
  id?: string;
  function: { name: string; arguments: Record<string, unknown> };
};

type OllamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_call_id?: string;
};

function userText(ctx: AgentHandlerCtx): string {
  return ctx.message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function buildSystem(deps: OllamaDeps): string {
  if (!deps.tools) return deps.systemPrompt;
  return deps.systemPrompt + buildSystemSuffix(deps.tools);
}

function historyToOllama(
  history: StoredMessage[],
): OllamaChatMessage[] {
  return history.map((m) => ({
    role: m.role === "system" ? "system" : (m.role as "user" | "assistant"),
    content: m.content,
  }));
}

// Run one tool call through the shared A2A tool runner (which handles
// web_search too when a provider is configured).
async function dispatchTool(
  deps: OllamaDeps,
  tc: OllamaToolCall,
  ctx: AgentHandlerCtx,
  contextId: string,
): Promise<string> {
  if (!deps.tools) return JSON.stringify({ error: `unknown tool ${tc.function.name}` });
  return runTool(deps.tools, tc.function.name, tc.function.arguments ?? {}, ctx.depth, contextId, {
    sessionId: ctx.sessionId,
    requestId: ctx.requestId,
  });
}

export function makeOllamaHandlers(deps: OllamaDeps) {
  const tools = buildOllamaTools(deps);

  async function handler(ctx: AgentHandlerCtx): Promise<{ text: string }> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    let finalText = "";
    const messages: OllamaChatMessage[] = [
      { role: "system", content: buildSystem(deps) },
      ...historyToOllama(await deps.store.get(contextId)),
    ];

    for (let iter = 0; iter < 8; iter++) {
      const body: Record<string, unknown> = {
        model: deps.model,
        messages,
        stream: false,
      };
      if (tools.length) body.tools = tools;

      const res = await fetch(`${deps.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      const json = await res.json();
      const msg = json?.message ?? {};
      const content: string = msg.content ?? "";
      const toolCalls: OllamaToolCall[] = msg.tool_calls ?? [];

      if (content) finalText = content;

      if (tools.length === 0 || toolCalls.length === 0) break;

      // Append the assistant's tool-call message verbatim so the model sees
      // its own request when reasoning over results.
      messages.push({
        role: "assistant",
        content,
        tool_calls: toolCalls,
      });

      for (const tc of toolCalls) {
        const result = await dispatchTool(deps, tc, ctx, contextId);
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    return { text: finalText };
  }

  async function* streamHandler(
    ctx: AgentHandlerCtx,
  ): AsyncGenerator<StreamEvent> {
    const contextId = ctx.message.contextId ?? crypto.randomUUID();
    const prompt = userText(ctx);
    await deps.store.append(contextId, { role: "user", content: prompt });

    const messages: OllamaChatMessage[] = [
      { role: "system", content: buildSystem(deps) },
      ...historyToOllama(await deps.store.get(contextId)),
    ];

    let finalText = "";

    // One iteration = one model turn. If the turn ends with tool_calls,
    // execute them and loop. If not, we're done.
    for (let iter = 0; iter < 8; iter++) {
      const body: Record<string, unknown> = {
        model: deps.model,
        messages,
        stream: true,
      };
      if (tools.length) body.tools = tools;

      const res = await fetch(`${deps.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) {
        yield { type: "error", message: `ollama ${res.status}` };
        return;
      }

      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      let turnContent = "";
      let turnToolCalls: OllamaToolCall[] = [];

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            const msg = obj?.message ?? {};
            const delta: string = msg.content ?? "";
            if (delta) {
              turnContent += delta;
              yield { type: "delta", text: delta };
            }
            if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
              turnToolCalls = msg.tool_calls;
              for (const tc of msg.tool_calls) {
                yield {
                  type: "tool",
                  name: tc?.function?.name ?? "unknown",
                  args: tc?.function?.arguments,
                };
              }
            }
          } catch { /* skip */ }
        }
      }

      if (tools.length === 0 || turnToolCalls.length === 0) {
        finalText = turnContent;
        break;
      }

      // Tool-using turn: append the assistant's intent + run each tool,
      // then iterate. We don't carry turnContent into finalText because
      // it's typically empty during tool-decision turns.
      messages.push({
        role: "assistant",
        content: turnContent,
        tool_calls: turnToolCalls,
      });
      for (const tc of turnToolCalls) {
        const result = await dispatchTool(deps, tc, ctx, contextId);
        messages.push({
          role: "tool",
          content: result,
          tool_call_id: tc.id,
        });
      }
    }

    await deps.store.append(contextId, { role: "assistant", content: finalText });
    yield { type: "done" };
  }

  return { handler, streamHandler };
}
