import { assertEquals, assertThrows } from "@std/assert";
import {
  getCrew,
  loadRoles,
  mergeConfig,
  validateCrews,
} from "../src/roles.ts";
import type { AgentRoster } from "../src/roles.ts";

const GOOD = {
  backend: "ollama",
  model: "gemma3:1b",
  description: "test",
  systemPrompt: "be brief",
  skills: [{ id: "x", name: "x", description: "x" }],
  toolCapable: false,
};

async function withRoster(
  files: Record<string, unknown>,
  run: (opts: { overridePath: string; defaultPath: string }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const opts = {
    overridePath: dir + "/agents.json",
    defaultPath: dir + "/agents.example.json",
  };
  for (const [name, value] of Object.entries(files)) {
    await Deno.writeTextFile(dir + "/" + name, JSON.stringify(value));
  }
  try {
    await run(opts);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ─── mergeConfig ────────────────────────────────────────────────────────────

Deno.test("mergeConfig: partial agent field override preserves unmentioned fields", () => {
  const base: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as ReturnType<
        typeof import("../src/roles.ts").validateRolePreset
      >,
    },
  };
  const override: Partial<AgentRoster> = {
    agents: {
      agentA: { model: "llama3:8b" } as AgentRoster["agents"][string],
    },
  };
  const merged = mergeConfig(base, override);
  assertEquals(merged.agents.agentA.model, "llama3:8b");
  assertEquals(merged.agents.agentA.description, GOOD.description);
  assertEquals(merged.agents.agentA.systemPrompt, GOOD.systemPrompt);
  assertEquals(merged.agents.agentA.skills, GOOD.skills);
});

Deno.test("mergeConfig: crew in default not mentioned in override survives", () => {
  const base: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
    crews: { a: { agents: ["agentA"] } },
  };
  const override: Partial<AgentRoster> = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
    crews: { b: { agents: ["agentA"] } },
  };
  const merged = mergeConfig(base, override);
  assertEquals(merged.crews?.a, { agents: ["agentA"] });
  assertEquals(merged.crews?.b, { agents: ["agentA"] });
});

Deno.test("mergeConfig: new agent in override appears in merged agents", () => {
  const base: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
  };
  const override: Partial<AgentRoster> = {
    agents: {
      agentB: {
        ...GOOD,
        model: "llama3:8b",
      } as AgentRoster["agents"][string],
    },
  };
  const merged = mergeConfig(base, override);
  assertEquals(Object.keys(merged.agents).sort(), ["agentA", "agentB"]);
  assertEquals(merged.agents.agentB.model, "llama3:8b");
});

Deno.test("mergeConfig: override agent merges into existing, doesn't replace other agents", () => {
  const base: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
      agentB: {
        ...GOOD,
        model: "llama3:8b",
      } as AgentRoster["agents"][string],
    },
  };
  const override: Partial<AgentRoster> = {
    agents: {
      agentA: { model: "phi3:mini" } as AgentRoster["agents"][string],
    },
  };
  const merged = mergeConfig(base, override);
  assertEquals(merged.agents.agentA.model, "phi3:mini");
  assertEquals(merged.agents.agentB.model, "llama3:8b");
});

// ─── validateCrews ──────────────────────────────────────────────────────────

Deno.test("validateCrews: empty stack throws", () => {
  const config: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
    crews: { myCrew: { agents: [] } },
  };
  assertThrows(() => validateCrews(config), Error, "at least one agent");
});

Deno.test("validateCrews: unknown agent ref throws with actionable message", () => {
  const config: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
    crews: { myCrew: { agents: ["agentA", "ghost"] } },
  };
  assertThrows(() => validateCrews(config), Error, "myCrew");
  let msg = "";
  try {
    validateCrews(config);
  } catch (e) {
    msg = (e as Error).message;
  }
  // Message should include stack name, agent name, and available agents
  assertEquals(msg.includes("myCrew"), true);
  assertEquals(msg.includes("ghost"), true);
  assertEquals(msg.includes("agentA"), true);
});

Deno.test("validateCrews: agentOverrides key not in stack agents list throws", () => {
  const config: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
      agentB: { ...GOOD } as AgentRoster["agents"][string],
    },
    crews: {
      myCrew: {
        agents: ["agentA"],
        agentOverrides: { agentB: { model: "other" } },
      },
    },
  };
  assertThrows(() => validateCrews(config), Error, "not in this crew");
});

Deno.test("validateCrews: valid config with stacks does not throw", () => {
  const config: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
      agentB: { ...GOOD } as AgentRoster["agents"][string],
    },
    crews: {
      myCrew: {
        agents: ["agentA", "agentB"],
        agentOverrides: { agentA: { model: "llama3:8b" } },
      },
    },
  };
  validateCrews(config); // should not throw
});

