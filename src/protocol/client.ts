import type { Message } from "./types.ts";

export type SendOptions = {
  url: string;             // target agent base URL
  token: string;           // bearer
  depth: number;           // current delegation depth (will be sent as x-depth)
  message: Message;
};

export type SendResult = { text: string };

export async function sendMessage(opts: SendOptions): Promise<SendResult> {
  const res = await fetch(`${opts.url}/message/send`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${opts.token}`,
      "x-depth": String(opts.depth),
    },
    body: JSON.stringify({ message: opts.message }),
  });
  if (res.status === 429) {
    await res.body?.cancel();
    throw new Error("max delegation depth reached");
  }
  if (!res.ok) throw new Error(`send failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return { text: String(json.text ?? "") };
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string; args: unknown }
  | { type: "error"; message: string }
  | { type: "done" };

export async function* streamMessage(opts: SendOptions): AsyncGenerator<StreamEvent> {
  const res = await fetch(`${opts.url}/message/stream`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${opts.token}`,
      "x-depth": String(opts.depth),
      "accept": "text/event-stream",
    },
    body: JSON.stringify({ message: opts.message }),
  });
  if (!res.ok || !res.body) {
    yield { type: "error", message: `stream failed: ${res.status}` };
    return;
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === "[DONE]") {
        yield { type: "done" };
        return;
      }
      try {
        yield JSON.parse(payload) as StreamEvent;
      } catch {
        // ignore malformed frames
      }
    }
  }
  yield { type: "done" };
}
