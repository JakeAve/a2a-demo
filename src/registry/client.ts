import type { AgentCard } from "../protocol/types.ts";

export class RegistryClient {
  constructor(private baseUrl: string) {}

  async register(card: AgentCard): Promise<void> {
    const res = await fetch(`${this.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(card),
    });
    if (!res.ok) throw new Error(`register failed: ${res.status}`);
    await res.body?.cancel();
  }

  async deregister(name: string): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/register/${encodeURIComponent(name)}`,
      {
        method: "DELETE",
      },
    );
    await res.body?.cancel();
  }

  async list(): Promise<AgentCard[]> {
    try {
      const res = await fetch(`${this.baseUrl}/agents`);
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }

  async get(name: string): Promise<AgentCard | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/agents/${encodeURIComponent(name)}`,
      );
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }
}
