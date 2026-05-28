import { assertEquals } from "@std/assert";
import { startRegistry } from "../../src/registry/server.ts";
import type { AgentCard } from "../../src/protocol/types.ts";

const card = (name: string, port: number): AgentCard => ({
  name,
  description: "test",
  version: "1.0.0",
  url: `http://localhost:${port}`,
  skills: [{ id: "x", name: "x", description: "x" }],
  securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  security: [{ bearer: [] }],
});

Deno.test("registry: register, list, get, deregister", async () => {
  const reg = await startRegistry(0); // 0 = OS-assigned
  const base = `http://localhost:${reg.port}`;

  const a = card("alpha", 1111);
  await (await fetch(`${base}/register`, { method: "POST", body: JSON.stringify(a) })).body?.cancel();

  const list = await (await fetch(`${base}/agents`)).json();
  assertEquals(list.length, 1);
  assertEquals(list[0].name, "alpha");

  const one = await (await fetch(`${base}/agents/alpha`)).json();
  assertEquals(one.url, "http://localhost:1111");

  await (await fetch(`${base}/register/alpha`, { method: "DELETE" })).body?.cancel();
  const after = await (await fetch(`${base}/agents`)).json();
  assertEquals(after.length, 0);

  await reg.shutdown();
});

Deno.test("registry: 404 for unknown agent", async () => {
  const reg = await startRegistry(0);
  const res = await fetch(`http://localhost:${reg.port}/agents/nobody`);
  assertEquals(res.status, 404);
  await res.body?.cancel();
  await reg.shutdown();
});
