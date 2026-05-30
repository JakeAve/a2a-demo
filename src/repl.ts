import { streamMessage } from "./protocol/client.ts";
import type { AgentCard } from "./protocol/types.ts";
import type { Emitter } from "./observability/emit.ts";
import { now } from "./observability/emit.ts";
import type { InboxDelivery } from "./rooms/types.ts";
import { Hono } from "hono";
import { InboxQueue } from "./agent/inbox.ts";
import { RoomBrokerClient } from "./rooms/client.ts";

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
export function parseLeadingMentions(
  line: string,
): { to: string[]; rest: string } {
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
      const tokens = rest.slice("new".length).trim().split(/\s+/).filter(
        Boolean,
      );
      if (tokens.length < 2) {
        return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      }
      const members = tokens.pop()!.split(",").map((s) => s.trim()).filter(
        Boolean,
      );
      const title = tokens.join(" ");
      if (!title || members.length === 0) {
        return { kind: "hint", message: "usage: :room new <title> <a,b,...>" };
      }
      return { kind: "roomNew", title, members };
    }
    if (rest.startsWith("join")) {
      const roomId = rest.slice("join".length).trim();
      if (!roomId) {
        return { kind: "hint", message: "usage: :room join <roomId>" };
      }
      return { kind: "roomJoin", roomId };
    }
    return {
      kind: "hint",
      message: "commands: :rooms, :room new|join|leave|log",
    };
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
    if (opts.knownAgents.has(first)) {
      return { kind: "direct", agent: first, prompt: restText };
    }
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
    message: `(use @<agent> <prompt>; known: ${
      [...opts.knownAgents].join(", ")
    })`,
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
    if (opts.token && authz !== `Bearer ${opts.token}`) {
      return c.json({ error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "bad json" }, 400);
    }
    queue.enqueue(body as InboxDelivery);
    return c.json({ ok: true }, 202);
  });
  const server = Deno.serve(
    { port: opts.port ?? 0, onListen: () => {} },
    app.fetch,
  );
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
  // Rooms: when a broker URL (or client) is provided, room commands are enabled.
  roomBrokerUrl?: string;
  roomsClient?: RoomBrokerClient; // test seam; defaults to one built from roomBrokerUrl
  humanName?: string; // the human's member name; default "human"
  // I/O seams (default: real stdin lines / stdout). Tests inject scripted I/O.
  input?: AsyncIterable<string>;
  output?: (s: string) => void;
  inboxPort?: number; // default 0 (dynamic)
};

const PROMPT = "\n> ";

// Default input: decode stdin chunks into lines (one chunk == one line, as before).
async function* stdinLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of Deno.stdin.readable) yield decoder.decode(chunk);
}

