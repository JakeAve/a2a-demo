import type { Skill } from "./protocol/types.ts";

export type Backend = "claude" | "ollama";

export type RolePreset = {
  backend: Backend;
  model: string;
  systemPrompt: string;
  description: string;
  skills: Skill[];
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
    model: "gemma4",
    description: "Stronger local model for harder local work",
    systemPrompt: "You are a careful local model. Think before answering.",
    skills: [
      { id: "reasoning", name: "Reasoning", description: "Local reasoning over text" },
    ],
  },
};
