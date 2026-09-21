import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadWorkspaceEnv } from "@hypit/credential-store-env";

test("loadWorkspaceEnv fills missing keys from workspace .env", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hypit-workspace-env-"));
  await writeFile(join(workspace, ".env"), [
    "OPENAI_API_KEY=from-dotenv",
    "S3_REGION=cn-hangzhou",
  ].join("\n"), "utf8");
  const previousOpenAi = process.env.OPENAI_API_KEY;
  const previousRegion = process.env.S3_REGION;
  delete process.env.S3_REGION;
  process.env.OPENAI_API_KEY = "already-set";
  try {
    await loadWorkspaceEnv(workspace);
    assert.equal(process.env.OPENAI_API_KEY, "already-set");
    assert.equal(process.env.S3_REGION, "cn-hangzhou");
  } finally {
    if (previousOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAi;
    if (previousRegion === undefined) delete process.env.S3_REGION;
    else process.env.S3_REGION = previousRegion;
  }
});
