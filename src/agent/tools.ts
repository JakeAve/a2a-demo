// Shared A2A tools usable by any backend that supports function calling.
// Defined once in a backend-neutral shape; adapters convert to each provider's
// tool schema. The runner is identical across backends.

import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { RegistryClient } from "../registry/client.ts";
import { sendMessage } from "../protocol/client.ts";
import type { Emitter } from "../observability/emit.ts";
import { now } from "../observability/emit.ts";
import type { WebSearchProvider } from "./web-search.ts";

export type SpawnResult = {
  ok: boolean;
  name?: string;
  error?: string;
};

export type EmitIds = { sessionId: string; requestId: string };

export type ToolDeps = {
  store: ContextStore;
  threads: ThreadStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
  // Optional event emitter; defaults to no-op inside runTool.
  emit?: Emitter;
  // When set, a web_search tool is exposed and backed by this provider.
  search?: WebSearchProvider;
  // When omitted, list_roles and spawn_agent are not exposed.
  spawnAgent?: (
    role: string,
    name?: string,
    model?: string,
  ) => Promise<SpawnResult>;
  availableRoles?: () => Array<{
    name: string;
    description: string;
    backend: string;
    defaultModel: string;
  }>;
  // When set, room tools (create_room/post/invite/leave/list_rooms/room_history)
  // are exposed and backed by this broker client.
  rooms?: import("../rooms/client.ts").RoomBrokerClient;
  // Mutable per-agent holder; the inbox consumer sets `active` before a room-turn
  // so the `post` tool can attach the right turnId. Safe due to serialised inbox.
  roomTurn?: import("../rooms/types.ts").RoomTurnState;
};

type ObjectSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
};

export type BaseTool = {
  name: string;
  description: string;
  parameters: ObjectSchema;
};

const BASE_TOOLS: BaseTool[] = [
  {
    name: "list_agents",
    description:
      "List peer agents available for delegation. Returns name, description, and skills for each.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_my_threads",
    description:
      "List your currently active delegation threads. Each entry shows threadId, peer, title, turnCount, and lastUsedAt. Call this before deciding whether to start a new thread or continue an existing one.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "delegate_start",
    description:
      "Start a NEW sub-conversation with a peer agent. Returns { threadId, text }. The peer sees a clean slate. Use for fresh, unrelated tasks.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Target agent name" },
        prompt: { type: "string", description: "What to ask the peer agent" },
        title: {
          type: "string",
          description:
            "Optional short label for this thread (used by list_my_threads).",
        },
      },
      required: ["agent", "prompt"],
    },
  },
  {
    name: "delegate_continue",
    description:
      "Continue an existing sub-conversation with a peer. The peer sees prior turns and can refine or answer follow-ups.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "threadId to continue" },
        prompt: { type: "string", description: "Next message in the thread" },
      },
      required: ["threadId", "prompt"],
    },
  },
  {
    name: "reset_thread",
    description: "Delete a delegation thread when finished.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "threadId to delete" },
      },
      required: ["threadId"],
    },
  },
];

const SPAWN_TOOLS: BaseTool[] = [
  {
    name: "list_roles",
    description:
      "List role presets available to spawn_agent. Returns { name, description, backend, defaultModel } for each role.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "spawn_agent",
    description:
      "Launch a new peer agent of the given role as its own subprocess. Returns { ok, name } when registered. Then call list_agents and delegate_start to use it.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role name from list_roles" },
        name: {
          type: "string",
          description:
            "Optional unique name (defaults to role). Required if you want multiple agents of the same role.",
        },
        model: {
          type: "string",
          description:
            "Optional model override (e.g. 'gemma3:1b'). Defaults to the role's defaultModel.",
        },
      },
      required: ["role"],
    },
  },
];

