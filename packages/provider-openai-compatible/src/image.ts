import { Buffer } from "node:buffer";

import { canonicalize } from "@hypit/endpoint-kit";
import type { EndpointFulfillment, EndpointInvocationContext, EndpointRequest, ImmediateEndpointHandler } from "@hypit/endpoint-kit";
import { compileWireRequest, generationTypes, sealGeneratedImageSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";

import type { OpenAiCompatibleClient } from "./client.js";
import { gptImage2Mapping } from "./mappings.js";
import { uploadArtifactUrl } from "./upload.js";

const supportedRatios = new Set(["1:1", "9:16", "16:9", "3:2", "2:3"]);

function scalar(request: GenerationRequest, port: string): string | undefined {
  const value = request.ports[port]?.[0];
  return typeof value === "string" ? value : undefined;
}

function openAiImageSize(aspectRatio: string, resolution: string): string {
  const sizes: Record<string, Record<string, string>> = {
    "1K": { "1:1": "1024x1024", "9:16": "1024x1792", "16:9": "1792x1024", "3:2": "1536x1024", "2:3": "1024x1536" },
    "2K": { "1:1": "1024x1024", "9:16": "1024x1792", "16:9": "1792x1024" },
  };
  const mapped = sizes[resolution]?.[aspectRatio];
  if (mapped === undefined) throw new Error(`OpenAI-compatible image does not support ${aspectRatio} at ${resolution}`);
  return mapped;
}

export function imageSupport(request: EndpointRequest) {
  const generation = request.constraints as unknown as GenerationRequest;
  const ports = generation.ports;
  const imageCount = ports.images?.length ?? 0;
  if (imageCount > 16) {
    return { status: "unsupported" as const, reason: "OpenAI-compatible image generation accepts at most 16 reference images" };
  }
  const ratio = scalar(generation, "aspectRatio") ?? "1:1";
  const resolution = scalar(generation, "resolution") ?? "1K";
  if (!supportedRatios.has(ratio)) {
    return { status: "unsupported" as const, reason: `OpenAI-compatible image does not support aspect ratio ${ratio}` };
  }
  try {
    openAiImageSize(ratio, resolution);
  } catch (error) {
    return { status: "unsupported" as const, reason: error instanceof Error ? error.message : String(error) };
  }
  return { status: "supported" as const };
}

export function createImageHandler(
  client: OpenAiCompatibleClient,
  modelFor: (request: EndpointRequest) => string,
): ImmediateEndpointHandler {
  return async (context: EndpointInvocationContext) => {
    const supported = imageSupport(context.need);
    if (supported.status === "unsupported") throw new Error(supported.reason);
    const secret = client.secret(context.credentials);
    const request = context.need.constraints as unknown as GenerationRequest;
    const ratio = scalar(request, "aspectRatio") ?? "1:1";
    const resolution = scalar(request, "resolution") ?? "1K";
    const size = openAiImageSize(ratio, resolution);
    const hasReferences = (request.ports.images?.length ?? 0) > 0;

    if (!hasReferences) {
      const wire = await compileWireRequest(gptImage2Mapping, request, async () => {
        throw new Error("Reference image upload is not configured");
      });
      const input = wire.input as Record<string, unknown>;
      const body = {
        model: modelFor(context.need),
        prompt: String(input.prompt ?? request.ports.prompt?.[0] ?? ""),
        size,
        n: 1,
      };
      const response = await client.json(client.routes.image, secret, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return await packageImageResponse(client, response, context);
    }

    const wire = await compileWireRequest(gptImage2Mapping, request, async (artifact) =>
      await uploadArtifactUrl(client, secret, artifact, context.resources));
    const body = {
      model: modelFor(context.need),
      ...(wire.input as Record<string, unknown>),
      size,
      n: 1,
    };
    const response = await client.json(client.routes.imageEdits, secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await packageImageResponse(client, response, context);
  };
}

async function packageImageResponse(
  client: OpenAiCompatibleClient,
  response: Record<string, unknown>,
  context: EndpointInvocationContext,
): Promise<EndpointFulfillment> {
  const data = response.data;
  if (!Array.isArray(data) || data.length === 0) throw new Error("OpenAI-compatible image response contained no data");
  const [first] = data;
  if (first === null || typeof first !== "object") throw new Error("OpenAI-compatible image response item is invalid");
  const item = first as Record<string, unknown>;
  let bytes: Uint8Array;
  let mediaType = "image/png";
  if (typeof item.b64_json === "string") {
    bytes = new Uint8Array(Buffer.from(item.b64_json, "base64"));
  } else if (typeof item.url === "string") {
    const downloaded = await client.download(item.url);
    bytes = downloaded.bytes;
    mediaType = downloaded.mediaType;
  } else {
    throw new Error("OpenAI-compatible image response did not include b64_json or url");
  }
  const artifact = await context.resources.put(bytes, mediaType.startsWith("image/") ? mediaType : "image/png");
  return {
    value: {
      kind: "inline",
      value: canonicalize(sealGeneratedImageSet({ images: [artifact] })),
    },
  };
}

export const gptImage2Capability = gptImage2Mapping.capability;
export const gptImage2Returns = generationTypes.imageSet;
