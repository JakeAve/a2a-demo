// In-memory fan-out. KV is the source of truth for history; this bus only
// pushes live events to currently-connected SSE clients.
import type { A2AEvent } from "../src/observability/events.ts";

type Listener = (event: A2AEvent) => void;

export class EventBus {
  // sessionId -> listeners; "*" -> wildcard (sessions-list page).
  #subs = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.#subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subs.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#subs.delete(sessionId);
    };
  }

  publish(event: A2AEvent): void {
    for (const l of this.#subs.get(event.sessionId) ?? []) l(event);
    for (const l of this.#subs.get("*") ?? []) l(event);
  }
}
