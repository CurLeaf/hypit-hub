import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { buildHypitInvocationArgs, runCheck } from "../src/build-runner.js";

const distributionRoot = resolve(import.meta.dirname, "../../..");
const workspace = resolve(distributionRoot, "examples/byok-openai-compatible");

test("buildHypitInvocationArgs never adds --runtime to hypit check", () => {
  const args = buildHypitInvocationArgs(["check", "productions/replica-1/runs/final.svrun"], workspace);
  assert.deepEqual(args, [
    "check",
    "productions/replica-1/runs/final.svrun",
    "--workspace",
    workspace,
    "--json",
  ]);
  assert.equal(args.includes("--runtime"), false);
});

test("runCheck completes for the official minimal example without runtime errors", async () => {
  const runPath = resolve(workspace, "minimal.svrun");
  const result = await runCheck(workspace, runPath);
  assert.equal(result.ok, true);
  assert.notEqual(result.summary, "--runtime does not apply to check");
});