export async function runRepl(deps: ReplDeps): Promise<void> {
  const enc = new TextEncoder();
  const write = deps.output ?? ((s: string) => {
    Deno.stdout.writeSync(enc.encode(s));
  });
  const input = deps.input ?? stdinLines();
  const contextId = crypto.randomUUID();
  const sessionId = contextId; // session == driver run
  const emit: Emitter = deps.emit ?? (() => Promise.resolve());
  const humanName = deps.humanName ?? "human";
  const rooms = deps.roomsClient ??
    (deps.roomBrokerUrl
      ? new RoomBrokerClient(deps.roomBrokerUrl, deps.bearerToken)
      : undefined);
  const knownAgents = new Set(deps.agents.keys());

  // ---- Room state ----
  let focusedRoomId: string | null = null;
  let focusedTitle = "";
  let focusedMembers = new Set<string>();
  // Most recent unanswered delivery per room: turnId to thread + who addressed us.
  const pending = new Map<string, { turnId: string; addressedBy: string }>();

  let inbox: ReplInboxHandle | null = null;
  const ensureInbox = (): ReplInboxHandle => {
    if (!inbox) {
      inbox = startReplInbox({
        token: deps.bearerToken,
        port: deps.inboxPort,
        onDelivery: (d) => {
          pending.set(d.roomId, {
            turnId: d.turnId,
            addressedBy: d.addressedBy,
          });
          if (d.roomId === focusedRoomId) {
            focusedMembers = new Set(d.members);
            focusedTitle = d.title;
          }
          write(`\n${formatDelivery(d)}\n> `); // print then redraw the prompt
        },
      });
    }
    return inbox;
  };

  const refreshFocused = async (roomId: string) => {
    const got = await rooms?.get(roomId);
    if (got) {
      focusedTitle = got.room.title;
      focusedMembers = new Set(
        got.room.members.filter((m) => m.active).map((m) => m.name),
      );
    }
  };

  // ---- Direct send to an agent (existing behavior, unchanged) ----
  const directSend = async (name: string, prompt: string) => {
    const card = deps.agents.get(name);
    if (!card) {
      write(`unknown agent: ${name}\n`);
      return;
    }
    const requestId = crypto.randomUUID();
    void emit({
      sessionId,
      requestId,
      agent: "REPL",
      depth: 0,
      ts: now(),
      type: "request.started",
      data: { target: name, prompt },
    });
    write(`[${name}] `);
    const startedTs = now();
    try {
      for await (
        const ev of streamMessage({
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
        })
      ) {
        if (ev.type === "delta") write(ev.text);
        else if (ev.type === "tool") {
          const argsStr = JSON.stringify(ev.args);
          const compact = argsStr.length > 80
            ? argsStr.slice(0, 77) + "…"
            : argsStr;
          write(`\n  · ${ev.name}${compact}\n  `);
        } else if (ev.type === "error") write(`\n[error] ${ev.message}`);
        else if (ev.type === "done") break;
      }
    } catch (e) {
      write(`\n[error] ${(e as Error).message}`);
    }
    void emit({
      sessionId,
      requestId,
      agent: "REPL",
      depth: 0,
      ts: now(),
      type: "request.completed",
      data: { durationMs: now() - startedTs },
    });
  };

  write(PROMPT);

  for await (const chunk of input) {
    const cls = classifyLine(chunk, {
      focusedRoomId,
      focusedMembers,
      knownAgents,
      lastAddressedBy: focusedRoomId
        ? (pending.get(focusedRoomId)?.addressedBy ?? null)
        : null,
    });

    if (cls.kind === "empty") {
      write(PROMPT);
      continue;
    }
    if (cls.kind === "quit") break;
    if (cls.kind === "hint") {
      write(cls.message + "\n");
      write(PROMPT);
      continue;
    }

    if (cls.kind === "direct") {
      await directSend(cls.agent, cls.prompt);
      write(PROMPT);
      continue;
    }

    // ---- Room commands (all require a broker) ----
    if (!rooms) {
      write("rooms are disabled (no broker)\n");
      write(PROMPT);
      continue;
    }

    if (cls.kind === "rooms") {
      const list = await rooms.listByMember(humanName);
      if (!list.length) write("(no rooms)\n");
      for (const r of list) {
        write(
          `  ${r.roomId}  "${r.title}"  [${r.status}]${
            r.roomId === focusedRoomId ? " *focused" : ""
          }\n`,
        );
      }
      write(PROMPT);
      continue;
    }

    if (cls.kind === "roomNew") {
      const ib = ensureInbox();
      try {
        const res = await rooms.createRoom({
          title: cls.title,
          members: cls.members,
          createdBy: humanName,
          sessionId,
          humanMembers: [{ name: humanName, inboxUrl: ib.url }],
        });
        focusedRoomId = res.roomId;
        await refreshFocused(res.roomId);
        write(`joined room ${res.roomId} "${cls.title}"`);
        if (res.unresolved.length) {
          write(`  (unresolved: ${res.unresolved.join(", ")})`);
        }
        write("\n");
      } catch (e) {
        write(`[error] ${(e as Error).message}\n`);
      }
      write(PROMPT);
      continue;
    }

    if (cls.kind === "roomJoin") {
      const ib = ensureInbox();
      try {
        await rooms.join(cls.roomId, { name: humanName, inboxUrl: ib.url });
        focusedRoomId = cls.roomId;
        await refreshFocused(cls.roomId);
        write(`joined room ${cls.roomId} "${focusedTitle}"\n`);
      } catch (e) {
        write(`[error] ${(e as Error).message}\n`);
      }
      write(PROMPT);
      continue;
    }

    if (cls.kind === "roomLeave") {
      if (!focusedRoomId) {
        write("not in a room\n");
        write(PROMPT);
        continue;
      }
      try {
        await rooms.leave(focusedRoomId, humanName);
      } catch { /* ignore */ }
      write(`left room ${focusedRoomId}\n`);
      pending.delete(focusedRoomId);
      focusedRoomId = null;
      focusedMembers = new Set();
      focusedTitle = "";
      write(PROMPT);
      continue;
    }

    if (cls.kind === "roomLog") {
      if (!focusedRoomId) {
        write("not in a room\n");
        write(PROMPT);
        continue;
      }
      const got = await rooms.get(focusedRoomId);
      if (!got || !got.transcript.length) write("(no history)\n");
      else {for (const m of got.transcript) {
          write(
            `  [${m.from}${
              m.to.length ? " → " + m.to.join(", ") : ""
            }] ${m.text}\n`,
          );
        }}
      write(PROMPT);
      continue;
    }

    if (cls.kind === "roomPost") {
      if (!focusedRoomId) {
        write("not in a room\n");
        write(PROMPT);
        continue;
      }
      if (!cls.text) {
        write("(nothing to post)\n");
        write(PROMPT);
        continue;
      }
      const p = pending.get(focusedRoomId);
      try {
        await rooms.post(focusedRoomId, {
          from: humanName,
          text: cls.text,
          to: cls.to,
          turnId: p?.turnId,
        });
        // Only clear if no newer delivery arrived during the await.
        if (pending.get(focusedRoomId)?.turnId === p?.turnId) {
          pending.delete(focusedRoomId);
        }
      } catch (e) {
        write(`[error] ${(e as Error).message}\n`);
      }
      write(PROMPT);
      continue;
    }
  }

  // ---- Cleanup: leave the focused room and stop the inbox server ----
  if (focusedRoomId && rooms) {
    try {
      await rooms.leave(focusedRoomId, humanName);
    } catch { /* ignore */ }
  }
  if (inbox !== null) {
    const ib = inbox as ReplInboxHandle;
    await ib.drain();
    await ib.shutdown();
  }
}
