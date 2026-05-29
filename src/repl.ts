import { streamMessage } from "./protocol/client.ts";
import type { AgentCard } from "./protocol/types.ts";
import type { Emitter } from "./observability/emit.ts";
import { now } from "./observability/emit.ts";

export type ReplDeps = {
  agents: Map<string, AgentCard>; // name → card
  bearerToken: string;
  emit?: Emitter;
};

const PROMPT = "\n> ";

export async function runRepl(deps: ReplDeps): Promise<void> {
  const decoder = new TextDecoder();
  const contextId = crypto.randomUUID();
  const sessionId = contextId; // session == driver run
  const emit: Emitter = deps.emit ?? (() => Promise.resolve());
  Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));

  for await (const chunk of Deno.stdin.readable) {
    const line = decoder.decode(chunk).trim();
    if (!line) {
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }
    if (line === ":quit" || line === ":q") return;

    const match = line.match(/^@(\S+)\s+(.+)$/);
    if (!match) {
      console.log(`(use @<agent> <prompt>; known: ${[...deps.agents.keys()].join(", ")})`);
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }
    const [, name, prompt] = match;
    const card = deps.agents.get(name);
    if (!card) {
      console.log(`unknown agent: ${name}`);
      Deno.stdout.writeSync(new TextEncoder().encode(PROMPT));
      continue;
    }

    const requestId = crypto.randomUUID();
    void emit({
      sessionId, requestId, agent: "REPL", depth: 0, ts: now(),
      type: "request.started", data: { target: name, prompt },
    });
    const enc = new TextEncoder();
    Deno.stdout.writeSync(enc.encode(`[${name}] `));
    const startedTs = now();
    try {
      for await (const ev of streamMessage({
        url: card.url,
        token: deps.bearerToken,
        depth: 0,
        sessionId,
        requestId,
        message: {
          messageId: crypto.randomUUID(),
          role: "user",
          parts: [{ type: "text", text: prompt }],
          contextId,
        },
      })) {
        if (ev.type === "delta") Deno.stdout.writeSync(enc.encode(ev.text));
        else if (ev.type === "tool") {
          const argsStr = JSON.stringify(ev.args);
          const compact = argsStr.length > 80 ? argsStr.slice(0, 77) + "…" : argsStr;
          Deno.stdout.writeSync(enc.encode(`\n  · ${ev.name}${compact}\n  `));
        }
        else if (ev.type === "error") Deno.stdout.writeSync(enc.encode(`\n[error] ${ev.message}`));
        else if (ev.type === "done") break;
      }
    } catch (e) {
      Deno.stdout.writeSync(enc.encode(`\n[error] ${(e as Error).message}`));
    }
    void emit({
      sessionId, requestId, agent: "REPL", depth: 0, ts: now(),
      type: "request.completed", data: { durationMs: now() - startedTs },
    });
    Deno.stdout.writeSync(enc.encode(PROMPT));
  }
}
