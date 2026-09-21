import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { refreshScaffoldCheck } from "../src/workflow.js";

const distributionRoot = resolve(import.meta.dirname, "../../..");
const workspace = resolve(distributionRoot, "examples/byok-openai-compatible");

test("refreshScaffoldCheck replaces stale --runtime check failures", async () => {
  const runPath = resolve(workspace, "minimal.svrun");
  const refreshed = await refreshScaffoldCheck(workspace, {
    productionDir: workspace,
    runPath,
    authorPath: resolve(workspace, "minimal.svml"),
    formatId: "ugc",
    checkOk: false,
    checkSummary: "--runtime does not apply to check",
  });
  assert.equal(refreshed.checkOk, true);
  assert.notEqual(refreshed.checkSummary, "--runtime does not apply to check");
});

test("refreshScaffoldCheck passes for ugc replica with product reference assets", async () => {
  const productionDir = resolve(workspace, "productions/replica-1789911123080");
  const runPath = resolve(productionDir, "runs/final.svrun");
  const refreshed = await refreshScaffoldCheck(workspace, {
    productionDir,
    runPath,
    authorPath: resolve(productionDir, "authors/main.svml"),
    formatId: "ugc",
    checkOk: false,
    checkSummary: "gpt:Reference.image cannot resolve product-reference.image",
  });
  assert.equal(refreshed.checkOk, true);
});
