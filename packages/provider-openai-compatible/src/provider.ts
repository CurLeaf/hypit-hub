import { defineEndpointPackage } from "@hypit/endpoint-kit";
import type { CredentialRef, EndpointRequest } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";

import {
  capabilityKey,
  OpenAiCompatibleClient,
  type OpenAiCompatibleProviderOptions,
} from "./client.js";
import { mappingForCapability } from "./mappings.js";
import { createImageHandler, gptImage2Capability, gptImage2Returns, imageSupport } from "./image.js";
import { asyncVideoCapabilities, createVideoEndpoint, videoSupport } from "./video.js";

export const providerModule = { name: "@hypit/provider-openai-compatible", version: "1" } as const;

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions) {
  const client = new OpenAiCompatibleClient({
    baseUrl: options.baseUrl,
    ...(options.routes === undefined ? {} : { routes: options.routes }),
    ...(options.uploadMode === undefined ? {} : { uploadMode: options.uploadMode }),
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const pollIntervalMs = options.pollIntervalMs ?? 5_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 20 * 60_000;
  const videoAdapter = options.videoAdapter ?? "openai-videos";
  const modelFor = (request: EndpointRequest): string => {
    const mapped = options.models[capabilityKey(request.capability)];
    if (mapped === undefined) {
      throw new Error(`No gateway model mapping is configured for ${capabilityKey(request.capability)}`);
    }
    return mapped;
  };
  const imageHandler = createImageHandler(client, modelFor);
  const videoEndpoint = createVideoEndpoint(client, options.models, {
    videoAdapter,
    pollIntervalMs,
    operationTimeoutMs,
    modelFor,
  });
  const supportsWithModels = (request: EndpointRequest) => {
    if (options.models[capabilityKey(request.capability)] === undefined) {
      return { status: "unsupported" as const, reason: `No gateway model mapping is configured for ${capabilityKey(request.capability)}` };
    }
    if (request.capability.module.name === "@hypit/gpt-image" && request.capability.name === "gpt-image-2") {
      return imageSupport(request);
    }
    if (mappingForCapability(request.capability)?.result === "video") {
      return videoSupport(request, options.models);
    }
    return { status: "unsupported" as const, reason: `OpenAI-compatible endpoint does not implement ${capabilityKey(request.capability)}` };
  };
  return defineEndpointPackage({
    module: providerModule,
    facet: "gateway",
    instance: options.instance,
    pool: options.pool,
    credentials: { apiKey: options.apiKey },
    credentialInputs: { apiKey: { label: "OpenAI-compatible API key" } },
    defaultConcurrency: options.defaultConcurrency ?? 2,
    actionLimits: {
      submit: { concurrency: 2 },
      poll: { concurrency: 8 },
      collect: { concurrency: 2 },
    },
    pricing: { kind: "local" },
    capabilities: [
      {
        capability: gptImage2Capability,
        returns: gptImage2Returns,
        lifecycle: "immediate",
        handler: imageHandler,
        capacity: "image",
        supports: supportsWithModels,
      },
      ...asyncVideoCapabilities.map((item) => ({
        capability: item.capability,
        returns: item.returns,
        lifecycle: "asynchronous" as const,
        endpoint: videoEndpoint,
        capacity: "video",
        supports: supportsWithModels,
      })),
    ],
  });
}

export type { CredentialRef };
