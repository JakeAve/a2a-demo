// src/observability/events.ts
// Single source of truth for the monitor event envelope. Imported by the
// agent-side emitter (src/observability/emit.ts) and the monitor service.
import { z } from "zod";

export const EVENT_TYPES = [
  "request.started",
  "turn.started",
  "delegate.start",
  "delegate.continue",
  "delegate.return",
  "tool.call",
  "spawn",
  "message.completed",
  "turn.completed",
  "error",
  "request.completed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

// `seq` is assigned by the monitor on ingest, so emitters send 0 as a
// placeholder. Everything else is stamped by the emitting agent.
export const EventSchema = z.object({
  sessionId: z.string().min(1),
  requestId: z.string().min(1),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  agent: z.string().min(1),
  depth: z.number().int().nonnegative(),
  threadId: z.string().optional(),
  type: z.enum(EVENT_TYPES),
  data: z.record(z.string(), z.unknown()).default({}),
});

export type A2AEvent = z.infer<typeof EventSchema>;

// The shape an emitter constructs (no seq — monitor assigns it).
export type EmitEvent = Omit<A2AEvent, "seq">;

export function parseEvent(input: unknown): A2AEvent {
  return EventSchema.parse(input);
}
