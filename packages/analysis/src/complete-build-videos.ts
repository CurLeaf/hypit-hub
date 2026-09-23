import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { enrichVideoWithGeneration } from "./build-video-generation.js";
import { summarizeBuildFailure } from "./build-failure.js";
import { collectBuildVideos, discoverBuildIds, readBuildRecord } from "./build-videos.js";
import { mergeBuildClips, selectMergeClips } from "./merge-build-clips.js";
import type { GeneratedVideoView } from "./shared.js";

function failureFields(
  status: string,
  failureDetail: string | undefined,
): Pick<GeneratedVideoView, "buildFailureSummary" | "buildFailureDetail"> {
  if (status === "complete" || failureDetail === undefined) return {};
  return {
    buildFailureSummary: summarizeBuildFailure(failureDetail),
    buildFailureDetail: failureDetail,
  };
}

function mergedOutputPath(workspaceRoot: string, buildId: string): string {
  return join(resolve(workspaceRoot), ".hypit", "analysis", "merged", `${buildId}.mp4`);
}

function pickFinalVideo(videos: readonly GeneratedVideoView[]): GeneratedVideoView | undefined {
  return videos.find((video) => video.name === "final.video" || video.name === "final");
}

function completeDisplayName(buildId: string, clips: readonly GeneratedVideoView[]): string {
  if (clips.length === 1) {
    const clip = clips[0]!;
    if (clip.displayName === "final" || clip.name === "final.video") return "final";
    const label = clip.displayName ?? clip.name;
    return label.endsWith(".video") ? label.slice(0, -".video".length) : label;
  }
  return `Build ${buildId.slice(-12)}`;
}

async function mergedFileIsFresh(
  outputPath: string,
  sources: readonly GeneratedVideoView[],
): Promise<boolean> {
  if (!existsSync(outputPath)) return false;
  const merged = await stat(outputPath);
  for (const source of sources) {
    if (!existsSync(source.path)) return false;
    const clip = await stat(source.path);
    if (clip.mtimeMs > merged.mtimeMs) return false;
  }
  return true;
}

/** Resolve one complete preview video for a build (final, merged takes, or a single take). */
export async function resolveCompleteBuildVideo(
  workspaceRoot: string,
  buildId: string,
  videos?: readonly GeneratedVideoView[],
): Promise<GeneratedVideoView | undefined> {
  const buildRecord = await readBuildRecord(workspaceRoot, buildId);
  const buildStatus = buildRecord.status;
  const buildVideos = videos ?? await collectBuildVideos(workspaceRoot, buildId);
  const failure = failureFields(buildStatus, buildRecord.failureDetail);
  const final = pickFinalVideo(buildVideos);
  if (final !== undefined) {
    return {
      ...final,
      buildId,
      buildStatus,
      ...failure,
      displayName: completeDisplayName(buildId, [final]),
    };
  }

  const clips = selectMergeClips(buildVideos);
  if (clips.length === 0) return undefined;
  if (clips.length === 1) {
    const clip = clips[0]!;
    return {
      ...clip,
      buildId,
      buildStatus,
      ...failure,
      displayName: completeDisplayName(buildId, clips),
    };
  }

  const outputPath = mergedOutputPath(workspaceRoot, buildId);
  if (!(await mergedFileIsFresh(outputPath, clips))) {
    await mergeBuildClips(workspaceRoot, buildId, outputPath);
  }
  if (!existsSync(outputPath)) return undefined;

  const info = await stat(outputPath);
  return {
    name: "merged.video",
    displayName: completeDisplayName(buildId, clips),
    path: outputPath,
    size: info.size,
    mediaType: "video/mp4",
    buildId,
    buildStatus,
    ...failure,
  };
}

/** One complete video per build, newest builds first. */
export async function listCompleteBuildVideos(
  workspaceRoot: string,
  options?: { readonly includeGeneration?: boolean },
): Promise<readonly GeneratedVideoView[]> {
  const buildIds = await discoverBuildIds(workspaceRoot);
  const complete: GeneratedVideoView[] = [];
  for (const buildId of buildIds) {
    let video = await resolveCompleteBuildVideo(workspaceRoot, buildId);
    if (video === undefined) continue;
    if (options?.includeGeneration === true) {
      video = await enrichVideoWithGeneration(workspaceRoot, video);
    }
    complete.push(video);
  }
  return complete.sort((left, right) => {
    const leftTime = left.recordedAt ?? "";
    const rightTime = right.recordedAt ?? "";
    if (leftTime !== rightTime) return rightTime.localeCompare(leftTime);
    return (right.buildId ?? "").localeCompare(left.buildId ?? "");
  });
}
