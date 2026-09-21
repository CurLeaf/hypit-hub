import assert from "node:assert/strict";
import test from "node:test";

import {
  createS3PresignedPost,
  putS3PublicObject,
  s3PublicCdnUrl,
  s3PublicObjectKey,
  s3PublicUploadConfigFromEnv,
} from "../src/s3-public-upload.js";

const config = {
  endpoint: "https://bucket.s3.oss-cn-hangzhou.aliyuncs.com",
  accessKeyId: "id",
  accessKeySecret: "secret",
  bucketName: "bucket",
  region: "cn-hangzhou",
  cdnUrl: "https://cdn.example",
  keyPrefix: "hypit/references",
} as const;

test("S3 public upload reads the same env names as erp-admin-demo-1", () => {
  assert.equal(s3PublicUploadConfigFromEnv({}), undefined);
  const loaded = s3PublicUploadConfigFromEnv({
    S3_ENDPOINT: "https://bucket.s3.oss-cn-hangzhou.aliyuncs.com",
    S3_ACCESS_KEY_ID: "id",
    S3_SECRET_ACCESS_KEY: "secret",
    S3_BUCKET_NAME: "bucket",
    S3_REGION: "cn-hangzhou",
    S3_CDN: "https://cdn.example",
  });
  assert.equal(loaded?.bucketName, "bucket");
  assert.equal(loaded?.cdnUrl, "https://cdn.example");
  assert.throws(
    () => s3PublicUploadConfigFromEnv({ S3_ENDPOINT: "https://oss.example" }),
    /S3 public upload needs/u,
  );
});

test("S3 presigned POST is public-read and posts to the configured endpoint", () => {
  const signed = createS3PresignedPost(config, "hypit/references/a.png", new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(signed.url, "https://bucket.s3.oss-cn-hangzhou.aliyuncs.com");
  assert.equal(signed.fields.key, "hypit/references/a.png");
  assert.equal(signed.fields.acl, "public-read");
  assert.equal(signed.fields["x-amz-algorithm"], "AWS4-HMAC-SHA256");
  assert.match(signed.fields.policy, /^[A-Za-z0-9+/=]+$/u);
  assert.match(signed.fields["x-amz-signature"], /^[a-f0-9]{64}$/u);
});

test("S3 public object upload returns the CDN URL MiniMax can fetch", async () => {
  const key = s3PublicObjectKey(config, "image/png", "ref-1");
  assert.equal(key, "hypit/references/ref-1.png");
  assert.equal(s3PublicCdnUrl(config, key), "https://cdn.example/hypit/references/ref-1.png");
  const url = await putS3PublicObject(config, {
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
    key,
    fetch: async (input, init) => {
      assert.equal(String(input), "https://bucket.s3.oss-cn-hangzhou.aliyuncs.com");
      assert.equal(init?.method, "POST");
      assert.ok(init?.body instanceof FormData);
      const body = init.body;
      assert.equal(body.get("key"), key);
      assert.equal(body.get("acl"), "public-read");
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(url, "https://cdn.example/hypit/references/ref-1.png");
});
