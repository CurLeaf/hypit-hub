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

import type { OpenAiCompatibleClient } from "./client.js";
import { mappingForCapability } from "./mappings.js";
import type { ResolveArtifactUrl } from "./upload.js";

type VideoHandle = {
  readonly contract: "hypit.openai-compatible-video@1";
  readonly id: string;
  readonly adapter: "openai-videos" | "async-tasks";
  readonly startedAt: number;
};

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, subject: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${subject} must be non-empty text`);
  return value;
}

function jobId(response: Record<string, unknown>): string {
  return text(response.id ?? response.job_id ?? response.task_id, "remote video job id");
}

function jobStatus(response: Record<string, unknown>): string {
  return String(response.status ?? response.state ?? "unknown");
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
    readonly videoAdapter: "openai-videos" | "async-tasks";
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
      const compiled = await compileWireRequest(
        mapping,
        context.need.constraints as unknown as GenerationRequest,
        async (artifact) => await resolveArtifact(artifact, context.resources, secret),
      );
      const body = {
        model: options.modelFor(context.need),
        ...(compiled.input as Record<string, unknown>),
      };
      const response = await client.json(client.routes.videoSubmit, secret, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": context.operation },
        body: JSON.stringify(body),
      });
      const status = jobStatus(response);
      const id = jobId(response);
      const handle: VideoHandle = {
        contract: "hypit.openai-compatible-video@1",
        id,
        adapter: options.videoAdapter,
        startedAt: Date.now(),
      };
      const receipt = { id };
      await context.checkpoint?.({ handle: canonicalize(handle), receipt, ...(isReady(status) ? { remoteEnded: true as const } : {}) });
      if (isFailed(status)) throw new Error(`OpenAI-compatible video submission failed with status ${status}`);
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
      const path = client.routes.videoStatus.includes("{id}")
        ? client.routes.videoStatus.replace("{id}", encodeURIComponent(handle.id))
        : `${client.routes.videoStatus}/${encodeURIComponent(handle.id)}`;
      const response = options.videoAdapter === "async-tasks"
        ? await client.json(`/tasks/${encodeURIComponent(handle.id)}`, secret)
        : await client.json(path, secret);
      const status = jobStatus(response);
      if (isPending(status)) return wakeAfter(canonicalize(handle), options.pollIntervalMs, Date.now(), { phase: status });
      if (isFailed(status)) {
        const detail = [response.error, response.message, response.reason, response.detail]
          .find((value) => typeof value === "string" && value.length > 0);
        throw new Error(`OpenAI-compatible video failed${typeof detail === "string" ? `: ${detail}` : ""}`);
      }
      if (!isReady(status)) throw new Error(`OpenAI-compatible video returned unknown status ${status}`);
      return { status: "ready", handle: context.handle, receipt: { id: handle.id } };
    },
    async collect(context) {
      const handle = object(context.handle, "video handle") as unknown as VideoHandle;
      const secret = client.secret(context.credentials);
      const path = options.videoAdapter === "async-tasks"
        ? `/tasks/${encodeURIComponent(handle.id)}`
        : client.routes.videoStatus.includes("{id}")
          ? client.routes.videoStatus.replace("{id}", encodeURIComponent(handle.id))
          : `${client.routes.videoStatus}/${encodeURIComponent(handle.id)}`;
      const response = await client.json(path, secret);
      const url = [
        response.output_url,
        response.url,
        Array.isArray(response.assets) ? (response.assets[0] as Record<string, unknown> | undefined)?.url : undefined,
        Array.isArray(response.data) ? (response.data[0] as Record<string, unknown> | undefined)?.url : undefined,
      ].find((value) => typeof value === "string" && value.length > 0);
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
