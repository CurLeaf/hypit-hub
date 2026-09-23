import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHypitAnalysisEnv } from "../src/workspace-env.js";

test("loadHypitAnalysisEnv reads only distribution root in source checkout", async () => {
  const distributionRoot = await mkdtemp(join(tmpdir(), "hypit-dist-"));
  const projectRoot = join(distributionRoot, "projects", "demo");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(distributionRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n", "utf8");
  await writeFile(join(distributionRoot, ".env"), "OPENAI_API_KEY=from-root\n", "utf8");
  await writeFile(join(projectRoot, ".env"), "OPENAI_API_KEY=from-project\n", "utf8");

  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await loadHypitAnalysisEnv(distributionRoot, projectRoot);
    assert.equal(process.env.OPENAI_API_KEY, "from-root");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("loadHypitAnalysisEnv falls back to project root outside checkout", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "hypit-project-"));
  await writeFile(join(projectRoot, ".env"), "OPENAI_API_KEY=from-project\n", "utf8");

  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await loadHypitAnalysisEnv(projectRoot, projectRoot);
    assert.equal(process.env.OPENAI_API_KEY, "from-project");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
