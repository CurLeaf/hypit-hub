import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { syncInsightToReferenceArchive } from "../src/reference-archive.js";

test("syncInsightToReferenceArchive creates missing reference directories", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hypit-reference-archive-"));
  const referenceDir = join(workspace, "references", "demo-video");
  await syncInsightToReferenceArchive(referenceDir, "# Insight\n\nBody");
  const markdown = await readFile(join(referenceDir, "INSIGHT.md"), "utf8");
  assert.match(markdown, /# Insight/u);
  const progress = await readFile(join(referenceDir, "PROGRESS.md"), "utf8");
  assert.match(progress, /INSIGHT\.md 爆款解读/u);
});
