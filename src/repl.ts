import { streamMessage } from "./protocol/client.ts";
import type { AgentCard } from "./protocol/types.ts";
import type { Emitter } from "./observability/emit.ts";
import { now } from "./observability/emit.ts";
import type { InboxDelivery } from "./rooms/types.ts";
import { Hono } from "hono";
import { InboxQueue } from "./agent/inbox.ts";

// ---- Pure line classification (no I/O, unit-tested) ----

export type Classified =
  | { kind: "empty" }
  | { kind: "quit" }
  | { kind: "rooms" }
  | { kind: "roomNew"; title: string; members: string[] }
  | { kind: "roomJoin"; roomId: string }
  | { kind: "roomLeave" }
  | { kind: "roomLog" }
  | { kind: "direct"; agent: string; prompt: string }
  | { kind: "roomPost"; to: string[]; text: string }
  | { kind: "hint"; message: string };

export type ClassifyOpts = {
  focusedRoomId: string | null;
  focusedMembers: ReadonlySet<string>;
  knownAgents: ReadonlySet<string>;
  lastAddressedBy: string | null;
};

// "@A @B hello" -> { to: ["A","B"], rest: "hello" }
export function parseLeadingMentions(line: string): { to: string[]; rest: string } {
  const to: string[] = [];
  let rest = line.trim();
  let m: RegExpMatchArray | null;
  while ((m = rest.match(/^@(\S+)\s+(.*)$/))) {
    to.push(m[1]);
    rest = m[2].trim();
  }
  return { to, rest };
}

export function classifyLine(raw: string, opts: ClassifyOpts): Classified {
  const line = raw.trim();
  if (!line) return { kind: "empty" };
  if (line === ":quit" || line === ":q") return { kind: "quit" };
  if (line === ":rooms") return { kind: "rooms" };

  if (line.startsWith(":room")) {
    const rest = line.slice(":room".length).trim();
    if (rest === "leave") return { kind: "roomLeave" };
    if (rest === "log") return { kind: "roomLog" };
    if (rest.startsWith("new")) {
      const tokens = rest.slice("new".length).trim().split(/\s+/).filter(Boolean);
      if (tokens.length < 2) return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      const members = tokens.pop()!.split(",").map((s) => s.trim()).filter(Boolean);
      const title = tokens.join(" ");
      if (!title || members.length === 0) {
        return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      }
      return { kind: "roomNew", title, members };
    }
    if (rest.startsWith("join")) {
      const roomId = rest.slice("join".length).trim();
      if (!roomId) return { kind: "hint", message: "usage: :room join <roomId>" };
      return { kind: "roomJoin", roomId };
    }
    return { kind: "hint", message: "commands: :rooms, :room new|join|leave|log" };
  }

  const at = line.match(/^@(\S+)\s+(.+)$/);
  if (at) {
    const [, first, restText] = at;
    // Addressing an active member of the focused room => room post.
    if (opts.focusedRoomId && opts.focusedMembers.has(first)) {
      const parsed = parseLeadingMentions(line);
      return { kind: "roomPost", to: parsed.to, text: parsed.rest };
    }
    // A known agent that is NOT a focused member => direct-send escape (focused or not).
    if (opts.knownAgents.has(first)) return { kind: "direct", agent: first, prompt: restText };
    // Focused but unknown @name => treat as a room recipient (broker drops unknowns).
    if (opts.focusedRoomId) {
      const parsed = parseLeadingMentions(line);
      return { kind: "roomPost", to: parsed.to, text: parsed.rest };
    }
    return { kind: "hint", message: `unknown agent: ${first}` };
  }

  // Plain line.
  if (opts.focusedRoomId) {
    const to = opts.lastAddressedBy ? [opts.lastAddressedBy] : ["*"];
    return { kind: "roomPost", to, text: line };
  }
  return {
    kind: "hint",
    message: `(use @<agent> <prompt>; known: ${[...opts.knownAgents].join(", ")})`,
  };
}

// The line printed when a delivery arrives for the human.
export function formatDelivery(d: InboxDelivery): string {
  const text = d.transcript.at(-1)?.text ?? "";
  return `[room: ${d.title}] ${d.addressedBy} → you: ${text}`;
}

// ---- REPL inbox server ----

export type ReplInboxHandle = {
  url: string;
  port: number;
  shutdown: () => Promise<void>;
  drain: () => Promise<void>;
};

// A tiny /inbox server. Mirrors the agent inbox contract: bearer-authed,
// returns 202 immediately, deliveries drained one-at-a-time so prints stay
// ordered and the broker is never blocked.
export function startReplInbox(opts: {
  token: string;
  port?: number;
  onDelivery: (d: InboxDelivery) => void;
}): ReplInboxHandle {
  const app = new Hono();
  const queue = new InboxQueue<InboxDelivery>((d) => {
    opts.onDelivery(d);
    return Promise.resolve();
  });
  app.post("/inbox", async (c) => {
    // Empty token disables auth (matches the broker's convention in rooms/server.ts).
    const authz = c.req.header("authorization") ?? "";
    if (opts.token && authz !== `Bearer ${opts.token}`) return c.json({ error: "unauthorized" }, 401);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "bad json" }, 400); }
    queue.enqueue(body as InboxDelivery);
    return c.json({ ok: true }, 202);
  });
  const server = Deno.serve({ port: opts.port ?? 0, onListen: () => {} }, app.fetch);
  const port = (server.addr as Deno.NetAddr).port;
  return {
    url: `http://localhost:${port}`,
    port,
    shutdown: () => server.shutdown(),
    drain: () => queue.drain(),
  };
}

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
