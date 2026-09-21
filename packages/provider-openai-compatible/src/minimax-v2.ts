import type { EndpointPollContext, EndpointStartContext } from "@hypit/endpoint-kit";
import { canonicalize, wakeAfter } from "@hypit/endpoint-kit";
import { compileWireRequest, sealGeneratedVideoSet } from "@hypit/generation";
import type { GenerationRequest } from "@hypit/generation";

import type { OpenAiCompatibleClient } from "./client.js";
import { mappingForCapability } from "./mappings.js";
import { uploadArtifactUrl } from "./upload.js";

export type MinimaxV2VideoHandle = {
  readonly contract: "hypit.minimax-v2-video@1";
  readonly id: string;
  readonly adapter: "minimax-v2";
  readonly startedAt: number;
};

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

export function normalizeMinimaxResolution(value: string): string {
  const upper = value.trim().toUpperCase();
  if (upper === "2K" || upper === "768P" || upper === "480P") return upper;
  if (upper === "720P") return "768P";
  return "768P";
}

export function buildMinimaxV2SubmitBody(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  const prompt = String(input.prompt ?? "");
  if (prompt.length > 0) {
    content.push({ type: "text", text: prompt });
  }
  for (const url of asStringArray(input.reference_image_urls)) {
    content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
  }
  for (const url of asStringArray(input.reference_videos)) {
    content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
  }
  for (const url of asStringArray(input.reference_audios)) {
    content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
  }
  if (typeof input.first_frame === "string" && input.first_frame.length > 0) {
    content.push({ type: "image_url", image_url: { url: input.first_frame }, role: "first_frame" });
  }
  if (typeof input.last_frame === "string" && input.last_frame.length > 0) {
    content.push({ type: "image_url", image_url: { url: input.last_frame }, role: "last_frame" });
  }
  const duration = Number(input.seconds ?? 6);
  const ratio = String(input.aspect_ratio ?? "adaptive");
  return {
    model,
    content,
    resolution: normalizeMinimaxResolution(String(input.resolution ?? "768P")),
    duration: Number.isFinite(duration) ? duration : 6,
    ratio,
  };
}

function minimaxTask(response: Record<string, unknown>): Record<string, unknown> {
  const task = response.task;
  if (task !== null && typeof task === "object" && !Array.isArray(task)) return task as Record<string, unknown>;
  return response;
}

function minimaxTaskStatus(response: Record<string, unknown>): string {
  return String(minimaxTask(response).status ?? response.status ?? "unknown");
}

function minimaxTaskId(response: Record<string, unknown>): string {
  const task = minimaxTask(response);
  const id = task.id ?? response.task_id ?? response.id;
  if (typeof id !== "string" || id.length === 0) throw new Error("MiniMax video submission did not return task_id");
  return id;
}

function minimaxTaskUrl(response: Record<string, unknown>): string | undefined {
  const content = minimaxTask(response).content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) return undefined;
  const url = (content as Record<string, unknown>).url;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

function minimaxTaskError(response: Record<string, unknown>): string | undefined {
  const task = minimaxTask(response);
  const error = task.error;
  if (error === null || typeof error !== "object" || Array.isArray(error)) return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
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

export function createMinimaxV2VideoEndpoint(
  client: OpenAiCompatibleClient,
  options: {
    readonly pollIntervalMs: number;
    readonly operationTimeoutMs: number;
    readonly modelFor: (context: EndpointStartContext) => string;
  },
) {
  const resolveArtifact = async (
    artifact: Parameters<typeof uploadArtifactUrl>[2],
    resources: EndpointStartContext["resources"],
    secret: string,
  ): Promise<string> => await uploadArtifactUrl(client, secret, artifact, resources);

  return {
    async start(context: EndpointStartContext) {
      const mapping = mappingForCapability(context.need.capability);
      if (mapping === undefined) throw new Error("Video mapping is unavailable");
      const secret = client.secret(context.credentials);
      const compiled = await compileWireRequest(
        mapping,
        context.need.constraints as unknown as GenerationRequest,
        async (artifact) => await resolveArtifact(artifact, context.resources, secret),
      );
      const body = buildMinimaxV2SubmitBody(options.modelFor(context), compiled.input as Record<string, unknown>);
      const response = await client.json(client.routes.videoSubmit, secret, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": context.operation },
        body: JSON.stringify(body),
      });
      const status = minimaxTaskStatus(response);
      const id = minimaxTaskId(response);
      const handle: MinimaxV2VideoHandle = {
        contract: "hypit.minimax-v2-video@1",
        id,
        adapter: "minimax-v2",
        startedAt: Date.now(),
      };
      const receipt = { id };
      await context.checkpoint?.({ handle: canonicalize(handle), receipt, ...(isReady(status) ? { remoteEnded: true as const } : {}) });
      if (isFailed(status)) {
        throw new Error(`MiniMax video submission failed${minimaxTaskError(response) ? `: ${minimaxTaskError(response)}` : ""}`);
      }
      return isReady(status)
        ? { status: "ready", handle: canonicalize(handle), receipt }
        : { ...wakeAfter(canonicalize(handle), options.pollIntervalMs, Date.now(), { phase: status }), receipt };
    },
    async poll(context: EndpointPollContext) {
      const handle = object(context.handle, "video handle") as unknown as MinimaxV2VideoHandle;
      if (handle.contract !== "hypit.minimax-v2-video@1") throw new Error("Video handle is invalid");
      if (Date.now() - handle.startedAt > options.operationTimeoutMs) {
        return {
          status: "failed",
          failure: { code: "MINIMAX_V2_VIDEO_TIMEOUT", message: "MiniMax video operation timed out" },
        };
      }
      const secret = client.secret(context.credentials);
      const path = client.routes.videoStatus.includes("{id}")
        ? client.routes.videoStatus.replace("{id}", encodeURIComponent(handle.id))
        : `${client.routes.videoStatus}/${encodeURIComponent(handle.id)}`;
      const response = await client.json(path, secret);
      const status = minimaxTaskStatus(response);
      if (isPending(status)) return wakeAfter(canonicalize(handle), options.pollIntervalMs, Date.now(), { phase: status });
      if (isFailed(status)) {
        const detail = minimaxTaskError(response);
        throw new Error(`MiniMax video failed${detail ? `: ${detail}` : ""}`);
      }
      if (!isReady(status)) throw new Error(`MiniMax video returned unknown status ${status}`);
      return { status: "ready", handle: context.handle, receipt: { id: handle.id } };
    },
    async collect(context: EndpointPollContext) {
      const handle = object(context.handle, "video handle") as unknown as MinimaxV2VideoHandle;
      const secret = client.secret(context.credentials);
      const path = client.routes.videoStatus.includes("{id}")
        ? client.routes.videoStatus.replace("{id}", encodeURIComponent(handle.id))
        : `${client.routes.videoStatus}/${encodeURIComponent(handle.id)}`;
      const response = await client.json(path, secret);
      const url = minimaxTaskUrl(response);
      if (url === undefined) throw new Error("MiniMax video result did not include a download URL");
      const downloaded = await client.download(url);
      if (!downloaded.mediaType.startsWith("video/")) throw new Error("MiniMax video result was not video media");
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