const ROOM_TOOLS: BaseTool[] = [
  {
    name: "create_room",
    description:
      "Create a multi-party conversation room and add members by name. Returns { roomId }. Use a room for an open-ended exchange (debate, brainstorm, collaboration) — not for a task you need a single result back from (use delegate_* for that).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short room title" },
        members: { type: "array", items: { type: "string" }, description: "Agent names to add (besides you)" },
        maxTurns: { type: "number", description: "Optional hard cap on total posts (default 24)" },
      },
      required: ["title", "members"],
    },
  },
  {
    name: "post",
    description:
      "Post a message to a room, addressing specific members. `to` lists the member names that should respond; use [] to address no one (lets the conversation wind down) or [\"*\"] for everyone. Only addressed members are woken to reply.",
    parameters: {
      type: "object",
      properties: {
        roomId: { type: "string" },
        text: { type: "string", description: "What to say" },
        to: { type: "array", items: { type: "string" }, description: "Member names to address" },
      },
      required: ["roomId", "text", "to"],
    },
  },
  {
    name: "invite",
    description: "Invite another agent into an existing room by name.",
    parameters: {
      type: "object",
      properties: { roomId: { type: "string" }, agent: { type: "string" } },
      required: ["roomId", "agent"],
    },
  },
  {
    name: "leave",
    description: "Leave a room when you're done participating.",
    parameters: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] },
  },
  {
    name: "list_rooms",
    description: "List rooms you are a member of. Returns roomId, title, and members for each.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "room_history",
    description: "Fetch the full transcript of a room you belong to.",
    parameters: { type: "object", properties: { roomId: { type: "string" } }, required: ["roomId"] },
  },
];

// Offered only when a WebSearchProvider is configured on ToolDeps.search.
const WEB_SEARCH_TOOL: BaseTool = {
  name: "web_search",
  description:
    "Search the web for current, factual information. Returns results with title, url, and a content snippet. Use this instead of guessing whenever a question needs current or verifiable facts.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The search query" } },
    required: ["query"],
  },
};

export const DELEGATION_SUFFIX = `

Delegation has real cost (latency, tokens, and peers may delegate further), so
match it to the task. When you can answer something well yourself, just answer.
Delegate when it clearly pays off: the work splits into genuinely independent
parts worth running in parallel, a peer has a capability or cheaper/faster model
better suited to it, or the task is too large to do well in one turn. Keep it to
a few purposeful delegations, not a reflexive swarm, and don't hand work to a
peer that would only delegate it again.

If you are explicitly asked to delegate, to route work to a named peer, or to
hand a result onward (e.g. "have the researcher do X", "forward this to the
summarizer"), then do it — actually call the delegation tool. An explicit
routing request overrides the restraint above; saying you'll delegate without
calling the tool is a failure, not an answer.

Delegation tools available to you:
- list_agents: discover which peer agents exist.
- list_my_threads: see your own active sub-conversations with peers.
- delegate_start(agent, prompt, title?): begin a fresh sub-conversation; returns { threadId, text }.
- delegate_continue(threadId, prompt): continue a prior sub-conversation; the peer sees its earlier turns.
- reset_thread(threadId): drop a finished sub-conversation.

Prefer delegate_continue when the user is iterating on something a peer already produced. Use delegate_start for unrelated tasks. Always call list_my_threads if you're unsure whether an existing thread already covers the request.`;

export const SPAWN_SUFFIX = `

Agent lifecycle tools available to you:
- list_roles: see which role presets you can spawn.
- spawn_agent(role, name?, model?): boot a new peer agent as its own process. The new agent registers itself; afterwards list_agents will include it and delegate_start can target it.`;

export const ROOMS_SUFFIX = `

You can also hold open-ended, multi-party conversations in "rooms" — distinct from
delegation. Use the rule: need a value back from a task → delegate_*; want an
open-ended exchange (debate, brainstorm, collaborate, or just talk with peers) → a room.

Room tools:
- create_room(title, members[], maxTurns?): start a room and add members; returns { roomId }.
- post(roomId, text, to[]): say something, addressing the member names in \`to\`. Only addressed members reply. Use to:[] to let it wind down, to:["*"] for everyone.
- invite(roomId, agent): add another agent.
- leave(roomId): exit when done.
- list_rooms() / room_history(roomId): see your rooms / a transcript.

When you are addressed in a room, just reply naturally — your reply is sent to whoever addressed you. Call post() explicitly only when you want to address someone specific, address everyone, or end the exchange.`;

export function getTools(deps: ToolDeps): BaseTool[] {
  const tools = deps.spawnAgent ? [...BASE_TOOLS, ...SPAWN_TOOLS] : [...BASE_TOOLS];
  if (deps.rooms) tools.push(...ROOM_TOOLS);
  if (deps.search) tools.push(WEB_SEARCH_TOOL);
  return tools;
}

