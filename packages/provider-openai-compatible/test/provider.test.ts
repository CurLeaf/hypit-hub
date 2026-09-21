import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { sealGptImage2Request } from "@hypit/gpt-image";
import { canonicalize } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";
import type { ResourceId } from "@hypit/protocol";

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
  const images = (result.value.value as unknown as { images: readonly { resource: ResourceId; mediaType: string }[] }).images;
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
      if (url.pathname === "/v1/files") {
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
  assert.equal(resolution.registration.kind, "immediate");
  const result = await resolution.registration.handler({
    need,
    command: { kind: "fulfill-need", id: "command:reference-image", need },
    resources,
    credentials: { apiKey: { secret: "test-key" } },
  });
  assert.equal(result.value.kind, "inline");
  assert.deepEqual(calls, ["/v1/files", "/v1/images/edits"]);
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
      if (url.pathname === "/v1/files") {
        const index = calls.filter((path) => path === "/v1/files").length;
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
      if (url.pathname === "/v1/videos/video-ref") {
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
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need" as const, id: "command:seedance-ref", need },
    operation: "operation:seedance-ref",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: start.handle });
  assert.equal(collected.status, "completed");
  assert.deepEqual(calls, ["/v1/files", "/v1/files", "/v1/videos", "/v1/videos/video-ref", "/output.mp4"]);
});

test("OpenAI-compatible provider publishes reference media to S3/CDN instead of gateway /files", async () => {
  const resources = new MemoryResourceStore();
  const imageResource = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const audioResource = await resources.put(new Uint8Array([4, 5, 6]), "audio/wav");
  const hosts: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.minimax",
    pool: "gateway.minimax",
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "env", key: "H3_VIDEO_API_KEY" },
    models: { "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini" },
    pollIntervalMs: 0,
    referenceUpload: {
      endpoint: "https://oss.example/bucket",
      accessKeyId: "id",
      accessKeySecret: "secret",
      bucketName: "bucket",
      region: "cn-hangzhou",
      cdnUrl: "https://cdn.example",
      keyPrefix: "hypit/test",
    },
    fetch: async (input, init) => {
      const url = new URL(String(input));
      hosts.push(url.hostname + url.pathname);
      if (url.hostname === "oss.example") {
        assert.equal(init?.method, "POST");
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/v1/videos") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.match(String((body.reference_image_urls as string[])[0]), /^https:\/\/cdn\.example\/hypit\/test\/.+\.png$/u);
        assert.match(String((body.reference_audios as string[])[0]), /^https:\/\/cdn\.example\/hypit\/test\/.+\.wav$/u);
        return Response.json({ id: "video-s3", status: "completed", output_url: "https://assets.example/output.mp4" });
      }
      if (url.pathname === "/v1/videos/video-s3") {
        return Response.json({ id: "video-s3", status: "completed", output_url: "https://assets.example/output.mp4" });
      }
      if (url.hostname === "assets.example") {
        return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`Unexpected path ${url.href}`);
    },
  });
  const need = {
    id: "need:s3-ref",
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
    result: "record:s3-ref",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need" as const, id: "command:s3-ref", need },
    operation: "operation:s3-ref",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "ready");
  await endpoint.collect!({ ...context, handle: start.handle });
  assert.ok(!hosts.some((host) => host.includes("/files")));
  assert.deepEqual(hosts.slice(0, 3), ["oss.example/bucket", "oss.example/bucket", "gateway.example/v1/videos"]);
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
    command: { kind: "fulfill-need" as const, id: "command:video", need },
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
  const completed = collected.result!;
  assert.equal(completed.value.kind, "inline");
  const videos = (completed.value.value as unknown as { videos: { mediaType: string }[] }).videos;
  assert.equal(videos[0]?.mediaType, "video/mp4");
});

