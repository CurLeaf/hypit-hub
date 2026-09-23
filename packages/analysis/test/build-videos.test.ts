import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildOutcome, collectBuildVideos, discoverBuildIds, syncAllBuildVideos, syncBuildVideos } from "../src/build-videos.js";
import { isFailedBuildStatus } from "../src/shared.js";
import { VideoRegistry } from "../src/video-registry.js";

const distributionRoot = resolve(import.meta.dirname, "../../..");
const workspace = resolve(distributionRoot, "examples/byok-openai-compatible");

test("buildOutcome treats missing outcome as building", () => {
  assert.equal(buildOutcome(undefined), "building");
  assert.equal(buildOutcome({ outcome: undefined } as never), "building");
  assert.equal(buildOutcome({ outcome: "complete" } as never), "complete");
});

test("isFailedBuildStatus ignores in-progress builds", () => {
  assert.equal(isFailedBuildStatus("building"), false);
  assert.equal(isFailedBuildStatus("complete"), false);
  assert.equal(isFailedBuildStatus("partial"), true);
  assert.equal(isFailedBuildStatus("failed"), true);
});

test("collectBuildVideos returns mp4 artifacts from a finished build", async () => {
  const videos = await collectBuildVideos(workspace, "bld_20260921T101923719Z_970A846811");
  assert.ok(videos.length >= 2);
  assert.ok(videos.every((video) => video.mediaType === "video/mp4"));
  assert.ok(videos.every((video) => video.path.endsWith(".mp4")));
});

test("discoverBuildIds finds builds with model outputs", async () => {
  const buildIds = await discoverBuildIds(workspace);
  assert.ok(buildIds.length >= 1);
  assert.ok(buildIds.some((id) => id.startsWith("bld_")));
});

test("syncAllBuildVideos indexes every build into the registry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-video-sync-"));
  try {
    const registry = new VideoRegistry(directory);
    await syncAllBuildVideos(workspace, registry);
    const stats = registry.stats();
    assert.ok(stats.totalVideos >= 2);
    assert.ok(stats.totalBuilds >= 1);
    assert.ok(registry.listAll().length >= 2);
    registry.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("video registry stats ignore missing files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-video-prune-"));
  try {
    const registry = new VideoRegistry(directory);
    registry.syncBuildVideos("bld_missing", [{
      name: "ghost",
      path: join(directory, "missing.mp4"),
      mediaType: "video/mp4",
    }], "error");
    assert.equal(registry.stats().totalVideos, 0);
    registry.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("syncBuildVideos updates a single build without waiting for full sync ttl", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-video-single-"));
  try {
    const registry = new VideoRegistry(directory);
    const videos = await syncBuildVideos(
      workspace,
      "bld_20260921T101923719Z_970A846811",
      registry,
      "error",
    );
    assert.ok(videos.length >= 2);
    assert.equal(registry.listForBuild("bld_20260921T101923719Z_970A846811").length, videos.length);
    registry.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("video registry stores generated videos and reports totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-video-registry-"));
  try {
    const videos = await collectBuildVideos(workspace, "bld_20260921T101923719Z_970A846811");
    const registry = new VideoRegistry(directory);
    registry.syncBuildVideos("bld_test", videos.slice(0, 1), "error");
    registry.syncBuildVideos("bld_test", videos, "error");
    const stats = registry.stats();
    assert.equal(stats.totalVideos, videos.length);
    assert.equal(stats.totalBuilds, 1);
    assert.equal(registry.listForBuild("bld_test").length, videos.length);
    registry.close();
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
});
