import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { DEFAULT_VIDEO_OBJECT_KEY, materializeDefaultVideo, resolveDefaultVideoUrl } from "../src/default-video.js";

test("resolveDefaultVideoUrl prefers an explicit default over S3_CDN", () => {
  assert.equal(resolveDefaultVideoUrl({}), undefined);
  assert.equal(
    resolveDefaultVideoUrl({ S3_CDN: "http://cdn.example" }),
    `http://cdn.example/${DEFAULT_VIDEO_OBJECT_KEY}`,
  );
  assert.equal(
    resolveDefaultVideoUrl({
      S3_CDN: "http://cdn.example/",
      HYPIT_DEFAULT_VIDEO_URL: "https://cdn.example/origin.mp4",
    }),
    "https://cdn.example/origin.mp4",
  );
});

test("materializeDefaultVideo fetches the origin URL then imports the file", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hypit-default-video-"));
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => new Response(Buffer.from("remote-origin"), { status: 200 })) as typeof fetch;
  try {
    const target = await materializeDefaultVideo({
      url: "http://cdn.example/hypit/default/origin.mp4",
      workspaceRoot: workspace,
    });
    assert.equal(basename(target).endsWith("origin.mp4"), true);
    assert.equal(await readFile(target, "utf8"), "remote-origin");
  } finally {
    globalThis.fetch = previous;
    await rm(workspace, { recursive: true, force: true });
  }
});

test("materializeDefaultVideo falls back to a local origin file when the CDN is unreachable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "hypit-default-video-"));
  const local = join(workspace, "origin.mp4");
  await writeFile(local, "local-origin");
  const previous = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const target = await materializeDefaultVideo({
      url: "http://cdn.example/hypit/default/origin.mp4",
      workspaceRoot: workspace,
      localFallback: local,
    });
    assert.equal(await readFile(target, "utf8"), "local-origin");
  } finally {
    globalThis.fetch = previous;
    await rm(workspace, { recursive: true, force: true });
  }
});
