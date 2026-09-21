import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const DEFAULT_VIDEO_OBJECT_KEY = "hypit/default/origin.mp4";
export const DEFAULT_VIDEO_NAME = "origin.mp4";

export function resolveDefaultVideoUrl(env: NodeJS.Dict<string> = process.env): string | undefined {
  const explicit = env.HYPIT_DEFAULT_VIDEO_URL?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const cdn = env.S3_CDN?.trim().replace(/\/+$/u, "");
  if (cdn === undefined || cdn.length === 0) return undefined;
  return `${cdn}/${DEFAULT_VIDEO_OBJECT_KEY}`;
}

export async function materializeDefaultVideo(input: {
  readonly url: string;
  readonly workspaceRoot: string;
  readonly localFallback?: string;
}): Promise<string> {
  const staging = join(input.workspaceRoot, ".hypit", "analysis", "uploads", `incoming-${Date.now()}-origin.mp4`);
  await mkdir(dirname(staging), { recursive: true });
  try {
    const response = await fetch(input.url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`默认视频下载失败 HTTP ${response.status}`);
    await writeFile(staging, Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    if (input.localFallback === undefined || !existsSync(input.localFallback)) throw error;
    await copyFile(input.localFallback, staging);
  }
  const { importUploadedFile } = await import("./engine.js");
  return importUploadedFile(staging, input.workspaceRoot, DEFAULT_VIDEO_NAME);
}
