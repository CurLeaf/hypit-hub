import assert from "node:assert/strict";
import test from "node:test";

import { parseS3ForcePathStyle, resolveS3ReferenceUploadConfig } from "../src/s3-upload.js";

const envKeys = [
  "S3_BUCKET_NAME",
  "S3_REGION",
  "S3_ENDPOINT",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_CDN",
  "S3_FORCE_PATH_STYLE",
] as const;

function withEnv(values: Partial<Record<typeof envKeys[number], string>>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of envKeys) saved.set(key, process.env[key]);
  for (const key of envKeys) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const key of envKeys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("parseS3ForcePathStyle defaults to virtual-hosted style", () => {
  assert.equal(parseS3ForcePathStyle(undefined), false);
  assert.equal(parseS3ForcePathStyle(""), false);
  assert.equal(parseS3ForcePathStyle("false"), false);
  assert.equal(parseS3ForcePathStyle("true"), true);
});

test("resolveS3ReferenceUploadConfig validates all required env before upload", () => {
  withEnv({
    S3_BUCKET_NAME: "fixture",
    S3_REGION: "cn-hangzhou",
    S3_ENDPOINT: "https://fixture.s3.oss-cn-hangzhou.aliyuncs.com",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_FORCE_PATH_STYLE: "false",
  }, () => {
    assert.throws(() => resolveS3ReferenceUploadConfig(), /S3_CDN/u);
  });
});

test("resolveS3ReferenceUploadConfig normalizes CDN and forcePathStyle", () => {
  withEnv({
    S3_BUCKET_NAME: "fixture",
    S3_REGION: "cn-hangzhou",
    S3_ENDPOINT: "https://fixture.s3.oss-cn-hangzhou.aliyuncs.com",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_CDN: "https://cdn.example.com/",
    S3_FORCE_PATH_STYLE: "true",
  }, () => {
    const config = resolveS3ReferenceUploadConfig();
    assert.equal(config.cdn, "https://cdn.example.com");
    assert.equal(config.forcePathStyle, true);
  });
});
