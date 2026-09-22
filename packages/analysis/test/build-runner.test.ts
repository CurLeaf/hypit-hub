import assert from "node:assert/strict";
import test from "node:test";

import { buildHypitInvocationArgs } from "../src/build-runner.js";

test("buildHypitInvocationArgs never adds --runtime to hypit check", () => {
  const workspace = "/tmp/hypit-workspace";
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
