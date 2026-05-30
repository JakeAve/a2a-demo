import type { PostInput, RoomRecord, TranscriptMessage } from "./types.ts";

export type CreateRoomBody = {
  title: string;
  members: string[]; // agent names; broker resolves inbox URLs
  createdBy: string;
  sessionId: string;
  maxTurns?: number;
  humanMembers?: Array<{ name: string; inboxUrl: string }>; // REPL supplies its own URL
};

export class RoomBrokerClient {
  constructor(private baseUrl: string, private token: string) {}

  #headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "authorization": `Bearer ${this.token}`,
    };
  }

  async createRoom(
    body: CreateRoomBody,
  ): Promise<{ roomId: string; unresolved: string[] }> {
    const res = await fetch(`${this.baseUrl}/rooms`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`createRoom failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }

  async post(roomId: string, body: PostInput): Promise<{ seq: number }> {
    const res = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/post`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`post failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  }

  async ack(
    roomId: string,
    body: { from: string; turnId: string },
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/ack`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
      },
    );
    await res.body?.cancel();
  }

  async invite(roomId: string, agent: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/invite`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ agent }),
      },
    );
    if (!res.ok) throw new Error(`invite failed: ${res.status}`);
    await res.body?.cancel();
  }

  async join(
    roomId: string,
    body: { name: string; inboxUrl: string; kind?: "agent" | "human" },
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/join`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`join failed: ${res.status} ${await res.text()}`);
    }
    await res.body?.cancel();
  }

  async leave(roomId: string, agent: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}/leave`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify({ agent }),
      },
    );
    await res.body?.cancel();
  }

  async get(
    roomId: string,
  ): Promise<{ room: RoomRecord; transcript: TranscriptMessage[] } | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/rooms/${encodeURIComponent(roomId)}`,
        {
          headers: this.#headers(),
        },
      );
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async listByMember(name: string): Promise<RoomRecord[]> {
    try {
      const res = await fetch(
        `${this.baseUrl}/rooms?member=${encodeURIComponent(name)}`,
        {
          headers: this.#headers(),
        },
      );
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }
}