test("OpenAI-compatible provider submits MiniMax H3 through V2 video_generation", async () => {
  const resources = new MemoryResourceStore();
  const imageResource = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const audioResource = await resources.put(new Uint8Array([4, 5, 6]), "audio/wav");
  const calls: string[] = [];
  const provider = createOpenAiCompatibleProvider({
    instance: "gateway.minimax",
    pool: "gateway.minimax",
    baseUrl: "https://metaso.example/api/minimax",
    apiKey: { store: "env", key: "H3_VIDEO_API_KEY" },
    models: { "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3" },
    videoAdapter: "openai-videos",
    pollIntervalMs: 0,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/minimax/files") {
        const index = calls.filter((path) => path.endsWith("/files")).length;
        return Response.json({ url: `https://gateway.example/files/ref-${index}` });
      }
      if (url.pathname === "/api/minimax/videos" || url.pathname.startsWith("/api/minimax/videos/")) {
        throw new Error("MiniMax H3 must not use the OpenAI /videos path");
      }
      if (url.pathname === "/api/minimax/v2/video_generation") {
        assert.equal(init?.method, "POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, "MiniMax-H3");
        assert.equal(body.duration, 6);
        assert.equal(body.resolution, "768P");
        assert.equal(body.ratio, "9:16");
        assert.deepEqual(body.content, [
          { type: "text", text: "Presenter explains the product" },
          { type: "image_url", role: "reference_image", image_url: { url: "https://gateway.example/files/ref-1" } },
          { type: "audio_url", role: "reference_audio", audio_url: { url: "https://gateway.example/files/ref-2" } },
        ]);
        return Response.json({ task_id: "424010985738629" });
      }
      if (url.pathname === "/api/minimax/v2/query/video_generation/424010985738629") {
        return Response.json({
          task: {
            id: "424010985738629",
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
    id: "need:h3-ref",
    capability: { module: { name: "@hypit/minimax-h3", version: "1" }, name: "minimax-h3" },
    returns: generationTypes.videoSet,
    constraints: canonicalize({
      ports: {
        prompt: ["Presenter explains the product"],
        duration: [6],
        resolution: ["768P"],
        aspectRatio: ["9:16"],
        referenceImage: [{ role: "image", artifact: imageResource }],
        referenceAudio: [{ role: "audio", artifact: audioResource }],
      },
    }),
    result: "record:h3-ref",
  } as const;
  const registry = new EndpointRegistry();
  await provider.install(registry);
  const resolution = registry.resolve(need);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "asynchronous");
  const endpoint = resolution.registration.endpoint;
  const context = {
    need,
    command: { kind: "fulfill-need" as const, id: "command:h3-ref", need },
    operation: "operation:h3-ref",
    resources,
    credentials: { apiKey: { secret: "test-key" } },
    checkpoint: async () => {},
  };
  const start = await endpoint.start(context);
  assert.equal(start.status, "pending");
  const done = await endpoint.poll({ ...context, handle: start.handle });
  assert.equal(done.status, "ready");
  const collected = await endpoint.collect!({ ...context, handle: done.handle });
  assert.equal(collected.status, "completed");
  assert.deepEqual(calls, [
    "POST /api/minimax/files",
    "POST /api/minimax/files",
    "POST /api/minimax/v2/video_generation",
    "GET /api/minimax/v2/query/video_generation/424010985738629",
    "GET /api/minimax/v2/query/video_generation/424010985738629",
    "GET /output.mp4",
  ]);
});

const gateway = {
  instance: "gateway.default",
  pool: "gateway.default",
  baseUrl: "https://gateway.example/v1",
  apiKey: { store: "env", key: "OPENAI_API_KEY" },
} as const;

test("OpenAI-compatible provider declares only the capabilities its model map names", () => {
  const provider = createOpenAiCompatibleProvider({
    ...gateway,
    models: { "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3" },
  });
  assert.deepEqual(provider.offers.map((offer) => offer.capability.name), ["minimax-h3"]);
});

test("OpenAI-compatible provider offers every mapped video model beside the image capability", () => {
  const provider = createOpenAiCompatibleProvider({
    ...gateway,
    models: {
      "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
      "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3",
      "@hypit/seedance@1#seedance-2-mini": "seedance-2-mini",
    },
  });
  assert.deepEqual(provider.offers.map((offer) => offer.capability.name), [
    "gpt-image-2",
    "minimax-h3",
    "seedance-2-mini",
  ]);
});

test("OpenAI-compatible provider rejects a model mapping it does not implement", () => {
  assert.throws(
    () => createOpenAiCompatibleProvider({ ...gateway, models: { "@hypit/example@1#thing": "thing" } }),
    /models declares @hypit\/example@1#thing, which this Provider does not implement/u,
  );
});
