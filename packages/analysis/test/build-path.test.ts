import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runPlan, runPricing, runCheck } from "../src/build-runner.js";

const distributionRoot = resolve(import.meta.dirname, "../../..");
const workspace = resolve(distributionRoot, "examples/byok-openai-compatible");
const runtimePath = resolve(workspace, "hypit.runtime.json");
const runPath = resolve(workspace, "productions/replica-1789911123080/runs/final.svrun");

test("ugc replica passes check before build planning", async () => {
  const check = await runCheck(workspace, runPath);
  assert.equal(check.ok, true);
});

test("ugc replica plan and pricing accept byok runtime profile", async () => {
  const plan = await runPlan(workspace, runPath, runtimePath);
  const pricing = await runPricing(workspace, runPath, runtimePath);
  assert.ok(plan.summary.length > 0 || plan.raw !== undefined);
  assert.ok(pricing.summary.length > 0 || pricing.raw !== undefined);
});
