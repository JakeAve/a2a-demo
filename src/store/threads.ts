// Persistent metadata for delegation threads. The actual message history
// lives in ContextStore under the thread's id; this store tracks the
// parent-owned thread metadata so an agent can list/continue/reset its
// sub-conversations across turns.

export type ThreadMeta = {
  threadId: string;
  peer: string;
  parentContextId: string;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
  title: string;
};

export class ThreadStore {
  constructor(private kv: Deno.Kv) {}

  async start(
    parentContextId: string,
    peer: string,
    title: string,
  ): Promise<ThreadMeta> {
    const now = new Date().toISOString();
    const meta: ThreadMeta = {
      threadId: crypto.randomUUID(),
      peer,
      parentContextId,
      createdAt: now,
      lastUsedAt: now,
      turnCount: 0,
      title,
    };
    await this.kv.set(["thread", meta.threadId], meta);
    await this.kv.set(
      ["thread_owner", parentContextId, meta.threadId],
      meta.peer,
    );
    return meta;
  }

  async get(threadId: string): Promise<ThreadMeta | null> {
    const res = await this.kv.get<ThreadMeta>(["thread", threadId]);
    return res.value;
  }

  async touch(threadId: string): Promise<ThreadMeta | null> {
    const meta = await this.get(threadId);
    if (!meta) return null;
    meta.turnCount += 1;
    meta.lastUsedAt = new Date().toISOString();
    await this.kv.set(["thread", threadId], meta);
    return meta;
  }

  async list(parentContextId: string): Promise<ThreadMeta[]> {
    const out: ThreadMeta[] = [];
    for await (
      const entry of this.kv.list({
        prefix: ["thread_owner", parentContextId],
      })
    ) {
      const id = entry.key[entry.key.length - 1] as string;
      const meta = await this.get(id);
      if (meta) out.push(meta);
    }
    return out;
  }

  async reset(threadId: string): Promise<boolean> {
    const meta = await this.get(threadId);
    if (!meta) return false;
    await this.kv.delete(["thread", threadId]);
    await this.kv.delete(["thread_owner", meta.parentContextId, threadId]);
    await this.kv.delete(["context", threadId]);
    return true;
  }
}
