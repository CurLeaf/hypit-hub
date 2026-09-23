import assert from "node:assert/strict";
import test from "node:test";

import { mergeWorkflowState, workflowStateFromSession } from "../src/workflow.js";

test("workflow persistence omits runtime-only generated video fields", () => {
  const state = workflowStateFromSession({
    workspaceRoot: "/tmp/workspace",
    build: {
      id: "bld_test",
      status: "error",
      generatedVideoCount: 2,
      generatedVideos: [{
        name: "shot_1-take.video",
        path: "/tmp/workspace/.hypit/results/files/file-0001.mp4",
        mediaType: "video/mp4",
      }],
    },
  });
  assert.equal(state.build?.id, "bld_test");
  assert.equal(state.build?.generatedVideoCount, undefined);
  assert.equal(state.build?.generatedVideos, undefined);
});

test("cold start restores the persisted workflow when the in-memory session has no video", () => {
  const merged = mergeWorkflowState(
    { workspaceRoot: "/tmp/workspace" },
    {
      videoPath: "/tmp/workspace/reference.mp4",
      build: { id: "bld_test", status: "error", phase: "Build 失败" },
    },
  );
  assert.equal(merged.videoPath, "/tmp/workspace/reference.mp4");
  assert.equal(merged.build?.id, "bld_test");
});

test("a different in-memory video does not pick up another workflow", () => {
  const merged = mergeWorkflowState(
    { workspaceRoot: "/tmp/workspace", videoPath: "/tmp/workspace/new.mp4" },
    { videoPath: "/tmp/workspace/reference.mp4", build: { id: "bld_old", status: "error" } },
  );
  assert.equal(merged.videoPath, "/tmp/workspace/new.mp4");
  assert.equal(merged.build, undefined);
});
