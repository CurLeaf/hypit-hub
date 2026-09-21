import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  putS3PublicObject,
  s3PublicCdnUrl,
  s3PublicUploadConfigFromEnv,
} from "../packages/provider-openai-compatible/src/s3-public-upload.ts";
import { DEFAULT_VIDEO_OBJECT_KEY } from "../packages/analysis/src/default-video.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const originPath = resolve(repoRoot, "origin.mp4");

async function loadEnvFile(path: string): Promise<void> {
  try {
    const text = await readFile(path, "utf8");
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      if (key.length === 0 || process.env[key] !== undefined) continue;
      process.env[key] = value;
    }
  } catch {
    // optional
  }
}

async function upsertEnvVar(path: string, key: string, value: string): Promise<void> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = "";
  }
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, "mu").test(text)
    ? text.replace(new RegExp(`^${key}=.*$`, "mu"), line)
    : `${text.replace(/\s*$/u, "")}\n\n${line}\n`;
  await writeFile(path, next.endsWith("\n") ? next : `${next}\n`);
}

async function main(): Promise<void> {
  await loadEnvFile(resolve(repoRoot, ".env"));
  if (!existsSync(originPath)) throw new Error(`缺少 ${originPath}`);
  const config = s3PublicUploadConfigFromEnv();
  if (config === undefined) {
    throw new Error("缺少 S3_*。请先把 erp-admin-demo-1 的 OSS 配置写入仓库根目录 .env");
  }
  const bytes = await readFile(originPath);
  const url = await putS3PublicObject(config, {
    bytes,
    mediaType: "video/mp4",
    key: DEFAULT_VIDEO_OBJECT_KEY,
  });
  const expected = s3PublicCdnUrl(config, DEFAULT_VIDEO_OBJECT_KEY);
  await upsertEnvVar(resolve(repoRoot, ".env"), "HYPIT_DEFAULT_VIDEO_URL", url);
  const exampleEnv = resolve(repoRoot, "examples/byok-openai-compatible/.env");
  if (existsSync(exampleEnv) || existsSync(dirname(exampleEnv))) {
    try {
      await upsertEnvVar(exampleEnv, "HYPIT_DEFAULT_VIDEO_URL", url);
    } catch {
      // workspace copy is optional
    }
  }
  console.info(`uploaded ${originPath}`);
  console.info(`cdn ${url}`);
  if (url !== expected) console.info(`expected ${expected}`);
}

await main();