export function toAnthropicTools(deps: ToolDeps) {
  return getTools(deps).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

export function toOllamaTools(deps: ToolDeps) {
  return getTools(deps).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export function buildSystemSuffix(deps: ToolDeps): string {
  let s = deps.spawnAgent ? DELEGATION_SUFFIX + SPAWN_SUFFIX : DELEGATION_SUFFIX;
  if (deps.rooms) s += ROOMS_SUFFIX;
  return s;
}

function truncate(s: string, max = 80): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function delegate(
  deps: ToolDeps,
  threadId: string,
  peerUrl: string,
  prompt: string,
  depth: number,
  ids: EmitIds,
): Promise<string> {
  const res = await sendMessage({
    url: peerUrl,
    token: deps.bearerToken,
    depth: depth + 1,
    sessionId: ids.sessionId,
    requestId: ids.requestId,
    message: {
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ type: "text", text: prompt }],
      contextId: threadId,
    },
  });
  return res.text;
}

// Run a tool and emit a tool.call carrying BOTH its args and its result, so the
// monitor's inspector can show what came back without any per-tool wiring. The
// emit lands after the tool returns (errors are caught and returned as an
// { error } JSON, so failures surface too). delegate/spawn tools are excluded:
// they emit their own richer events (cross-lane arrows / spawn) inside dispatch.
export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
  ids: EmitIds = { sessionId: "", requestId: "" },
): Promise<string> {
  const result = await dispatchTool(deps, name, args, depth, parentContextId, ids);
  const skipEmit = ["delegate_start", "delegate_continue", "spawn_agent", "create_room", "post", "invite", "leave"];
  if (!skipEmit.includes(name)) {
    const emit = deps.emit ?? (() => Promise.resolve());
    void emit({
      sessionId: ids.sessionId, requestId: ids.requestId, agent: deps.selfName,
      depth, ts: now(), type: "tool.call",
      data: { tool: name, args: truncate(JSON.stringify(args), 120), result: truncate(result, 4000) },
    });
  }
  return result;
}

