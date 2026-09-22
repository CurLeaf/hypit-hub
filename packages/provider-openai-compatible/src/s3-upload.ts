import { randomUUID } from "node:crypto";

import { AwsS3ObjectClient } from "@hypit/resource-store-s3";

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`S3 reference upload requires ${name}`);
  }
  return value;
}

export function parseS3ForcePathStyle(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return false;
}

export type S3ReferenceUploadConfig = {
  readonly bucket: string;
  readonly region: string;
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly cdn: string;
  readonly forcePathStyle: boolean;
};

export function resolveS3ReferenceUploadConfig(): S3ReferenceUploadConfig {
  return {
    bucket: requiredEnv("S3_BUCKET_NAME"),
    region: requiredEnv("S3_REGION"),
    endpoint: requiredEnv("S3_ENDPOINT"),
    accessKeyId: requiredEnv("S3_ACCESS_KEY_ID"),
    secretAccessKey: requiredEnv("S3_SECRET_ACCESS_KEY"),
    cdn: requiredEnv("S3_CDN").replace(/\/+$/u, ""),
    forcePathStyle: parseS3ForcePathStyle(process.env.S3_FORCE_PATH_STYLE),
  };
}

function referenceFilename(mediaType: string): string {
  const map: Record<string, string> = {
    "image/png": "reference.png",
    "image/jpeg": "reference.jpg",
    "image/webp": "reference.webp",
    "audio/wav": "reference.wav",
    "audio/mpeg": "reference.mp3",
    "video/mp4": "reference.mp4",
  };
  return map[mediaType] ?? "reference.bin";
}

export async function uploadReferenceToS3(bytes: Uint8Array, mediaType: string): Promise<string> {
  const config = resolveS3ReferenceUploadConfig();
  const key = `hypit/references/${randomUUID()}/${referenceFilename(mediaType)}`;
  const client = new AwsS3ObjectClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
  await client.put({
    Bucket: config.bucket,
    Key: key,
    Body: bytes,
    ContentType: mediaType,
  });
  return `${config.cdn}/${key.replace(/^\/+/u, "")}`;
}
