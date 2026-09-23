import assert from "node:assert/strict";
import test from "node:test";

import { summarizeBuildFailure } from "../src/build-failure.js";
import { readBuildRecord } from "../src/build-videos.js";

import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../../examples/byok-openai-compatible");

test("summarizeBuildFailure explains undecodable H3 video", () => {
  const summary = summarizeBuildFailure(
    "Endpoint hyperframes.local failed render-visual: Video source could not be decoded",
  );
  assert.match(summary, /视频素材/u);
});

test("readBuildRecord returns failure detail for failed builds", async () => {
  const record = await readBuildRecord(workspace, "bld_20260922T061301722Z_DBE9DE6051");
  assert.equal(record.status, "failed");
  assert.ok(record.failureDetail !== undefined && record.failureDetail.length > 0);
});

test("readBuildRecord explains partial builds without final", async () => {
  const record = await readBuildRecord(workspace, "bld_20260921T101923719Z_970A846811");
  assert.equal(record.status, "partial");
  assert.match(record.failureDetail ?? "", /未完成/u);
});
