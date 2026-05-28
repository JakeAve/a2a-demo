// Shared A2A tools usable by any backend that supports function calling.
// Defined once in a backend-neutral shape; adapters convert to each provider's
// tool schema. The runner is identical across backends.

import type { ContextStore } from "../store/context.ts";
import type { ThreadStore } from "../store/threads.ts";
import type { RegistryClient } from "../registry/client.ts";
import { sendMessage } from "../protocol/client.ts";

export type SpawnResult = {
  ok: boolean;
  name?: string;
  error?: string;
};

export type ToolDeps = {
  store: ContextStore;
  threads: ThreadStore;
  registry: RegistryClient;
  bearerToken: string;
  selfName: string;
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

export const DELEGATION_SUFFIX = `

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

export function getTools(deps: ToolDeps): BaseTool[] {
  return deps.spawnAgent ? [...BASE_TOOLS, ...SPAWN_TOOLS] : BASE_TOOLS;
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
  return deps.spawnAgent ? DELEGATION_SUFFIX + SPAWN_SUFFIX : DELEGATION_SUFFIX;
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
): Promise<string> {
  const res = await sendMessage({
    url: peerUrl,
    token: deps.bearerToken,
    depth: depth + 1,
    message: {
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ type: "text", text: prompt }],
      contextId: threadId,
    },
  });
  return res.text;
}

export async function runTool(
  deps: ToolDeps,
  name: string,
  args: Record<string, unknown>,
  depth: number,
  parentContextId: string,
): Promise<string> {
  try {
    if (name === "list_agents") {
      const cards = await deps.registry.list();
      const peers = cards.filter((c) => c.name !== deps.selfName);
      return JSON.stringify(
        peers.map((c) => ({
          name: c.name,
          description: c.description,
          skills: c.skills,
        })),
      );
    }

    if (name === "list_my_threads") {
      const threads = await deps.threads.list(parentContextId);
      return JSON.stringify(
        threads.map((t) => ({
          threadId: t.threadId,
          peer: t.peer,
          title: t.title,
          turnCount: t.turnCount,
          lastUsedAt: t.lastUsedAt,
        })),
      );
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
      const text = await delegate(deps, meta.threadId, card.url, prompt, depth);
      await deps.threads.touch(meta.threadId);
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
      const text = await delegate(deps, threadId, card.url, prompt, depth);
      await deps.threads.touch(threadId);
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
      return JSON.stringify(deps.availableRoles());
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
      return JSON.stringify(result);
    }

    return JSON.stringify({ error: `unknown tool ${name}` });
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}
