import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildMinimaxRequestPreview,
  resolveVideoGenerationTakes,
  takeIdFromVideoName,
} from "../src/build-video-generation.js";

const distributionRoot = resolve(import.meta.dirname, "../../..");
const workspace = resolve(distributionRoot, "examples/byok-openai-compatible");
const buildId = "bld_20260921T101923719Z_970A846811";

test("takeIdFromVideoName maps take video outputs to shot ids", () => {
  assert.equal(takeIdFromVideoName("shot_1-take.video"), "shot_1");
  assert.equal(takeIdFromVideoName("shot_2-take"), "shot_2");
  assert.equal(takeIdFromVideoName("merged.video"), undefined);
});

test("resolveVideoGenerationTakes reads rendered prompts from build results", async () => {
  const takes = await resolveVideoGenerationTakes(workspace, buildId, {
    name: "merged.video",
    path: joinMerged(workspace, buildId),
    mediaType: "video/mp4",
    buildId,
  });
  assert.equal(takes.length, 2);
  assert.match(takes[0]!.prompt, /MiniMax H3 reference-to-video/u);
  assert.match(takes[0]!.promptSummary, /用了三个月/u);
  assert.equal(takes[0]!.durationSeconds, 15);
  assert.ok(takes[0]!.requestPreview?.includes("POST /v2/video_generation"));
  assert.equal(takes[1]!.durationSeconds, 6);
});

test("buildMinimaxRequestPreview includes prompt text and media placeholders", () => {
  const body = buildMinimaxRequestPreview("Prompt text", {
    duration: 15,
    resolution: "768P",
    aspectRatio: "9:16",
    referenceImages: ["product-reference"],
    referenceAudio: "presenter-voice",
  });
  assert.match(body, /Prompt text/u);
  assert.match(body, /<product-reference>/u);
  assert.match(body, /<presenter-voice>/u);
  assert.match(body, /重建的请求预览/u);
});

function joinMerged(workspaceRoot: string, id: string): string {
  return resolve(workspaceRoot, ".hypit", "analysis", "merged", `${id}.mp4`);
}
