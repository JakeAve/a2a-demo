import { type AgentSpec, type AppConfig } from "./config.ts";
import type { RolePreset } from "./roles.ts";
import { startRegistry, type RegistryHandle } from "./registry/server.ts";
import { RegistryClient } from "./registry/client.ts";
import { startAgent, type AgentHandle } from "./agent/base.ts";
import { type SpawnResult } from "./agent/claude.ts";
import { ContextStore } from "./store/context.ts";
import { ThreadStore } from "./store/threads.ts";
import { SessionStore } from "./store/sessions.ts";
import { buildHandlers } from "./agent/handlers.ts";
import { runRepl } from "./repl.ts";
import type { AgentCard } from "./protocol/types.ts";
import { createEmitter } from "./observability/emit.ts";
import type { Emitter } from "./observability/emit.ts";

// Wait until the registry has an entry for `name`, or give up.
async function waitForRegistration(
  registry: RegistryClient,
  name: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await registry.get(name)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

export type OrchestratorContext = {
  registryClient: RegistryClient;
  store: ContextStore;
  threads: ThreadStore;
  agents: Map<string, AgentCard>;
  spawnAgent: (role: string, name?: string, model?: string) => Promise<SpawnResult>;
  availableRoles: () => Array<{ name: string; description: string; backend: string; defaultModel: string }>;
  emit: Emitter;
  bearerToken: string;
  registryPort: number;
  /** Idempotent cleanup: deregister + kill children + shut down agents/registry + close KV. Does NOT exit the process. */
  shutdown: () => Promise<void>;
};

export type SetupOpts = {
  /** stdio mode for spawned child agents. "null" suppresses their stdout (use in MCP mode). Default "inherit". */
  childStdout?: "inherit" | "null";
};

export async function setupOrchestrator(
  cfg: AppConfig,
  specs: AgentSpec[],
  roles: Record<string, RolePreset>,
  opts: SetupOpts = {},
): Promise<OrchestratorContext> {
  const childStdout = opts.childStdout ?? "inherit";
  const registry: RegistryHandle = await startRegistry(cfg.registryPort);
  const registryClient = new RegistryClient(`http://localhost:${registry.port}`);
  const kv = await Deno.openKv();
  const emit = createEmitter(cfg.monitorUrl || undefined, cfg.bearerToken);
  // Max delegation depth: a fixed A2A_MAX_DEPTH if set, else pegged to the
  // current registered-agent count (floored at 2 so it never tightens below
  // the original REPL→A→B budget). More agents → deeper fan-out allowed.
  const resolveMaxDepth = async () =>
    cfg.maxDepth > 0 ? cfg.maxDepth : Math.max(2, (await registryClient.list()).length);
  const store = new ContextStore(kv);
  const threads = new ThreadStore(kv);
  const sessions = new SessionStore(kv);

  console.log(`[registry]   localhost:${registry.port}`);

  const agents = new Map<string, AgentCard>();
  const handles: AgentHandle[] = [];
  const children = new Map<string, Deno.ChildProcess>();

  const availableRoles = () =>
    Object.entries(roles).map(([name, r]) => ({
      name,
      description: r.description,
      backend: r.backend,
      defaultModel: r.model,
    }));

  const spawnAgent = async (
    role: string,
    customName?: string,
    modelOverride?: string,
  ): Promise<SpawnResult> => {
    const preset = roles[role];
    if (!preset) return { ok: false, error: `unknown role ${role}` };
    const name = customName ?? role;
    if (agents.has(name) || children.has(name)) {
      return { ok: false, error: `agent "${name}" already running` };
    }
    const perms = ["--allow-net", "--allow-env", "--allow-read", "--unstable-kv"];
    if (preset.backend === "claude-code") {
      perms.push("--allow-run", "--allow-write", "--allow-sys");
    }
    const args = [
      "run",
      "--env-file=.env",
      ...perms,
      "src/agent-entry.ts",
      `--role=${role}`,
      `--name=${name}`,
      `--registry=http://localhost:${registry.port}`,
    ];
    if (modelOverride) args.push(`--model=${modelOverride}`);
    try {
      const child = new Deno.Command(Deno.execPath(), {
        args,
        stdout: childStdout,
        stderr: "inherit",
      }).spawn();
      children.set(name, child);
      const ok = await waitForRegistration(registryClient, name);
      if (!ok) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        children.delete(name);
        return { ok: false, error: `agent "${name}" failed to register within timeout` };
      }
      const card = await registryClient.get(name);
      if (card) agents.set(name, card);
      console.log(`[${name}]   spawned (${preset.backend}/${role})`);
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  };

  for (const spec of specs) {
    try {
      const baseCard: AgentCard = {
        name: spec.name,
        description: spec.preset.description,
        version: "1.0.0",
        url: "http://localhost:0",
        skills: spec.preset.skills,
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ bearer: [] }],
      };

      const handlers = await buildHandlers({
        model: spec.model,
        preset: spec.preset,
        cfg,
        store,
        threads,
        sessions,
        registry: registryClient,
        selfName: spec.name,
        spawnAgent,
        availableRoles,
        emit,
      });

      const handle = await startAgent({
        card: baseCard,
        bearerToken: cfg.bearerToken,
        handler: handlers.handler,
        streamHandler: handlers.streamHandler,
        emit,
        maxDepth: resolveMaxDepth,
      });
      await registryClient.register(handle.card);
      handles.push(handle);
      agents.set(spec.name, handle.card);
      console.log(`[${spec.name}]   ${handle.card.url}  (${spec.model})`);
    } catch (e) {
      console.error(`[${spec.name}] failed to start: ${(e as Error).message}`);
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\nshutting down...");
    for (const [name, child] of children) {
      try { await registryClient.deregister(name); } catch { /* ignore */ }
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    for (const h of handles) {
      try { await registryClient.deregister(h.card.name); } catch { /* ignore */ }
      try { await h.shutdown(); } catch { /* ignore */ }
    }
    try { await registry.shutdown(); } catch { /* ignore */ }
    kv.close();
  };

  return {
    registryClient,
    store,
    threads,
    agents,
    spawnAgent,
    availableRoles,
    emit,
    bearerToken: cfg.bearerToken,
    registryPort: registry.port,
    shutdown,
  };
}

export async function runOrchestrator(
  cfg: AppConfig,
  specs: AgentSpec[],
  roles: Record<string, RolePreset>,
): Promise<void> {
  const ctx = await setupOrchestrator(cfg, specs, roles);
  let signalFired = false;
  Deno.addSignalListener("SIGINT", () => {
    signalFired = true;
    ctx.shutdown().then(() => Deno.exit(0));
  });
  await runRepl({ agents: ctx.agents, bearerToken: ctx.bearerToken, emit: ctx.emit });
  if (!signalFired) {
    await ctx.shutdown();
    Deno.exit(0);
  }
}
