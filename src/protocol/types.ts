export type TextPart = { type: "text"; text: string };
export type DataPart = { type: "data"; data: unknown };
export type Part = TextPart | DataPart;

export type Message = {
  messageId: string;
  role: "user" | "agent";
  parts: Part[];
  contextId?: string;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
};

export type SecurityScheme = {
  type: "http";
  scheme: "bearer";
};

export type AgentCard = {
  name: string;
  description: string;
  version: string;
  url: string;
  skills: Skill[];
  securitySchemes: Record<string, SecurityScheme>;
  security: Array<Record<string, string[]>>;
};

export type Task = {
  id: string;
  contextId: string;
  status: "submitted" | "working" | "completed" | "failed" | "canceled";
  result?: string;
  error?: string;
};

export function isAgentCard(v: unknown): v is AgentCard {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.name === "string" &&
    typeof o.description === "string" &&
    typeof o.version === "string" &&
    typeof o.url === "string" &&
    Array.isArray(o.skills) &&
    typeof o.securitySchemes === "object" &&
    Array.isArray(o.security)
  );
}

export function isPart(v: unknown): v is Part {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string";
  if (o.type === "data") return "data" in o;
  return false;
}

export function isMessage(v: unknown): v is Message {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.messageId === "string" &&
    (o.role === "user" || o.role === "agent") &&
    Array.isArray(o.parts) &&
    o.parts.every(isPart)
  );
}
