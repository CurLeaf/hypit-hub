import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealGptImage2Request } from "@hypit/gpt-image";
import { canonicalize } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";

import { sealSeedanceRequest } from "@hypit/seedance";

import { gptImage2Capability } from "../src/image.js";
import { createOpenAiCompatibleProvider } from "../src/provider.js";

const capabilityRef = gptImage2Capability;

test("OpenAI-compatible provider generates an image through /images/generations", async () => {
  const resources = new MemoryResourceStore();
  const calls: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.default",
    pool: "gateway.default",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    models: {
      "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer test-key");
      if (url.pathname === "/v1/images/generations") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "gpt-image-2",
          prompt: "A mountain landscape",
          size: "1024x1792",
          n: 1,
        });
        return Response.json({ data: [{ b64_json: Buffer.from([9, 8, 7]).toString("base64") }] });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });
  const constraints = canonicalize(sealGptImage2Request({
    prompt: ["A mountain landscape"],
    aspectRatio: ["9:16"],
    resolution: ["1K"],
  }));
  const need = {
    id: "need:example",
    capability: capabilityRef,
    returns: generationTypes.imageSet,
    constraints,
    result: "record:example",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const result = await resolution.registration.handler({
    need,
    command: { kind: "fulfill-need", id: "command:example", need },
    resources,
    credentials: { apiKey: { secret: "test-key" } },
  });
  assert.equal(result.value.kind, "inline");
  const images = (result.value.value as unknown as { images: { resource: string; mediaType: string }[] }).images;
  assert.equal(images[0]?.mediaType, "image/png");
  assert.deepEqual(await resources.get(images[0]!.resource), new Uint8Array([9, 8, 7]));
  assert.deepEqual(calls, ["/v1/images/generations"]);
});

test("OpenAI-compatible provider generates an image with references through /images/edits", async () => {
  const resources = new MemoryResourceStore();
  const imageResource = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const calls: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.default",
    pool: "gateway.default",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    models: {
      "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/files") {
        return Response.json({ url: "https://gateway.example/files/ref-1" });
      }
      if (url.pathname === "/v1/images/edits") {
        assert.deepEqual(JSON.parse(String(init?.body)), {
          model: "gpt-image-2",
          prompt: "Show the product in a vertical promo frame",
          aspect_ratio: "9:16",
          resolution: "1K",
          reference_images: [{ url: "https://gateway.example/files/ref-1" }],
          size: "1024x1792",
          n: 1,
        });
        return Response.json({ data: [{ b64_json: Buffer.from([5, 6, 7]).toString("base64") }] });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });
  const constraints = canonicalize(sealGptImage2Request({
    prompt: ["Show the product in a vertical promo frame"],
    aspectRatio: ["9:16"],
    resolution: ["1K"],
    images: [{ role: "image", artifact: imageResource }],
  }));
  const need = {
    id: "need:reference-image",
    capability: capabilityRef,
    returns: generationTypes.imageSet,
    constraints,
    result: "record:reference-image",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  const result = await resolution.registration.handler({
    need,
    command: { kind: "fulfill-need", id: "command:reference-image", need },
    resources,
    credentials: { apiKey: { secret: "test-key" } },
  });
  assert.equal(result.value.kind, "inline");
  assert.deepEqual(calls, ["/files", "/v1/images/edits"]);
});

test("OpenAI-compatible provider rejects unsupported aspect ratios", async () => {
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.default",
    pool: "gateway.default",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    models: { "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2" },
  });
  const need = {
    id: "need:example",
    capability: capabilityRef,
    returns: generationTypes.imageSet,
    constraints: canonicalize(sealGptImage2Request({
      prompt: ["A portrait"],
      aspectRatio: ["9:21"],
      resolution: ["1K"],
    })),
    result: "record:example",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const offer = provider.offers.find((item) => item.capability.name === "gpt-image-2");
  assert.equal(offer?.supports?.(need).status, "unsupported");
});

test("OpenAI-compatible provider submits Seedance ReferenceVideo with uploaded image and audio", async () => {
  const resources = new MemoryResourceStore();
  const imageResource = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const audioResource = await resources.put(new Uint8Array([4, 5, 6]), "audio/wav");
  const calls: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.default",
    pool: "gateway.default",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    models: { "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini" },
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/files") {
        const index = calls.filter((path) => path === "/files").length;
        return Response.json({ url: `https://gateway.example/files/ref-${index}` });
      }
      if (url.pathname === "/v1/videos") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "seedance-2-mini");
        assert.equal(body.prompt, "Presenter explains the product");
        assert.deepEqual(body.reference_image_urls, ["https://gateway.example/files/ref-1"]);
        assert.deepEqual(body.reference_audios, ["https://gateway.example/files/ref-2"]);
        return Response.json({ id: "video-ref", status: "completed", output_url: "https://assets.example/output.mp4" });
      }
      if (url.hostname === "assets.example") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });
  const need = {
    id: "need:seedance-ref",
    capability: { module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2-mini" },
    returns: generationTypes.videoSet,
    constraints: canonicalize(sealSeedanceRequest("seedance-2-mini", {
      prompt: ["Presenter explains the product"],
      aspectRatio: ["9:16"],
      resolution: ["720p"],
      duration: [6],
      generateAudio: [true],
      webSearch: [false],
      referenceImage: [{ role: "image", artifact: imageResource }],
      referenceAudio: [{ role: "audio", artifact: audioResource }],
    })),
    result: "record:seedance-ref",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need", id: "command:seedance-ref", need },
    operation: "operation:seedance-ref",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: start.handle });
  assert.equal(collected.status, "completed");
  assert.deepEqual(calls, ["/files", "/files", "/v1/videos"]);
});

test("OpenAI-compatible provider polls async video jobs", async () => {
  const resources = new MemoryResourceStore();
  let pollCount = 0;
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.default",
    pool: "gateway.default",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    models: { "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini" },
    pollIntervalMs: 0,
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/videos") {
        return Response.json({ id: "video-1", status: "queued" });
      }
      if (url.pathname === "/v1/videos/video-1") {
        pollCount += 1;
        return Response.json(pollCount === 1
          ? { id: "video-1", status: "running" }
          : { id: "video-1", status: "completed", output_url: "https://assets.example/output.mp4" });
      }
      if (url.hostname === "assets.example") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    },
  });
  const need = {
    id: "need:video",
    capability: { module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2-mini" },
    returns: generationTypes.videoSet,
    constraints: canonicalize(sealSeedanceRequest("seedance-2-mini", {
      prompt: ["A dancer in the rain"],
      aspectRatio: ["9:16"],
      resolution: ["720p"],
      duration: [6],
      generateAudio: [false],
      webSearch: [false],
    })),
    result: "record:video",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need", id: "command:video", need },
    operation: "operation:video",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "pending");
  const ready = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(ready.status, "pending");
  const done = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(done.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: done.handle });
  assert.equal(collected.status, "completed");
  const videos = (collected.result!.value.value as unknown as { videos: { mediaType: string }[] }).videos;
  assert.equal(videos[0]?.mediaType, "video/mp4");
});
