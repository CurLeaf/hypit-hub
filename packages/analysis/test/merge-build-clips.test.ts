import assert from "node:assert/strict";
import test from "node:test";

import { formatConcatListPath, selectMergeClips } from "../src/merge-build-clips.js";

test("selectMergeClips orders shot takes and ignores final and file duplicates", () => {
  const clips = selectMergeClips([
    { name: "final.video", path: "/tmp/final.mp4", mediaType: "video/mp4" },
    { name: "file-0002", path: "/tmp/file-0002.mp4", mediaType: "video/mp4" },
    { name: "shot_2-take.video", path: "/tmp/shot2.mp4", mediaType: "video/mp4" },
    { name: "shot_1-take.video", path: "/tmp/shot1.mp4", mediaType: "video/mp4" },
  ]);
  assert.deepEqual(clips.map((clip) => clip.name), [
    "shot_1-take.video",
    "shot_2-take.video",
  ]);
});

test("selectMergeClips orders scene takes numerically", () => {
  const clips = selectMergeClips([
    { name: "scene_8-take.video", path: "/tmp/s8.mp4", mediaType: "video/mp4" },
    { name: "scene_2-take.video", path: "/tmp/s2.mp4", mediaType: "video/mp4" },
    { name: "scene_1-take.video", path: "/tmp/s1.mp4", mediaType: "video/mp4" },
  ]);
  assert.deepEqual(clips.map((clip) => clip.name), [
    "scene_1-take.video",
    "scene_2-take.video",
    "scene_8-take.video",
  ]);
});

test("formatConcatListPath normalizes Windows paths for ffmpeg concat", () => {
  assert.equal(
    formatConcatListPath(String.raw`D:\hypit\examples\byok\take.mp4`),
    "D:/hypit/examples/byok/take.mp4",
  );
  assert.equal(
    formatConcatListPath("/tmp/it's fine.mp4"),
    "/tmp/it'\\''s fine.mp4",
  );
});
