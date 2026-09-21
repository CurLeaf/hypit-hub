import { canonicalize, wakeAfter } from "@hypit/endpoint-kit";
import type {
  AsyncEndpoint,
  EndpointPollContext,
  EndpointRequest,
  EndpointStartContext,
} from "@hypit/endpoint-kit";
import { compileWireRequest, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";
import type { BlobRef } from "@hypit/protocol";

import type { OpenAiCompatibleClient, VideoAdapter } from "./client.js";
import { routePath } from "./client.js";
import { mappingForCapability } from "./mappings.js";
import {
  compileMinimaxV2Request,
  defaultMinimaxV2VideoRoutes,
  videoJobError,
  videoJobId,
  videoJobStatus,
  videoOutputUrl,
} from "./minimax-v2.js";
import type { ResolveArtifactUrl } from "./upload.js";

type VideoHandle = {
  readonly contract: "hypit.openai-compatible-video@1";
  readonly id: string;
  readonly adapter: VideoAdapter;
  readonly startedAt: number;
};

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function isReady(status: string): boolean {
  return status === "succeeded" || status === "completed" || status === "ready";
}

function isPending(status: string): boolean {
  return status === "queued" || status === "running" || status === "in_progress" || status === "processing";
}

function isFailed(status: string): boolean {
  return status === "failed" || status === "cancelled" || status === "queue_expired";
}

function isMinimaxH3(capability: EndpointRequest["capability"]): boolean {
  return capability.module.name === "@hypit/minimax-h3" && capability.name === "minimax-h3";
}

function adapterFor(capability: EndpointRequest["capability"], configured: VideoAdapter): VideoAdapter {
  return isMinimaxH3(capability) ? "minimax-v2" : configured;
}

function submitPath(client: OpenAiCompatibleClient, adapter: VideoAdapter): string {
  if (adapter === "minimax-v2") {
    return client.routes.videoSubmit.includes("video_generation")
      ? client.routes.videoSubmit
      : defaultMinimaxV2VideoRoutes.videoSubmit;
  }
  return client.routes.videoSubmit;
}

function statusPath(client: OpenAiCompatibleClient, adapter: VideoAdapter, id: string): string {
  if (adapter === "async-tasks") return `/tasks/${encodeURIComponent(id)}`;
  if (adapter === "minimax-v2") {
    const template = client.routes.videoStatus.includes("video_generation")
      ? client.routes.videoStatus
      : defaultMinimaxV2VideoRoutes.videoStatus;
    return routePath(template, { id });
  }
  return routePath(client.routes.videoStatus, { id });
}

export function videoSupport(request: EndpointRequest, models: Readonly<Record<string, string>>) {
  const mapping = mappingForCapability(request.capability);
  if (mapping === undefined) {
    return { status: "unsupported" as const, reason: "This OpenAI-compatible endpoint does not declare this video capability" };
  }
  const key = `${request.capability.module.name}@${request.capability.module.version}#${request.capability.name}`;
  if (models[key] === undefined) {
    return { status: "unsupported" as const, reason: `No gateway model mapping is configured for ${key}` };
  }
  const generation = request.constraints as unknown as GenerationRequest;
  const unsupportedPort = Object.keys(generation.ports).find((port) => !(port in mapping.fields));
  if (unsupportedPort !== undefined) {
    return { status: "unsupported" as const, reason: `OpenAI-compatible video does not support port ${unsupportedPort}` };
  }
  return { status: "supported" as const };
}

export function createVideoEndpoint(
  client: OpenAiCompatibleClient,
  models: Readonly<Record<string, string>>,
  options: {
    readonly videoAdapter: VideoAdapter;
    readonly pollIntervalMs: number;
    readonly operationTimeoutMs: number;
    readonly modelFor: (request: EndpointRequest) => string;
    readonly resolveArtifactUrl: ResolveArtifactUrl;
  },
): AsyncEndpoint {
  const resolveArtifact = async (
    artifact: BlobRef,
    resources: EndpointStartContext["resources"],
    secret: string,
  ): Promise<string> => await options.resolveArtifactUrl(artifact, resources, secret);

  return {
    async start(context: EndpointStartContext) {
      const supported = videoSupport(context.need, models);
      if (supported.status === "unsupported") throw new Error(supported.reason);
      const mapping = mappingForCapability(context.need.capability);
      if (mapping === undefined) throw new Error("Video mapping is unavailable");
      const secret = client.secret(context.credentials);
      const generation = context.need.constraints as unknown as GenerationRequest;
      const model = options.modelFor(context.need);
      const resolve = async (artifact: BlobRef) => await resolveArtifact(artifact, context.resources, secret);
      const adapter = adapterFor(context.need.capability, options.videoAdapter);
      const body = adapter === "minimax-v2"
        ? await compileMinimaxV2Request(generation, model, resolve)
        : {
          model,
          ...(await compileWireRequest(mapping, generation, resolve)).input as Record<string, unknown>,
        };
      const response = await client.json(submitPath(client, adapter), secret, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": context.operation },
        body: JSON.stringify(body),
      });
      const status = videoJobStatus(response);
      const id = videoJobId(response);
      const handle: VideoHandle = {
        contract: "hypit.openai-compatible-video@1",
        id,
        adapter,
        startedAt: Date.now(),
      };
      const receipt = { id };
      await context.checkpoint?.({ handle: canonicalize(handle), receipt, ...(isReady(status) ? { remoteEnded: true as const } : {}) });
      if (isFailed(status)) {
        const detail = videoJobError(response);
        throw new Error(`OpenAI-compatible video submission failed with status ${status}${detail === undefined ? "" : `: ${detail}`}`);
      }
      return isReady(status)
        ? { status: "ready", handle: canonicalize(handle), receipt }
        : { ...wakeAfter(canonicalize(handle), options.pollIntervalMs, Date.now(), { phase: status }), receipt };
    },
    async poll(context: EndpointPollContext) {
      const handle = object(context.handle, "video handle") as unknown as VideoHandle;
      if (handle.contract !== "hypit.openai-compatible-video@1") throw new Error("Video handle is invalid");
      if (Date.now() - handle.startedAt > options.operationTimeoutMs) {
        return {
          status: "failed",
          failure: { code: "OPENAI_COMPATIBLE_VIDEO_TIMEOUT", message: "OpenAI-compatible video operation timed out" },
        };
      }
      const secret = client.secret(context.credentials);
      const response = await client.json(statusPath(client, handle.adapter, handle.id), secret);
      const status = videoJobStatus(response);
      if (isPending(status)) return wakeAfter(canonicalize(handle), options.pollIntervalMs, Date.now(), { phase: status });
      if (isFailed(status)) {
        const detail = videoJobError(response);
        throw new Error(`OpenAI-compatible video failed${detail === undefined ? "" : `: ${detail}`}`);
      }
      if (!isReady(status)) throw new Error(`OpenAI-compatible video returned unknown status ${status}`);
      return { status: "ready", handle: context.handle, receipt: { id: handle.id } };
    },
    async collect(context) {
      const handle = object(context.handle, "video handle") as unknown as VideoHandle;
      const secret = client.secret(context.credentials);
      const response = await client.json(statusPath(client, handle.adapter, handle.id), secret);
      const url = videoOutputUrl(response);
      if (typeof url !== "string") throw new Error("OpenAI-compatible video result did not include a download URL");
      const downloaded = await client.download(url);
      if (!downloaded.mediaType.startsWith("video/")) throw new Error("OpenAI-compatible video result was not video media");
      const artifact = await context.resources.put(downloaded.bytes, downloaded.mediaType);
      return {
        status: "completed",
        result: {
          value: {
            kind: "inline",
            value: canonicalize(sealGeneratedVideoSet({ videos: [artifact] })),
          },
        },
      };
    },
  };
}
