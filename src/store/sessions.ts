// Maps an A2A contextId to the Claude Agent SDK session id, so the
// claude-code backend can `resume` a conversation across turns.
export class SessionStore {
  constructor(private kv: Deno.Kv) {}

  async get(contextId: string): Promise<string | undefined> {
    const res = await this.kv.get<string>(["cc-session", contextId]);
    return res.value ?? undefined;
  }

  async set(contextId: string, sessionId: string): Promise<void> {
    await this.kv.set(["cc-session", contextId], sessionId);
  }
}
