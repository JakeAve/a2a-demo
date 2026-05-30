// tests/agent/tools-emit.test.ts
import { assertEquals } from "@std/assert";
import { runTool, type ToolDeps } from "../../src/agent/tools.ts";
import type { EmitEvent } from "../../src/observability/events.ts";
import { RegistryClient } from "../../src/registry/client.ts";

Deno.test("runTool(list_agents) emits a tool.call event with ids", async () => {
  const events: EmitEvent[] = [];
  // Registry stub returning an empty agent list.
  const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
    if (new URL(req.url).pathname === "/agents") {
      return new Response("[]", {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("null", {
      headers: { "content-type": "application/json" },
    });
  });
  const port = (server.addr as Deno.NetAddr).port;

  const deps: ToolDeps = {
    store: null as never,
    threads: null as never,
    registry: new RegistryClient(`http://localhost:${port}`),
    bearerToken: "t",
    selfName: "coordinator",
    emit: (e) => {
      events.push(e);
      return Promise.resolve();
    },
  };

  await runTool(deps, "list_agents", {}, 0, "ctx1", {
    sessionId: "s1",
    requestId: "r1",
  });
  await server.shutdown();

  const call = events.find((e) => e.type === "tool.call")!;
  assertEquals(call.data.tool, "list_agents");
  assertEquals(call.sessionId, "s1");
  assertEquals(call.requestId, "r1");
  assertEquals(call.agent, "coordinator");
});
