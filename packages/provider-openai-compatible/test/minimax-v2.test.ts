import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { canonicalize } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";
import { sealMinimaxH3Request } from "@hypit/minimax-h3";

import { buildMinimaxV2SubmitBody, normalizeMinimaxResolution } from "../src/minimax-v2.js";
import { createOpenAiCompatibleProvider } from "../src/provider.js";

test("normalizeMinimaxResolution maps common values", () => {
  assert.equal(normalizeMinimaxResolution("2k"), "2K");
  assert.equal(normalizeMinimaxResolution("768p"), "768P");
});

test("buildMinimaxV2SubmitBody maps reference image and audio", () => {
  const body = buildMinimaxV2SubmitBody("MiniMax-H3", {
    prompt: "Presenter explains the product",
    seconds: 8,
    resolution: "768P",
    aspect_ratio: "9:16",
    reference_image_urls: ["mm_file://img-1"],
    reference_audios: ["mm_file://audio-1"],
  });
  assert.equal(body.model, "MiniMax-H3");
  assert.equal(body.duration, 8);
  assert.equal(body.ratio, "9:16");
  assert.deepEqual(body.content, [
    { type: "text", text: "Presenter explains the product" },
    { type: "image_url", image_url: { url: "mm_file://img-1" }, role: "reference_image" },
    { type: "audio_url", audio_url: { url: "mm_file://audio-1" }, role: "reference_audio" },
  ]);
});

test("OpenAI-compatible provider uploads via MiniMax multipart and submits v2 video", async () => {
  const resources = new MemoryResourceStore();
  const imageResource = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const audioResource = await resources.put(new Uint8Array([4, 5, 6]), "audio/wav");
  const calls: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.minimax",
    pool: "gateway.minimax",
    baseUrl: "https://gateway.example",
    apiKey: { store: "env", key: "H3_VIDEO_API_KEY" },
    uploadMode: "minimax-multipart",
    videoAdapter: "minimax-v2",
    models: { "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3" },
    routes: {
      fileUpload: "/v1/files/upload",
      videoSubmit: "/v2/video_generation",
      videoStatus: "/v2/query/video_generation/{id}",
    },
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/v1/files/upload") {
        const index = calls.filter((path) => path === "/v1/files/upload").length;
        return Response.json({ file: { file_id: `file-${index}` } });
      }
      if (url.pathname === "/v2/video_generation") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "MiniMax-H3");
        assert.deepEqual(body.content, [
          { type: "text", text: "Presenter explains the product" },
          { type: "image_url", image_url: { url: "mm_file://file-1" }, role: "reference_image" },
          { type: "audio_url", audio_url: { url: "mm_file://file-2" }, role: "reference_audio" },
        ]);
        return Response.json({ task_id: "task-1" });
      }
      if (url.pathname === "/v2/query/video_generation/task-1") {
        return Response.json({
          task: {
            id: "task-1",
            status: "succeeded",
            content: { url: "https://assets.example/output.mp4" },
          },
        });
      }
      if (url.hostname === "assets.example") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });
  const need = {
    id: "need:minimax-ref",
    capability: { module: { name: "@hypit/minimax-h3", version: "1" }, name: "minimax-h3" },
    returns: generationTypes.videoSet,
    constraints: canonicalize(sealMinimaxH3Request({
      prompt: ["Presenter explains the product"],
      aspectRatio: ["9:16"],
      resolution: ["768P"],
      duration: [8],
      referenceImage: [{ role: "image", artifact: imageResource }],
      referenceAudio: [{ role: "audio", artifact: audioResource }],
    })),
    result: "record:minimax-ref",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need", id: "command:minimax-ref", need },
    operation: "operation:minimax-ref",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "pending");
  const polled = await endpoint.poll!({ ...context, handle: start.handle });
  assert.equal(polled.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: start.handle });
  assert.equal(collected.status, "completed");
  assert.deepEqual(calls, [
    "/v1/files/upload",
    "/v1/files/upload",
    "/v2/video_generation",
    "/v2/query/video_generation/task-1",
    "/v2/query/video_generation/task-1",
    "/output.mp4",
  ]);
});
