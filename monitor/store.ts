// monitor/store.ts
// Persistence for the monitor. Owns its OWN Deno KV (never the agents' KV).
// Assigns the authoritative `seq` on ingest and maintains a per-session
// summary so the sessions list never scans all events.
import { type A2AEvent, type EmitEvent, parseEvent } from "../src/observability/events.ts";

export type SessionSummary = {
  sessionId: string;
  startedAt: number;
  lastEventAt: number;
  agents: string[];
  requestCount: number;
  lastSeq: number;
  status: "active" | "done";
};

export class MonitorStore {
  // In-memory next-seq cache per session; rehydrated from KV on miss.
  #nextSeq = new Map<string, number>();

  // Per-session ingest queue: each new ingest for a session chains onto the
  // last promise, serialising concurrent HTTP requests without a global lock.
  #queue = new Map<string, Promise<A2AEvent>>();

  constructor(private kv: Deno.Kv) {}

  async #seqFor(sessionId: string): Promise<number> {
    const cached = this.#nextSeq.get(sessionId);
    if (cached !== undefined) return cached;
    const summary = await this.kv.get<SessionSummary>(["session", sessionId]);
    const next = summary.value ? summary.value.lastSeq + 1 : 0;
    this.#nextSeq.set(sessionId, next);
    return next;
  }

  // Serialised work for a single ingest call (must not throw before it sets
  // nextSeq — if it does, the queue stays broken for the session, which is
  // acceptable: the whole request failed anyway).
  async #doIngest(input: EmitEvent | A2AEvent): Promise<A2AEvent> {
    const seq = await this.#seqFor(input.sessionId);
    const event = parseEvent({ ...input, seq });
    this.#nextSeq.set(event.sessionId, seq + 1);

    await this.kv.set(["evt", event.sessionId, event.requestId, seq], event);
    await this.#updateSummary(event);
    return event;
  }

  ingest(input: EmitEvent | A2AEvent): Promise<A2AEvent> {
    const sessionId = input.sessionId;
    // Chain onto the previous in-flight ingest for this session so concurrent
    // HTTP POSTs are serialised and seq numbers never collide.
    const prev = this.#queue.get(sessionId) ?? Promise.resolve({} as A2AEvent);
    const next = prev.then(() => this.#doIngest(input));
    // Store a version that swallows errors so a failed ingest doesn't break the
    // queue for subsequent callers.
    this.#queue.set(sessionId, next.catch(() => ({} as A2AEvent)));
    return next;
  }

  async #updateSummary(event: A2AEvent): Promise<void> {
    const key = ["session", event.sessionId];
    const cur = (await this.kv.get<SessionSummary>(key)).value;
    const agents = new Set(cur?.agents ?? []);
    if (event.agent) agents.add(event.agent);
    const summary: SessionSummary = {
      sessionId: event.sessionId,
      startedAt: cur?.startedAt ?? event.ts,
      lastEventAt: event.ts,
      agents: [...agents],
      requestCount: await this.#countRequests(event),
      lastSeq: event.seq,
      status: "active",
    };
    await this.kv.set(key, summary);
  }

  // Count distinct requestIds by recording each on first sight, then scanning.
  async #countRequests(event: A2AEvent): Promise<number> {
    const reqKey = ["session_req", event.sessionId, event.requestId];
    if (!(await this.kv.get(reqKey)).value) await this.kv.set(reqKey, 1);
    let count = 0;
    for await (const _ of this.kv.list({ prefix: ["session_req", event.sessionId] })) count++;
    return count;
  }

  async getSessionEvents(sessionId: string): Promise<A2AEvent[]> {
    const out: A2AEvent[] = [];
    for await (const entry of this.kv.list<A2AEvent>({ prefix: ["evt", sessionId] })) {
      out.push(entry.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async getRequestEvents(sessionId: string, requestId: string): Promise<A2AEvent[]> {
    const out: A2AEvent[] = [];
    for await (const entry of this.kv.list<A2AEvent>({ prefix: ["evt", sessionId, requestId] })) {
      out.push(entry.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    for await (const entry of this.kv.list<SessionSummary>({ prefix: ["session"] })) {
      out.push(entry.value);
    }
    out.sort((a, b) => b.lastEventAt - a.lastEventAt);
    return out;
  }
}
