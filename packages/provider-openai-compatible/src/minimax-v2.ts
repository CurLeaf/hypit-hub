import type { GenerationMediaValue, GenerationRequest } from "@hypit/generation";
import type { BlobRef } from "@hypit/protocol";

import type { OpenAiCompatibleRoutes, VideoAdapter } from "./client.js";

export type MinimaxV2ContentItem =
  | { readonly type: "text"; readonly text: string }
  | {
    readonly type: "image_url";
    readonly role: "reference_image" | "first_frame" | "last_frame";
    readonly image_url: { readonly url: string };
  }
  | {
    readonly type: "video_url";
    readonly role: "reference_video";
    readonly video_url: { readonly url: string };
  }
  | {
    readonly type: "audio_url";
    readonly role: "reference_audio";
    readonly audio_url: { readonly url: string };
  };

export type MinimaxV2VideoBody = {
  readonly model: string;
  readonly content: readonly MinimaxV2ContentItem[];
  readonly duration: number;
  readonly resolution: string;
  readonly ratio?: string;
};

export const defaultMinimaxV2VideoRoutes = {
  videoSubmit: "/v2/video_generation",
  videoStatus: "/v2/query/video_generation/{id}",
} as const;

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export function unwrapVideoTask(response: Record<string, unknown>): Record<string, unknown> {
  const data = record(response.data);
  const root = data === undefined ? response : { ...response, ...data };
  const task = record(root.task);
  return task === undefined ? root : { ...root, ...task };
}

export function videoJobId(response: Record<string, unknown>): string {
  const task = unwrapVideoTask(response);
  const id = task.id ?? task.task_id ?? response.id ?? response.job_id ?? response.task_id;
  if (typeof id !== "string" || id.length === 0) throw new Error("remote video job id must be non-empty text");
  return id;
}

export function videoJobStatus(response: Record<string, unknown>): string {
  const task = unwrapVideoTask(response);
  const status = task.status ?? task.state;
  if (typeof status === "string" && status.length > 0) return status;
  if (task.id !== undefined || task.task_id !== undefined) return "queued";
  return "unknown";
}

export function videoJobError(response: Record<string, unknown>): string | undefined {
  const task = unwrapVideoTask(response);
  for (const value of [task.error, task.message, task.reason, task.detail]) {
    if (typeof value === "string" && value.length > 0) return value;
    const nested = record(value);
    const message = nested?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return undefined;
}

export function videoOutputUrl(response: Record<string, unknown>): string | undefined {
  const task = unwrapVideoTask(response);
  const content = record(task.content);
  const candidates = [
    content?.url,
    task.output_url,
    task.url,
    Array.isArray(task.assets) ? record(task.assets[0])?.url : undefined,
    Array.isArray(task.data) ? record(task.data[0])?.url : undefined,
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function applyVideoAdapterRoutes(
  adapter: VideoAdapter,
  routes: OpenAiCompatibleRoutes,
): OpenAiCompatibleRoutes {
  if (adapter !== "minimax-v2") return routes;
  return {
    ...routes,
    videoSubmit: routes.videoSubmit.includes("video_generation")
      ? routes.videoSubmit
      : defaultMinimaxV2VideoRoutes.videoSubmit,
    videoStatus: routes.videoStatus.includes("video_generation")
      ? routes.videoStatus
      : defaultMinimaxV2VideoRoutes.videoStatus,
  };
}

function mediaItems(ports: GenerationRequest["ports"], name: string): readonly GenerationMediaValue[] {
  const value = ports[name];
  if (value === undefined) return [];
  return value as readonly GenerationMediaValue[];
}

function promptText(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error("MiniMax V2 video request is missing prompt text");
}

function durationSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) return Number(value);
  throw new Error("MiniMax V2 video request is missing duration");
}

export function minimaxV2Resolution(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "768P";
  const upper = value.trim().toUpperCase();
  if (upper === "2K") return "2K";
  if (upper === "768P" || upper === "768") return "768P";
  if (upper === "480P" || upper === "480") return "480P";
  return value.trim();
}

export async function compileMinimaxV2Request(
  request: GenerationRequest,
  model: string,
  resolve: (artifact: BlobRef) => Promise<string>,
): Promise<MinimaxV2VideoBody> {
  const { ports } = request;
  const firstFrames = mediaItems(ports, "firstFrame");
  const lastFrames = mediaItems(ports, "lastFrame");
  const referenceImages = mediaItems(ports, "referenceImage");
  const referenceVideos = mediaItems(ports, "referenceVideo");
  const referenceAudios = mediaItems(ports, "referenceAudio");
  const content: MinimaxV2ContentItem[] = [{ type: "text", text: promptText(ports.prompt?.[0]) }];
  for (const item of firstFrames) {
    content.push({
      type: "image_url",
      role: "first_frame",
      image_url: { url: await resolve(item.artifact) },
    });
  }
  for (const item of lastFrames) {
    content.push({
      type: "image_url",
      role: "last_frame",
      image_url: { url: await resolve(item.artifact) },
    });
  }
  for (const item of referenceImages) {
    content.push({
      type: "image_url",
      role: "reference_image",
      image_url: { url: await resolve(item.artifact) },
    });
  }
  for (const item of referenceVideos) {
    content.push({
      type: "video_url",
      role: "reference_video",
      video_url: { url: await resolve(item.artifact) },
    });
  }
  for (const item of referenceAudios) {
    content.push({
      type: "audio_url",
      role: "reference_audio",
      audio_url: { url: await resolve(item.artifact) },
    });
  }
  const hasFrame = firstFrames.length > 0 || lastFrames.length > 0;
  const hasReference = referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0;
  const aspectRatio = typeof ports.aspectRatio?.[0] === "string" ? ports.aspectRatio[0] : undefined;
  const ratio = hasFrame ? "adaptive" : hasReference ? aspectRatio : (aspectRatio ?? "16:9");
  return {
    model,
    content,
    duration: durationSeconds(ports.duration?.[0]),
    resolution: minimaxV2Resolution(ports.resolution?.[0]),
    ...(ratio === undefined ? {} : { ratio }),
  };
}
