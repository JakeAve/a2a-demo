// A tiny, optional event-export seam. When no monitor URL is configured,
// emit() is a no-op so agents incur zero coupling. Otherwise it fire-and-
// forgets a POST and swallows all errors — observability must never affect
// agent behavior.
import type { EmitEvent } from "./events.ts";

export type Emitter = (event: EmitEvent) => Promise<void>;

// Injectable transport so tests don't hit the network. Defaults to fetch.
export type PostFn = (url: string, body: EmitEvent, token?: string) => Promise<void>;

const defaultPost: PostFn = async (url, body, token) => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
};

export function createEmitter(
  monitorUrl: string | undefined,
  token: string | undefined,
  post: PostFn = defaultPost,
): Emitter {
  if (!monitorUrl) return () => Promise.resolve();
  const ingest = `${monitorUrl.replace(/\/$/, "")}/ingest`;
  return (event: EmitEvent) => {
    // Drop events that can't be correlated to a session/request — they would
    // fail schema validation at the monitor and can't be placed in any tree.
    if (!event.sessionId || !event.requestId) return Promise.resolve();
    // Fire-and-forget: do not await the network in the agent's hot path.
    void post(ingest, event, token).catch(() => {});
    return Promise.resolve();
  };
}

// Convenience for stamping `ts` at the call site.
export function now(): number {
  return Date.now();
}
