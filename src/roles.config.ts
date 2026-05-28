import type { Skill } from "./protocol/types.ts";

export type Backend = "claude" | "ollama";

export type RolePreset = {
  backend: Backend;
  model: string;
  systemPrompt: string;
  description: string;
  skills: Skill[];
  // When true, this agent is wired with the A2A tool runner so it can
  // call list_agents, delegate_start, etc. Claude agents are always tool-
  // capable. For Ollama agents, only set this if the model actually
  // supports tool calling (e.g. gemma4:e4b, qwen2.5, llama3.1).
  toolCapable?: boolean;
};

export const roles: Record<string, RolePreset> = {
  sonnet: {
    backend: "claude",
    model: "claude-sonnet-4-6",
    description: "Coordinator backed by Claude Sonnet",
    systemPrompt:
      "You are a coordinator. When work would be cheaper or faster on a peer agent, call delegate_task. Otherwise answer directly. Stay concise.",
    skills: [
      { id: "coordinate", name: "Coordinate", description: "Plans and delegates complex tasks" },
    ],
    toolCapable: true,
  },
  gemma3: {
    backend: "ollama",
    model: "gemma3",
    description: "Fast local generalist (gemma3 via Ollama)",
    systemPrompt: "You are a fast helper. Answer concisely.",
    skills: [
      { id: "general", name: "General", description: "Cheap general-purpose assistant" },
    ],
  },
  gemma4: {
    backend: "ollama",
    model: "gemma4:e4b",
    description: "Tool-capable local model (gemma4:e4b via Ollama). Can delegate to peers.",
    systemPrompt: "You are a careful local model. Think before answering. You can call peer agents via the delegation tools when useful.",
    skills: [
      { id: "reasoning", name: "Reasoning", description: "Local reasoning over text" },
      { id: "delegation", name: "Delegation", description: "Can call other agents via A2A tools" },
    ],
    toolCapable: true,
  },
};
