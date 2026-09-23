import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { resolveCompleteBuildVideo } from "../src/complete-build-videos.js";
import { isFailedGeneratedVideo } from "../src/shared.js";

const workspace = resolve(import.meta.dirname, "../../../examples/byok-openai-compatible");

test("resolveCompleteBuildVideo returns final for a completed build", async () => {
  const video = await resolveCompleteBuildVideo(workspace, "bld_20260922T030228909Z_24F1918599");
  assert.ok(video !== undefined);
  assert.equal(video.displayName, "final");
  assert.equal(video.buildStatus, "complete");
  assert.equal(isFailedGeneratedVideo(video), false);
});

test("resolveCompleteBuildVideo merges takes when final is missing", async () => {
  const video = await resolveCompleteBuildVideo(workspace, "bld_20260921T063743308Z_40250B416F");
  assert.ok(video !== undefined);
  assert.match(video.path, /merged[\\/]bld_20260921T063743308Z_40250B416F\.mp4$/u);
  assert.equal(video.displayName, "Build Z_40250B416F");
  assert.equal(video.buildStatus, "failed");
  assert.equal(isFailedGeneratedVideo(video), true);
  assert.ok(video.buildFailureSummary !== undefined && video.buildFailureSummary.length > 0);
  assert.ok(video.buildFailureDetail !== undefined && video.buildFailureDetail.length > 0);
});
