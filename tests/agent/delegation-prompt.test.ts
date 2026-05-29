// Guards the delegation *framing* in prompts. These are prose contracts, not
// behavior: they pin the fix for the over-correction where delegating roles
// (and the shared suffix) told agents to answer directly by default and then
// ignored explicit "route this to peer X" instructions. See session
// 1b114ce1: the researcher narrated "I'll forward to the summarizer" and then
// ended its turn without ever calling a delegation tool.
import { assert } from "@std/assert";
import { buildSystemSuffix, DELEGATION_SUFFIX, type ToolDeps } from "../../src/agent/tools.ts";
import { loadRoles } from "../../src/roles.ts";

// buildSystemSuffix only branches on deps.spawnAgent; a bare cast is enough.
const baseDeps = {} as ToolDeps;

Deno.test("delegation suffix honors explicit routing requests", () => {
  const suffix = buildSystemSuffix(baseDeps);
  // The carve-out that fixes the bug: an explicit instruction to delegate/route
  // must override the restraint, and narrating-without-calling is a failure.
  assert(
    /explicit/i.test(suffix),
    "suffix must carve out explicit delegation/routing requests",
  );
  assert(
    /route|forward|hand/i.test(suffix),
    "suffix must reference routing/forwarding work to a peer",
  );
});

Deno.test("delegation suffix dropped the answer-by-default over-correction", () => {
  // These exact phrasings were the over-correction. Their removal is the fix.
  assert(
    !/answer most requests yourself/i.test(DELEGATION_SUFFIX),
    "suffix should no longer tell agents to answer most requests themselves by default",
  );
});

Deno.test("researcher prompt defaults to decompose-and-delegate", async () => {
  const roles = await loadRoles();
  const p = roles.researcher.systemPrompt;
  assert(/decompose|break|sub-question/i.test(p), "researcher should frame decomposition");
  assert(/delegat/i.test(p), "researcher should frame delegation");
  // The suppression phrasings that contradicted the researcher's whole purpose.
  assert(
    !/that's usually the right call/i.test(p),
    "researcher should not say answering directly is usually the right call",
  );
  assert(
    !/don't split a question you could answer yourself/i.test(p),
    "researcher should not discourage splitting questions",
  );
});

Deno.test("coordinator prompt honors named-peer routing", async () => {
  const roles = await loadRoles();
  const p = roles.coordinator.systemPrompt;
  assert(/route|name|ask/i.test(p), "coordinator should honor routing to a named peer");
});
