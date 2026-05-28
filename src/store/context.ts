export type StoredMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export class ContextStore {
  constructor(private kv: Deno.Kv) {}

  async get(contextId: string): Promise<StoredMessage[]> {
    const res = await this.kv.get<StoredMessage[]>(["context", contextId]);
    return res.value ?? [];
  }

  async append(contextId: string, message: StoredMessage): Promise<void> {
    const current = await this.get(contextId);
    current.push(message);
    await this.kv.set(["context", contextId], current);
  }

  async clear(contextId: string): Promise<void> {
    await this.kv.delete(["context", contextId]);
  }
}
