import { defineEndpointPackage } from "@hypit/endpoint-kit";
import type { CredentialRef, EndpointRequest } from "@hypit/endpoint-kit";
import { generationTypes } from "@hypit/generation";

import {
  capabilityKey,
  OpenAiCompatibleClient,
  type OpenAiCompatibleProviderOptions,
} from "./client.js";
import { mappingForCapability, openAiCompatibleMappings } from "./mappings.js";
import { createImageHandler, gptImage2Returns, imageSupport } from "./image.js";
import { createVideoEndpoint, videoSupport } from "./video.js";

export const providerModule = { name: "@hypit/provider-openai-compatible", version: "1" } as const;

/**
 * A gateway serves the capabilities its Profile `models` map names, and nothing else. Declaring this
 * Provider's whole catalog instead would make every configured gateway look like it serves every
 * model in it, so two gateways in one Profile would contest capabilities neither of them mapped.
 * One mapping per capability also gives the author the switch for comparing video models: map
 * another capability (for example `seedance-2-mini` beside `minimax-h3`) and the Endpoint offers it.
 */
function declaredMappings(models: Readonly<Record<string, string>>) {
  return Object.keys(models).map((key) => {
    const mapping = openAiCompatibleMappings.find((item) => capabilityKey(item.capability) === key);
    if (mapping === undefined) {
      throw new Error(`OpenAI-compatible models declares ${key}, which this Provider does not implement`);
    }
    return mapping;
  });
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleProviderOptions) {
  const declared = declaredMappings(options.models);
  const client = new OpenAiCompatibleClient({
    baseUrl: options.baseUrl,
    ...(options.routes === undefined ? {} : { routes: options.routes }),
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
    const mapping = mappingForCapability(request.capability);
    if (mapping?.result === "image") return imageSupport(request);
    if (mapping?.result === "video") return videoSupport(request, options.models);
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
    capabilities: declared.map((mapping) => mapping.result === "image"
      ? {
        capability: mapping.capability,
        returns: gptImage2Returns,
        lifecycle: "immediate" as const,
        handler: imageHandler,
        capacity: "image",
        supports: supportsWithModels,
      }
      : {
        capability: mapping.capability,
        returns: generationTypes.videoSet,
        lifecycle: "asynchronous" as const,
        endpoint: videoEndpoint,
        capacity: "video",
        supports: supportsWithModels,
      }),
  });
}

export type { CredentialRef };
