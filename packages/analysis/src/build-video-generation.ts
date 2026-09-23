import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildResultDirectory,
  decodeBuildResultJson,
  decodeBuildResultValueDocument,
  readBuildResult,
} from "@hypit/build-result";

import { collectBuildVideos } from "./build-videos.js";
import { selectMergeClips } from "./merge-build-clips.js";
import type { GeneratedVideoView, VideoGenerationTakeView } from "./shared.js";

const takeVideoPattern = /^(shot|scene|segment)_(\d+)-take(?:\.video)?$/u;
const GENERATION_CACHE_TTL_MS = 60_000;
const generationCache = new Map<string, { readonly at: number; readonly takes: readonly VideoGenerationTakeView[] }>();

export type H3TakeRequestSpec = {
  readonly duration: number;
  readonly resolution: string;
  readonly aspectRatio: string;
  readonly referenceImages: readonly string[];
  readonly referenceAudio?: string;
};

function promptOutputName(takeId: string): string {
  return `${takeId}-prompt`;
}

function generationCacheKey(workspaceRoot: string, buildId: string, videoName: string): string {
  return `${resolve(workspaceRoot)}\0${buildId}\0${videoName}`;
}

export function takeIdFromVideoName(name: string): string | undefined {
  const base = name.endsWith(".video") ? name.slice(0, -".video".length) : name;
  const match = takeVideoPattern.exec(base);
  return match === null ? undefined : `${match[1]}_${match[2]}`;
}

function summarizePrompt(prompt: string, maxLength = 120): string {
  const spoken = /Spoken script:\s*\n([\s\S]*?)(?:\n\nVisual direction:|$)/u.exec(prompt);
  const candidate = spoken?.[1]?.replace(/^HOST:\s*/u, "").replace(/\s+/gu, " ").trim()
    ?? prompt.replace(/\s+/gu, " ").trim();
  if (candidate.length <= maxLength) return candidate;
  return `${candidate.slice(0, maxLength - 1)}…`;
}

function textFromValueDocument(raw: unknown): string | undefined {
  try {
    decodeBuildResultValueDocument(raw, "prompt value");
    const document = raw as { readonly value?: unknown };
    if (document.value === null || typeof document.value !== "object" || Array.isArray(document.value)) {
      return undefined;
    }
    const nested = document.value as { readonly value?: unknown };
    if (typeof nested.value === "string" && nested.value.trim().length > 0) return nested.value;
    return undefined;
  } catch {
    return undefined;
  }
}

async function readPromptFromBuild(
  buildDir: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readBuildResult>>>,
  takeId: string,
): Promise<string | undefined> {
  const output = manifest.outputs[promptOutputName(takeId)];
  if (output?.value.kind !== "value") return undefined;
  try {
    const path = join(buildDir, output.value.path);
    const raw = decodeBuildResultJson(await readFile(path), path);
    return textFromValueDocument(raw);
  } catch {
    return undefined;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function parseH3TakeBlock(svml: string, takeId: string): H3TakeRequestSpec | undefined {
  const blockPattern = new RegExp(
    `<h3:ReferenceVideo\\s+id="${escapeRegExp(takeId)}-take"([^>]*)>([\\s\\S]*?)</h3:ReferenceVideo>`,
    "u",
  );
  const match = blockPattern.exec(svml);
  if (match === null) return undefined;
  const attrs = match[1] ?? "";
  const body = match[2] ?? "";
  const duration = Number(/duration="(\d+)"/u.exec(attrs)?.[1]);
  const resolution = /resolution="([^"]+)"/u.exec(attrs)?.[1] ?? "768P";
  const aspectRatio = /aspect-ratio="([^"]+)"/u.exec(attrs)?.[1] ?? "9:16";
  const referenceImages = [...body.matchAll(/<h3:Reference\s+image=\{([^}]+)\}/gu)].map((item) => item[1]!);
  const referenceAudio = /<h3:Reference\s+audio=\{([^}]+)\}/u.exec(body)?.[1];
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  return {
    duration,
    resolution,
    aspectRatio,
    referenceImages,
    ...(referenceAudio === undefined ? {} : { referenceAudio }),
  };
}

async function readAuthorSvml(
  workspaceRoot: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readBuildResult>>>,
): Promise<string | undefined> {
  try {
    return await readFile(resolve(workspaceRoot, manifest.source.path), "utf8");
  } catch {
    return undefined;
  }
}

