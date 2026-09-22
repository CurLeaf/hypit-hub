import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEndpointAdapterImplementation } from "@hypit/runtime-kit";

import hypitPackage from "../src/activation.js";

const activate = (hypitPackage.hostFacets[0]!.implementation as RuntimeEndpointAdapterImplementation).activate;

test("OpenAI-compatible activation accepts analysis gateway metadata keys", () => {
  const endpoint = activate({
    instance: "gateway.default",
    pool: "gateway.default",
    config: {
      baseUrl: "https://gateway.example/v1",
      apiKey: { store: "env", key: "OPENAI_API_KEY" },
      chatModel: "deepseek-v4-flash",
      ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
      ttsVoice: "FunAudioLLM/CosyVoice2-0.5B:alex",
      models: {
        "@hypit/gpt-image@1#gpt-image-2": "gpt-image-2",
      },
      routes: {
        image: "/images/generations",
        imageEdits: "/images/edits",
        speech: "/audio/speech",
        fileUpload: "/files",
        videoSubmit: "/videos",
        videoStatus: "/videos/{id}",
      },
    },
  }).endpoint;
  assert.equal(endpoint.instance.id, "gateway.default");
});

test("OpenAI-compatible activation accepts minimax v2 adapter settings", () => {
  const endpoint = activate({
    instance: "gateway.minimax",
    pool: "gateway.minimax",
    config: {
      baseUrl: "https://metaso.cn/api/minimax",
      apiKey: { store: "env", key: "H3_VIDEO_API_KEY" },
      uploadMode: "minimax-multipart",
      referenceUpload: "s3",
      videoAdapter: "minimax-v2",
      models: {
        "@hypit/minimax-h3@1#minimax-h3": "MiniMax-H3",
      },
      routes: {
        fileUpload: "/v1/files/upload",
        videoSubmit: "/v2/video_generation",
        videoStatus: "/v2/query/video_generation/{id}",
      },
    },
  }).endpoint;
  assert.equal(endpoint.instance.id, "gateway.minimax");
});
