import assert from "node:assert/strict";
import test from "node:test";

import { selectSpeakingScenes } from "../src/scaffold-ugc-speaker.js";
import type { ScenePlan } from "../src/scene-plan.js";

function scene(id: string, text: string): ScenePlan {
  return {
    id,
    momentId: id,
    start: 0,
    end: 1,
    text,
    prompt: "prompt",
  };
}

test("selectSpeakingScenes keeps all segments up to the soft cap", () => {
  const scenes = Array.from({ length: 8 }, (_, index) => scene(`segment-${index + 1}`, `口播段落${index + 1}`));
  assert.equal(selectSpeakingScenes(scenes).length, 8);
});

test("selectSpeakingScenes skips silent scenes", () => {
  const scenes = [
    scene("segment-1", "有口播"),
    scene("segment-2", "   "),
    scene("segment-3", "也有口播"),
  ];
  assert.deepEqual(
    selectSpeakingScenes(scenes).map((item) => item.id),
    ["segment-1", "segment-3"],
  );
});