export function buildMinimaxRequestPreview(
  prompt: string,
  spec: H3TakeRequestSpec,
  model = "MiniMax-H3",
): string {
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  for (const imageRef of spec.referenceImages) {
    content.push({
      type: "image_url",
      role: "reference_image",
      image_url: { url: `<${imageRef}>` },
    });
  }
  if (spec.referenceAudio !== undefined) {
    content.push({
      type: "audio_url",
      role: "reference_audio",
      audio_url: { url: `<${spec.referenceAudio}>` },
    });
  }
  return JSON.stringify({
    _note: "根据 Build 渲染结果与 author SVML 重建的请求预览；媒体 URL 为占位符，非运行时原始 HTTP body。",
    model,
    content,
    duration: spec.duration,
    resolution: spec.resolution,
    ratio: spec.aspectRatio,
    endpoint: "POST /v2/video_generation",
  }, null, 2);
}

async function resolveTakeGeneration(
  buildDir: string,
  manifest: NonNullable<Awaited<ReturnType<typeof readBuildResult>>>,
  authorSvml: string | undefined,
  takeId: string,
): Promise<VideoGenerationTakeView | undefined> {
  const prompt = await readPromptFromBuild(buildDir, manifest, takeId);
  const spec = authorSvml === undefined ? undefined : parseH3TakeBlock(authorSvml, takeId);
  if (prompt === undefined && spec === undefined) return undefined;
  const resolvedPrompt = prompt ?? `${takeId} prompt unavailable`;
  return {
    takeId,
    prompt: resolvedPrompt,
    promptSummary: summarizePrompt(resolvedPrompt),
    ...(spec === undefined ? {} : {
      requestPreview: buildMinimaxRequestPreview(resolvedPrompt, spec),
      durationSeconds: spec.duration,
      resolution: spec.resolution,
      aspectRatio: spec.aspectRatio,
    }),
  };
}

function takeIdsForVideo(
  video: GeneratedVideoView,
  buildVideos: readonly GeneratedVideoView[],
): readonly string[] {
  const direct = takeIdFromVideoName(video.name);
  if (direct !== undefined) return [direct];
  return selectMergeClips(buildVideos)
    .map((clip) => takeIdFromVideoName(clip.name))
    .filter((takeId): takeId is string => takeId !== undefined);
}

/** Resolve rendered prompts and reconstructed API request previews for one gallery video. */
export async function resolveVideoGenerationTakes(
  workspaceRoot: string,
  buildId: string,
  video: GeneratedVideoView,
): Promise<readonly VideoGenerationTakeView[]> {
  const cacheKey = generationCacheKey(workspaceRoot, buildId, video.name);
  const cached = generationCache.get(cacheKey);
  const now = Date.now();
  if (cached !== undefined && now - cached.at < GENERATION_CACHE_TTL_MS) return cached.takes;

  const buildDir = buildResultDirectory(resolve(workspaceRoot, ".hypit", "results"), buildId);
  const manifest = await readBuildResult(buildDir);
  if (manifest === undefined) return [];
  const authorSvml = await readAuthorSvml(workspaceRoot, manifest);
  const buildVideos = await collectBuildVideos(workspaceRoot, buildId);
  const takes: VideoGenerationTakeView[] = [];
  for (const takeId of takeIdsForVideo(video, buildVideos)) {
    const entry = await resolveTakeGeneration(buildDir, manifest, authorSvml, takeId);
    if (entry !== undefined) takes.push(entry);
  }
  generationCache.set(cacheKey, { at: now, takes });
  return takes;
}

export async function enrichVideoWithGeneration(
  workspaceRoot: string,
  video: GeneratedVideoView,
): Promise<GeneratedVideoView> {
  if (video.buildId === undefined || video.buildId.length === 0) return video;
  const generationTakes = await resolveVideoGenerationTakes(workspaceRoot, video.buildId, video);
  if (generationTakes.length === 0) return video;
  return { ...video, generationTakes };
}

export async function enrichVideosWithGeneration(
  workspaceRoot: string,
  videos: readonly GeneratedVideoView[],
): Promise<readonly GeneratedVideoView[]> {
  return Promise.all(videos.map(async (video) => await enrichVideoWithGeneration(workspaceRoot, video)));
}

export function clearVideoGenerationCache(workspaceRoot?: string): void {
  if (workspaceRoot === undefined) {
    generationCache.clear();
    return;
  }
  const prefix = `${resolve(workspaceRoot)}\0`;
  for (const key of generationCache.keys()) {
    if (key.startsWith(prefix)) generationCache.delete(key);
  }
}
