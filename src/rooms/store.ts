// Persistence for the Room Broker. Owns its OWN Deno KV. Mutations for a
// given room are serialised through a per-room promise chain so seq and
// turnCount never race (the pattern monitor/store.ts uses per session).
import type { Member, RoomRecord, TranscriptMessage } from "./types.ts";

export type CreateRoomInput = {
  title: string;
  createdBy: string;
  sessionId: string;
  maxTurns: number;
  members: Array<Pick<Member, "name" | "inboxUrl" | "kind">>;
};

export class RoomStore {
  #seq = new Map<string, number>();             // roomId -> next transcript seq
  #lock = new Map<string, Promise<unknown>>();  // per-room serialisation

  constructor(private kv: Deno.Kv, private now: () => number = () => Date.now()) {}

  // Chain `fn` onto any in-flight mutation for this room.
  #withLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#lock.get(roomId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#lock.set(roomId, next.catch(() => {}));
    return next;
  }

  async createRoom(input: CreateRoomInput): Promise<RoomRecord> {
    const roomId = crypto.randomUUID();
    const now = this.now();
    const room: RoomRecord = {
      roomId,
      title: input.title,
      createdBy: input.createdBy,
      status: "open",
      members: input.members.map((m) => ({ ...m, active: true, joinedAt: now })),
      turnCount: 0,
      maxTurns: input.maxTurns,
      lastActivityAt: now,
      sessionId: input.sessionId,
    };
    await this.kv.set(["room", roomId], room);
    for (const m of room.members) {
      await this.kv.set(["room_by_member", m.name, roomId], 1);
    }
    return room;
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return (await this.kv.get<RoomRecord>(["room", roomId])).value;
  }

  async #setRoom(room: RoomRecord): Promise<void> {
    room.lastActivityAt = this.now();
    await this.kv.set(["room", room.roomId], room);
  }

  async #nextSeq(roomId: string): Promise<number> {
    const cached = this.#seq.get(roomId);
    if (cached !== undefined) return cached;
    let max = -1;
    for await (const e of this.kv.list<TranscriptMessage>({ prefix: ["room_msg", roomId] })) {
      if (e.value.seq > max) max = e.value.seq;
    }
    const next = max + 1;
    this.#seq.set(roomId, next);
    return next;
  }

  appendMessage(
    roomId: string,
    msg: { from: string; to: string[]; text: string },
  ): Promise<TranscriptMessage> {
    return this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) throw new Error(`unknown room ${roomId}`);
      const seq = await this.#nextSeq(roomId);
      const message: TranscriptMessage = {
        seq, roomId, from: msg.from, to: msg.to, text: msg.text, ts: this.now(),
      };
      await this.kv.set(["room_msg", roomId, seq], message);
      this.#seq.set(roomId, seq + 1);
      room.turnCount += 1;
      await this.#setRoom(room);
      return message;
    });
  }

  async getTranscript(roomId: string): Promise<TranscriptMessage[]> {
    const out: TranscriptMessage[] = [];
    for await (const e of this.kv.list<TranscriptMessage>({ prefix: ["room_msg", roomId] })) {
      out.push(e.value);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  async addMember(roomId: string, m: Pick<Member, "name" | "inboxUrl" | "kind">): Promise<void> {
    await this.#withLock(roomId, async () => {
      const room = await this.getRoom(roomId);
      if (!room) throw new Error(`unknown room ${roomId}`);
      const existing = room.members.find((x) => x.name === m.name);
      if (existing) { existing.active = true; existing.inboxUrl = m.inboxUrl; }
      else room.members.push({ ...m, active: true, joinedAt: this.now() });
      await this.#setRoom(room);
      await this.kv.set(["room_by_member", m.name, roomId], 1);
    });
  }

  async listRoomsByMember(name: string): Promise<RoomRecord[]> {
    const out: RoomRecord[] = [];
    for await (const e of this.kv.list({ prefix: ["room_by_member", name] })) {
      const roomId = e.key[e.key.length - 1] as string;
      const room = await this.getRoom(roomId);
      if (room) out.push(room);
    }
    return out;
  }
}