async function dispatchTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
  ids: EmitIds = { sessionId: "", requestId: "" },
): Promise<string> {
  const emit = deps.emit ?? (() => Promise.resolve());
  const ev = (type: Parameters<Emitter>[0]["type"], data: Record<string, unknown>, threadId?: string) =>
    void emit({
      sessionId: ids.sessionId, requestId: ids.requestId, agent: deps.selfName,
      depth, ts: now(), type, data, threadId,
    });

  try {
    if (name === "list_agents") {
      const cards = await deps.registry.list();
      const peers = cards.filter((c) => c.name !== deps.selfName);
      const result = JSON.stringify(
        peers.map((c) => ({
          name: c.name,
          description: c.description,
          skills: c.skills,
        })),
      );
      return result;
    }

    if (name === "list_my_threads") {
      const threads = await deps.threads.list(parentContextId);
      const result = JSON.stringify(
        threads.map((t) => ({
          threadId: t.threadId,
          peer: t.peer,
          title: t.title,
          turnCount: t.turnCount,
          lastUsedAt: t.lastUsedAt,
        })),
      );
      return result;
    }

    if (name === "delegate_start") {
      const target = String(args.agent);
      const prompt = String(args.prompt);
      const title = typeof args.title === "string" && args.title.trim()
        ? args.title
        : truncate(prompt);
      const card = await deps.registry.get(target);
      if (!card) return JSON.stringify({ error: `unknown agent ${target}` });
      const meta = await deps.threads.start(parentContextId, target, title);
      ev("delegate.start", { peer: target, title, prompt: truncate(prompt, 4000) }, meta.threadId);
      const startedTs = now();
      // If delegate() throws, the outer catch returns an error JSON and
      // delegate.return is not emitted — the monitor must treat a dangling
      // delegate.start as an implicitly-failed leg (v1 limitation).
      const text = await delegate(deps, meta.threadId, card.url, prompt, depth, ids);
      await deps.threads.touch(meta.threadId);
      ev("delegate.return", { peer: target, ok: true, durationMs: now() - startedTs, preview: truncate(text, 4000) }, meta.threadId);
      return JSON.stringify({ threadId: meta.threadId, text });
    }

    if (name === "delegate_continue") {
      const threadId = String(args.threadId);
      const prompt = String(args.prompt);
      const meta = await deps.threads.get(threadId);
      if (!meta) return JSON.stringify({ error: `unknown thread ${threadId}` });
      if (meta.parentContextId !== parentContextId) {
        return JSON.stringify({
          error: `thread ${threadId} is not owned by this conversation`,
        });
      }
      const card = await deps.registry.get(meta.peer);
      if (!card) return JSON.stringify({ error: `peer ${meta.peer} is gone` });
      ev("delegate.continue", { peer: meta.peer, turn: meta.turnCount + 1, prompt: truncate(prompt, 4000) }, threadId);
      const startedTs = now();
      // See delegate_start: a throw here leaves a dangling delegate.start (v1).
      const text = await delegate(deps, threadId, card.url, prompt, depth, ids);
      await deps.threads.touch(threadId);
      ev("delegate.return", { peer: meta.peer, ok: true, durationMs: now() - startedTs, preview: truncate(text, 4000) }, threadId);
      return JSON.stringify({ threadId, text });
    }

    if (name === "reset_thread") {
      const threadId = String(args.threadId);
      const meta = await deps.threads.get(threadId);
      if (!meta || meta.parentContextId !== parentContextId) {
        return JSON.stringify({ error: `unknown thread ${threadId}` });
      }
      const ok = await deps.threads.reset(threadId);
      return JSON.stringify({ ok });
    }

    if (name === "list_roles") {
      if (!deps.availableRoles) {
        return JSON.stringify({ error: "spawn capability not available" });
      }
      const result = JSON.stringify(deps.availableRoles());
      return result;
    }

    if (name === "spawn_agent") {
      if (!deps.spawnAgent) {
        return JSON.stringify({ error: "spawn capability not available" });
      }
      const role = String(args.role);
      const customName = typeof args.name === "string" && args.name.trim()
        ? args.name
        : undefined;
      const model = typeof args.model === "string" && args.model.trim()
        ? args.model
        : undefined;
      const result = await deps.spawnAgent(role, customName, model);
      ev("spawn", { role, name: result.name ?? customName ?? role, model: model ?? null, ok: result.ok });
      return JSON.stringify(result);
    }

    if (name === "web_search") {
      if (!deps.search) return JSON.stringify({ error: "web search not configured" });
      const query = String(args.query ?? "");
      const results = (await deps.search(query, 5)).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content.length > 800 ? r.content.slice(0, 800) + "…" : r.content,
      }));
      return JSON.stringify({ results });
    }

    if (name === "create_room") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const res = await deps.rooms.createRoom({
        title: String(args.title ?? "room"),
        members: Array.isArray(args.members) ? (args.members as string[]) : [],
        createdBy: deps.selfName,
        sessionId: ids.sessionId,
        maxTurns: typeof args.maxTurns === "number" ? args.maxTurns : undefined,
      });
      return JSON.stringify(res);
    }

    if (name === "post") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const roomId = String(args.roomId);
      const to = Array.isArray(args.to) ? (args.to as string[]) : [];
      const active = deps.roomTurn?.active;
      // First matching post of this turn carries the turnId (resolving the delivery);
      // any later post is treated as originating (no turnId).
      let turnId: string | undefined;
      if (active && active.roomId === roomId) {
        if (!active.posted) turnId = active.turnId;
        active.posted = true;
      }
      const res = await deps.rooms.post(roomId, {
        from: deps.selfName, text: String(args.text ?? ""), to, turnId,
      });
      return JSON.stringify(res);
    }

    if (name === "invite") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      await deps.rooms.invite(String(args.roomId), String(args.agent));
      return JSON.stringify({ ok: true });
    }

    if (name === "leave") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      await deps.rooms.leave(String(args.roomId), deps.selfName);
      return JSON.stringify({ ok: true });
    }

    if (name === "list_rooms") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const rooms = await deps.rooms.listByMember(deps.selfName);
      return JSON.stringify(rooms.map((r) => ({
        roomId: r.roomId, title: r.title, members: r.members.filter((m) => m.active).map((m) => m.name),
      })));
    }

    if (name === "room_history") {
      if (!deps.rooms) return JSON.stringify({ error: "rooms not available" });
      const res = await deps.rooms.get(String(args.roomId));
      if (!res) return JSON.stringify({ error: "unknown room" });
      return JSON.stringify(res.transcript.map((m) => ({ from: m.from, to: m.to, text: m.text })));
    }

    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}
