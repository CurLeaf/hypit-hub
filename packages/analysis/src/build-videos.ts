import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { buildResultDirectory, readBuildResult } from "@hypit/build-result";

import {
  cancelledBuildFailureDetail,
  partialBuildFailureDetail,
} from "./build-failure.js";
import type { GeneratedVideoView } from "./shared.js";

const videoMediaTypes = new Set(["video/mp4", "video/webm", "video/quicktime"]);

function compareVideos(left: GeneratedVideoView, right: GeneratedVideoView): number {
  const byName = left.name.localeCompare(right.name, "en");
  if (byName !== 0) return byName;
  return left.path.localeCompare(right.path, "en");
}

async function collectFromFilesDirectory(buildDir: string): Promise<readonly GeneratedVideoView[]> {
  const filesDir = join(buildDir, "files");
  if (!existsSync(filesDir)) return [];
  const entries = await readdir(filesDir, { withFileTypes: true });
  const videos: GeneratedVideoView[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = entry.name.toLowerCase();
    if (!ext.endsWith(".mp4") && !ext.endsWith(".webm") && !ext.endsWith(".mov")) continue;
    const path = join(filesDir, entry.name);
    const info = await stat(path);
    videos.push({
      name: basename(path, ext.slice(ext.lastIndexOf("."))),
      displayName: entry.name,
      path,
      size: info.size,
      mediaType: ext.endsWith(".webm") ? "video/webm" : ext.endsWith(".mov") ? "video/quicktime" : "video/mp4",
    });
  }
  return videos;
}

/** Collect generated video artifacts for a Build, including partial results after failure. */
export async function collectBuildVideos(
  workspaceRoot: string,
  buildId: string,
): Promise<readonly GeneratedVideoView[]> {
  const resultRoot = resolve(workspaceRoot, ".hypit", "results");
  const buildDir = buildResultDirectory(resultRoot, buildId);
  const manifest = await readBuildResult(buildDir);
  const videos = new Map<string, GeneratedVideoView>();

  if (manifest !== undefined) {
    for (const [name, output] of Object.entries(manifest.outputs)) {
      const value = output.value;
      if (value?.kind !== "build-file") continue;
      if (!videoMediaTypes.has(value.mediaType)) continue;
      const path = resolve(buildDir, value.path);
      if (!existsSync(path)) continue;
      videos.set(name, {
        name,
        ...(output.displayName === undefined ? {} : { displayName: output.displayName }),
        path,
        ...(value.size === undefined ? {} : { size: value.size }),
        mediaType: value.mediaType,
      });
    }
  }

  for (const video of await collectFromFilesDirectory(buildDir)) {
    if (!videos.has(video.name)) videos.set(video.name, video);
  }

  const byPath = new Map<string, GeneratedVideoView>();
  for (const video of videos.values()) {
    const existing = byPath.get(video.path);
    if (existing === undefined) {
      byPath.set(video.path, video);
      continue;
    }
    const preferNamed = !existing.name.startsWith("file-") ? existing : video;
    byPath.set(video.path, preferNamed);
  }

  return [...byPath.values()].sort(compareVideos);
}

/** List every Build id that has a result directory under `.hypit/results`. */
export async function discoverBuildIds(workspaceRoot: string): Promise<readonly string[]> {
  const root = resolve(workspaceRoot, ".hypit", "results");
  if (!existsSync(root)) return [];
  const buildIds: string[] = [];
  for (const bucket of await readdir(root, { withFileTypes: true })) {
    if (!bucket.isDirectory()) continue;
    const bucketPath = join(root, bucket.name);
    for (const entry of await readdir(bucketPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("bld_")) continue;
      const buildDir = join(bucketPath, entry.name);
      if (existsSync(join(buildDir, "result.json")) || existsSync(join(buildDir, "files"))) {
        buildIds.push(entry.name);
      }
    }
  }
  return buildIds.sort();
}

export function buildOutcome(manifest: Awaited<ReturnType<typeof readBuildResult>>): string {
  if (manifest === undefined || manifest.outcome === undefined) return "building";
  return manifest.outcome;
}

export type BuildRecordInfo = {
  readonly status: string;
  readonly failureDetail?: string;
};

function resolveFailureDetail(
  status: string,
  failure: string | undefined,
): string | undefined {
  if (status === "complete") return undefined;
  const trimmed = failure?.trim();
  if (trimmed !== undefined && trimmed.length > 0) return trimmed;
  if (status === "building") return undefined;
  if (status === "partial") return partialBuildFailureDetail();
  if (status === "cancelled") return cancelledBuildFailureDetail();
  if (status === "failed" || status === "error") {
    return "Build 失败，未生成 final 成片。";
  }
  return "Build 未完成，未生成 final 成片。";
}

/** Read persisted Build outcome and failure detail from `.hypit/results`. */
export async function readBuildRecord(
  workspaceRoot: string,
  buildId: string,
): Promise<BuildRecordInfo> {
  const resultRoot = resolve(workspaceRoot, ".hypit", "results");
  const manifest = await readBuildResult(buildResultDirectory(resultRoot, buildId));
  const status = buildOutcome(manifest);
  return {
    status,
    failureDetail: resolveFailureDetail(status, manifest?.failure),
  };
}

/** Read persisted Build outcome from `.hypit/results` (complete / failed / cancelled / partial). */
export async function readBuildRecordStatus(workspaceRoot: string, buildId: string): Promise<string> {
  return (await readBuildRecord(workspaceRoot, buildId)).status;
}

const SYNC_TTL_MS = 15_000;
const lastFullSyncAt = new Map<string, number>();

export type SyncAllBuildVideosOptions = {
  readonly force?: boolean;
};

/** Sync every discovered Build's model-returned videos into the registry. */
export async function syncAllBuildVideos(
  workspaceRoot: string,
  registry: { syncBuildVideos(buildId: string, videos: readonly GeneratedVideoView[], buildStatus: string): void },
  options?: SyncAllBuildVideosOptions,
): Promise<void> {
  const key = resolve(workspaceRoot);
  const now = Date.now();
  if (options?.force !== true) {
    const lastSync = lastFullSyncAt.get(key);
    if (lastSync !== undefined && now - lastSync < SYNC_TTL_MS) return;
  }
  const resultRoot = resolve(workspaceRoot, ".hypit", "results");
  for (const buildId of await discoverBuildIds(workspaceRoot)) {
    const videos = await collectBuildVideos(workspaceRoot, buildId);
    if (videos.length === 0) continue;
    const manifest = await readBuildResult(buildResultDirectory(resultRoot, buildId));
    registry.syncBuildVideos(buildId, videos, buildOutcome(manifest));
  }
  lastFullSyncAt.set(key, now);
}

/** Sync one Build immediately (used while a Build is actively running). */
export async function syncBuildVideos(
  workspaceRoot: string,
  buildId: string,
  registry: { syncBuildVideos(buildId: string, videos: readonly GeneratedVideoView[], buildStatus: string): void },
  buildStatus: string,
): Promise<readonly GeneratedVideoView[]> {
  const videos = await collectBuildVideos(workspaceRoot, buildId);
  if (videos.length > 0) registry.syncBuildVideos(buildId, videos, buildStatus);
  return videos;
}
