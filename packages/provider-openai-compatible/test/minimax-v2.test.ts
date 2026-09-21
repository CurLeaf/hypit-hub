import assert from "node:assert/strict";
import test from "node:test";

import { defaultOpenAiCompatibleRoutes } from "../src/client.js";
import {
  applyVideoAdapterRoutes,
  compileMinimaxV2Request,
  minimaxV2Resolution,
  videoJobError,
  videoJobId,
  videoJobStatus,
  videoOutputUrl,
} from "../src/minimax-v2.js";
import { resolveRuntimeText } from "../src/runtime-text.js";

test("MiniMax V2 compiles talking-head references into content[]", async () => {
  const body = await compileMinimaxV2Request(
    {
      ports: {
        prompt: ["Presenter explains the dryer"],
        duration: [6],
        resolution: ["768P"],
        aspectRatio: ["9:16"],
        referenceImage: [{ role: "image", artifact: { kind: "blob", resource: "res:image", size: 3, mediaType: "image/png" } }],
        referenceAudio: [{ role: "audio", artifact: { kind: "blob", resource: "res:audio", size: 3, mediaType: "audio/wav" } }],
      },
    },
    "MiniMax-H3",
    async (artifact) => `https://cdn.example/${artifact.resource}`,
  );
  assert.deepEqual(body, {
    model: "MiniMax-H3",
    content: [
      { type: "text", text: "Presenter explains the dryer" },
      { type: "image_url", role: "reference_image", image_url: { url: "https://cdn.example/res:image" } },
      { type: "audio_url", role: "reference_audio", audio_url: { url: "https://cdn.example/res:audio" } },
    ],
    duration: 6,
    resolution: "768P",
    ratio: "9:16",
  });
});

test("MiniMax V2 first/last-frame requests use adaptive ratio", async () => {
  const body = await compileMinimaxV2Request(
    {
      ports: {
        prompt: ["Camera push in"],
        duration: [5],
        firstFrame: [{ role: "image", artifact: { kind: "blob", resource: "res:first", size: 1, mediaType: "image/png" } }],
        lastFrame: [{ role: "image", artifact: { kind: "blob", resource: "res:last", size: 1, mediaType: "image/png" } }],
      },
    },
    "MiniMax-H3",
    async (artifact) => `https://cdn.example/${artifact.resource}`,
  );
  assert.equal(body.ratio, "adaptive");
  assert.equal(body.resolution, "768P");
  assert.deepEqual(body.content.map((item) => "role" in item ? item.role : item.type), [
    "text",
    "first_frame",
    "last_frame",
  ]);
});

test("MiniMax V2 resolution keeps H3 tiers", () => {
  assert.equal(minimaxV2Resolution(undefined), "768P");
  assert.equal(minimaxV2Resolution("2k"), "2K");
  assert.equal(minimaxV2Resolution("768P"), "768P");
});

test("MiniMax V2 adapter replaces leftover OpenAI video routes", () => {
  const routes = applyVideoAdapterRoutes("minimax-v2", defaultOpenAiCompatibleRoutes);
  assert.equal(routes.videoSubmit, "/v2/video_generation");
  assert.equal(routes.videoStatus, "/v2/query/video_generation/{id}");
});

test("MiniMax V2 query response unwraps nested task content.url", () => {
  const response = {
    task: {
      id: "424010985738629",
      status: "succeeded",
      content: { url: "https://cdn.example/output.mp4" },
      error: { message: "ignored when succeeded" },
    },
  };
  assert.equal(videoJobId(response), "424010985738629");
  assert.equal(videoJobStatus(response), "succeeded");
  assert.equal(videoOutputUrl(response), "https://cdn.example/output.mp4");
});

test("MiniMax V2 create response treats a bare task_id as queued", () => {
  assert.equal(videoJobId({ task_id: "task-1" }), "task-1");
  assert.equal(videoJobStatus({ task_id: "task-1" }), "queued");
  assert.equal(videoJobError({ task: { status: "failed", error: { message: "bad prompt" } } }), "bad prompt");
});

test("OpenAI-compatible baseUrl can be an env reference", () => {
  const env = { H3_VIDEO_BASE_URL: "https://metaso.cn/api/minimax" };
  assert.equal(
    resolveRuntimeText({ store: "env", key: "H3_VIDEO_BASE_URL" }, "baseUrl", env),
    "https://metaso.cn/api/minimax",
  );
  assert.equal(resolveRuntimeText("$H3_VIDEO_BASE_URL", "baseUrl", env), "https://metaso.cn/api/minimax");
  assert.equal(
    resolveRuntimeText("https://gateway.example/v1", "baseUrl", env),
    "https://gateway.example/v1",
  );
  assert.throws(
    () => resolveRuntimeText({ store: "env", key: "H3_VIDEO_BASE_URL" }, "baseUrl", {}),
    /H3_VIDEO_BASE_URL is missing/u,
  );
});
