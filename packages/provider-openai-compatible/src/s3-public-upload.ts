/**
 * Public-read OSS/S3 upload via presigned POST. MiniMax and other gateways
 * without a usable `POST /files` then fetch `{S3_CDN}/…`.
 */
import { createHmac } from "node:crypto";

const REQUIRED_ENV = [
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET_NAME",
  "S3_REGION",
  "S3_CDN",
] as const;

const DEFAULT_KEY_PREFIX = "hypit/references";

export type S3PublicUploadConfig = {
  readonly endpoint: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly bucketName: string;
  readonly region: string;
  readonly cdnUrl: string;
  readonly keyPrefix: string;
};

export type S3PresignedPost = {
  readonly url: string;
  readonly fields: Readonly<Record<string, string>>;
};

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

export function s3PublicUploadConfigFromEnv(
  env: NodeJS.Dict<string> = process.env,
): S3PublicUploadConfig | undefined {
  const values = REQUIRED_ENV.map((name) => text(env[name]));
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(`S3 public upload needs ${REQUIRED_ENV.join(", ")}`);
  }
  const [
    endpoint,
    accessKeyId,
    accessKeySecret,
    bucketName,
    region,
    cdnUrl,
  ] = values as string[];
  const keyPrefix = text(env.S3_KEY_PREFIX) ?? DEFAULT_KEY_PREFIX;
  return { endpoint, accessKeyId, accessKeySecret, bucketName, region, cdnUrl, keyPrefix };
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(secretKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export function createS3PresignedPost(
  config: S3PublicUploadConfig,
  key: string,
  now = new Date(),
  expiresInSeconds = 3600,
): S3PresignedPost {
  const shortDate = now.toISOString().slice(0, 10).replace(/-/gu, "");
  const amzDate = `${shortDate}T000000Z`;
  const credential = `${config.accessKeyId}/${shortDate}/${config.region}/s3/aws4_request`;
  const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();
  const policy = Buffer.from(JSON.stringify({
    expiration: expiresAt,
    conditions: [
      { bucket: config.bucketName },
      { key },
      { acl: "public-read" },
      { "x-amz-algorithm": "AWS4-HMAC-SHA256" },
      { "x-amz-credential": credential },
      { "x-amz-date": amzDate },
    ],
  })).toString("base64");
  return {
    url: config.endpoint,
    fields: {
      key,
      acl: "public-read",
      "x-amz-algorithm": "AWS4-HMAC-SHA256",
      "x-amz-credential": credential,
      "x-amz-date": amzDate,
      policy,
      "x-amz-signature": hmac(signingKey(config.accessKeySecret, shortDate, config.region), policy).toString("hex"),
    },
  };
}

function extensionForMediaType(mediaType: string): string {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/png") return "png";
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "wav";
  if (type === "audio/mpeg" || type === "audio/mp3") return "mp3";
  if (type === "video/mp4") return "mp4";
  if (type === "video/webm") return "webm";
  const subtype = type.split("/")[1];
  return subtype !== undefined && /^[a-z0-9]+$/u.test(subtype) ? subtype : "bin";
}

export function s3PublicObjectKey(
  config: S3PublicUploadConfig,
  mediaType: string,
  objectId: string,
): string {
  const prefix = config.keyPrefix.replace(/\/+$/u, "");
  const name = objectId.replace(/^\/+/u, "");
  return `${prefix}/${name}.${extensionForMediaType(mediaType)}`;
}

export function s3PublicCdnUrl(config: S3PublicUploadConfig, key: string): string {
  return `${config.cdnUrl.replace(/\/+$/u, "")}/${key.replace(/^\/+/u, "")}`;
}

export async function putS3PublicObject(
  config: S3PublicUploadConfig,
  input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly key: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: Date;
  },
): Promise<string> {
  const signed = createS3PresignedPost(config, input.key, input.now);
  const fileName = input.key.split("/").at(-1) ?? "reference.bin";
  const form = new FormData();
  for (const [name, value] of Object.entries(signed.fields)) {
    form.append(name, value);
  }
  form.append("file", new File([new Uint8Array(input.bytes)], fileName, {
    type: input.mediaType.length > 0 ? input.mediaType : "application/octet-stream",
  }));
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(signed.url, { method: "POST", body: form });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`S3 public upload returned HTTP ${response.status}${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  return s3PublicCdnUrl(config, input.key);
}