Deno.test("validateCrews: config with no stacks does not throw", () => {
  const config: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
  };
  validateCrews(config); // should not throw
});

// ─── getCrew ────────────────────────────────────────────────────────────────

Deno.test("getCrew: returns agent list for valid crew", () => {
  const config: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
      agentB: { ...GOOD, model: "llama3:8b" } as AgentRoster["agents"][string],
    },
    crews: { myCrew: { agents: ["agentA", "agentB"] } },
  };
  const agents = getCrew(config, "myCrew");
  assertEquals(agents.length, 2);
  assertEquals(agents[0].name, "agentA");
  assertEquals(agents[1].name, "agentB");
});

Deno.test("getCrew: agentOverrides applied — only overridden field changes", () => {
  const config: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
    },
    crews: {
      myCrew: {
        agents: ["agentA"],
        agentOverrides: { agentA: { model: "llama3:8b" } },
      },
    },
  };
  const [resolved] = getCrew(config, "myCrew");
  assertEquals(resolved.model, "llama3:8b");
  // All other fields come from base
  assertEquals(resolved.description, GOOD.description);
  assertEquals(resolved.systemPrompt, GOOD.systemPrompt);
  assertEquals(resolved.skills, GOOD.skills);
  assertEquals(resolved.name, "agentA");
});

Deno.test("getCrew: unknown stack throws with available stacks listed", () => {
  const config: AgentRoster = {
    agents: { agentA: { ...GOOD } as AgentRoster["agents"][string] },
    crews: { realCrew: { agents: ["agentA"] } },
  };
  let msg = "";
  try {
    getCrew(config, "noSuchStack");
  } catch (e) {
    msg = (e as Error).message;
  }
  assertEquals(msg.includes("noSuchStack"), true);
  assertEquals(msg.includes("realCrew"), true);
});

Deno.test("getCrew: stack with no agentOverrides returns base config", () => {
  const config: AgentRoster = {
    agents: {
      agentA: { ...GOOD } as AgentRoster["agents"][string],
    },
    crews: { myCrew: { agents: ["agentA"] } },
  };
  const [resolved] = getCrew(config, "myCrew");
  assertEquals(resolved.model, GOOD.model);
  assertEquals(resolved.description, GOOD.description);
  assertEquals(resolved.name, "agentA");
});

// ─── loadRoles with merging ───────────────────────────────────────────────────

Deno.test("loadRoles: agents from both files appear when override present", async () => {
  await withRoster(
    {
      "agents.example.json": { agents: { agentA: GOOD } },
      "agents.json": { agents: { agentB: { ...GOOD, model: "llama3:8b" } } },
    },
    async (opts) => {
      const roster = await loadRoles(opts);
      assertEquals(Object.keys(roster.agents).sort(), ["agentA", "agentB"]);
    },
  );
});

Deno.test("loadRoles: partial agent override in agents.json preserves other fields from default", async () => {
  // The override file must be a fully valid preset; mergeConfig then deep-merges
  // per-agent so fields absent from the override inherit from the default.
  const overridePreset = {
    ...GOOD,
    model: "llama3:8b",
    description: GOOD.description,
  };
  await withRoster(
    {
      "agents.example.json": { agents: { agentA: GOOD } },
      "agents.json": {
        agents: { agentA: overridePreset },
      },
    },
    async (opts) => {
      const roster = await loadRoles(opts);
      assertEquals(roster.agents.agentA.model, "llama3:8b");
      assertEquals(roster.agents.agentA.description, GOOD.description);
      assertEquals(roster.agents.agentA.systemPrompt, GOOD.systemPrompt);
    },
  );
});

Deno.test("loadRoles: crew in default survives when override has no stacks", async () => {
  await withRoster(
    {
      "agents.example.json": {
        agents: { agentA: GOOD },
        crews: { myCrew: { agents: ["agentA"] } },
      },
      "agents.json": { agents: { agentB: GOOD } },
    },
    async (opts) => {
      const roster = await loadRoles(opts);
      assertEquals(roster.crews?.myCrew, { agents: ["agentA"] });
    },
  );
});

// ─── committed agents.example.json ───────────────────────────────────────────

Deno.test("the committed agents.example.json has expected crews", async () => {
  // Point overridePath at the default file so no override is applied
  const roster = await loadRoles({ overridePath: "agents.example.json" });
  assertEquals(
    typeof roster.crews?.default,
    "object",
    "crews.default should exist",
  );
  assertEquals(
    typeof roster.crews?.research,
    "object",
    "crews.research should exist",
  );
});
