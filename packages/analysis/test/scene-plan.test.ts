import assert from "node:assert/strict";
import test from "node:test";

import { assignScenePrompts, type ScenePlan } from "../src/scene-plan.js";

function scene(momentId: string): ScenePlan {
  return {
    id: momentId,
    start: 0,
    end: 1,
    text: "口播",
    momentId,
    prompt: "default",
  };
}

test("assignScenePrompts prefers exact moment ids", () => {
  const map = assignScenePrompts(
    [scene("segment-1")],
    { "segment-1": "exact", "scene-1": "wrong" },
  );
  assert.equal(map.get("segment-1"), "exact");
});

test("assignScenePrompts accepts scene-N keys for segment ids", () => {
  const map = assignScenePrompts(
    [scene("segment-1")],
    { "scene-1": "A presenter showing a hair dryer in a bright bathroom." },
  );
  assert.equal(map.get("segment-1")?.includes("hair dryer"), true);
});

test("assignScenePrompts uses the sole string value for a single scene", () => {
  const map = assignScenePrompts(
    [scene("segment-1")],
    { shot: "Close-up of a ring-shaped hair dryer standing on a table." },
  );
  assert.match(map.get("segment-1") ?? "", /hair dryer/u);
});
