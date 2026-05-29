// monitor/store.ts
// KV-backed persistence for A2A monitor events.
import type { A2AEvent, EmitEvent } from "../src/observability/events.ts";

export type SessionSummary = {
  sessionId: string;
  firstTs: number;
  lastTs: number;
  eventCount: number;
};

/**
 * Key layout:
 *   ["event", sessionId, seq]  -> A2AEvent
 *   ["session", sessionId]     -> SessionSummary
 *   ["seq"]                    -> number (global monotonic counter)
 */
export class MonitorStore {
  #kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.#kv = kv;
  }

  async ingest(raw: EmitEvent): Promise<A2AEvent> {
    // Atomically bump the global seq counter and write the event.
    const seqKey = ["seq"];
    let seq = 0;
    while (true) {
      const entry = await this.#kv.get<number>(seqKey);
      seq = (entry.value ?? 0) + 1;
      const event: A2AEvent = { ...raw, seq };

      // Read current session summary (may not exist yet).
      const sumKey = ["session", raw.sessionId];
      const sumEntry = await this.#kv.get<SessionSummary>(sumKey);
      const prev = sumEntry.value;
      const summary: SessionSummary = {
        sessionId: raw.sessionId,
        firstTs: prev?.firstTs ?? raw.ts,
        lastTs: raw.ts,
        eventCount: (prev?.eventCount ?? 0) + 1,
      };

      const res = await this.#kv.atomic()
        .check(entry) // guard on seq
        .check(sumEntry) // guard on summary
        .set(seqKey, seq)
        .set(["event", raw.sessionId, seq], event)
        .set(sumKey, summary)
        .commit();

      if (res.ok) return event;
      // Retry if CAS failed (another concurrent ingest).
    }
  }

  async listSessions(): Promise<SessionSummary[]> {
    const results: SessionSummary[] = [];
    const iter = this.#kv.list<SessionSummary>({ prefix: ["session"] });
    for await (const entry of iter) {
      results.push(entry.value);
    }
    return results;
  }

  async getSessionEvents(sessionId: string): Promise<A2AEvent[]> {
    const results: A2AEvent[] = [];
    const iter = this.#kv.list<A2AEvent>({ prefix: ["event", sessionId] });
    for await (const entry of iter) {
      results.push(entry.value);
    }
    return results;
  }
}
