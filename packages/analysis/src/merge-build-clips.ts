import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { collectBuildVideos, discoverBuildIds } from "./build-videos.js";
import type { GeneratedVideoView } from "./shared.js";

const execFileAsync = promisify(execFile);

const takeNamePattern = /^(shot|scene|segment)_(\d+)-take$/u;

/** ffmpeg concat demuxer treats backslashes as escapes; normalize to forward slashes on Windows. */
export function formatConcatListPath(filePath: string): string {
  return filePath.replace(/\\/gu, "/").replace(/'/gu, "'\\''");
}

/** Pick ordered take clips from a build (excludes final and anonymous file-* duplicates). */
export function selectMergeClips(videos: readonly GeneratedVideoView[]): readonly GeneratedVideoView[] {
  const takes: Array<{ readonly order: number; readonly video: GeneratedVideoView }> = [];
  for (const video of videos) {
    const baseName = video.name.endsWith(".video") ? video.name.slice(0, -".video".length) : video.name;
    const match = takeNamePattern.exec(baseName);
    if (match === null) continue;
    takes.push({ order: Number(match[2]), video });
  }
  return takes
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.video);
}

export type MergeBuildClipsResult = {
  readonly buildId: string;
  readonly clipCount: number;
  readonly clipNames: readonly string[];
  readonly outputPath: string;
  readonly skipped: boolean;
  readonly reason?: string;
};

export async function mergeBuildClips(
  workspaceRoot: string,
  buildId: string,
  outputPath: string,
): Promise<MergeBuildClipsResult> {
  const videos = await collectBuildVideos(workspaceRoot, buildId);
  const clips = selectMergeClips(videos);
  const clipNames = clips.map((clip) => clip.displayName ?? clip.name);

  if (clips.length === 0) {
    const finalOnly = videos.find((video) => video.name === "final.video" || video.name === "final");
    if (finalOnly !== undefined) {
      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(finalOnly.path, outputPath);
      return {
        buildId,
        clipCount: 1,
        clipNames: [finalOnly.displayName ?? finalOnly.name],
        outputPath,
        skipped: false,
        reason: "仅含成片，已复制 final",
      };
    }
    return {
      buildId,
      clipCount: 0,
      clipNames,
      outputPath,
      skipped: true,
      reason: "未找到可合并的 take 片段",
    };
  }

  if (clips.length === 1) {
    await mkdir(dirname(outputPath), { recursive: true });
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", clips[0]!.path,
      "-c", "copy",
      outputPath,
    ], { windowsHide: true });
    return { buildId, clipCount: 1, clipNames, outputPath, skipped: false };
  }

  await mkdir(dirname(outputPath), { recursive: true });
  const listPath = join(dirname(outputPath), `${buildId}.concat.txt`);
  const listBody = clips.map((clip) => `file '${formatConcatListPath(clip.path)}'`).join("\n");
  await writeFile(listPath, `${listBody}\n`, "utf8");

  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-c", "copy",
      outputPath,
    ], { windowsHide: true });
  } catch {
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0",
      "-i", listPath,
      "-c:v", "libx264", "-preset", "fast", "-crf", "20",
      "-c:a", "aac", "-b:a", "192k",
      outputPath,
    ], { windowsHide: true });
  }

  return { buildId, clipCount: clips.length, clipNames, outputPath, skipped: false };
}

export async function mergeAllBuildClips(
  workspaceRoot: string,
  outputDir: string,
): Promise<readonly MergeBuildClipsResult[]> {
  const root = resolve(workspaceRoot);
  const destination = resolve(outputDir);
  await mkdir(destination, { recursive: true });
  const results: MergeBuildClipsResult[] = [];
  for (const buildId of await discoverBuildIds(root)) {
    const outputPath = join(destination, `${buildId}.mp4`);
    results.push(await mergeBuildClips(root, buildId, outputPath));
  }
  return results;
}
