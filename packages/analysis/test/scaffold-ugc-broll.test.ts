import assert from "node:assert/strict";
import test from "node:test";

import { fitsH3Duration, measureSegmentSeconds } from "../src/measure-segments.js";
import {
  buildOfficialSpeakerSvml,
  packScenesForH3,
  selectSpeakingScenes,
  splitSpokenTextForH3,
} from "../src/scaffold-ugc-speaker.js";
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

test("splitSpokenTextForH3 keeps a short passage as one take", () => {
  assert.deepEqual(splitSpokenTextForH3("用了一个月才敢分享", "zh"), ["用了一个月才敢分享"]);
});

test("packScenesForH3 splits over-long copy into sequential H3 takes", () => {
  const text = "用了一个月才敢分享的高速吹风机中空涵道强劲风力不伤发丝低噪护发冷热循环恒温".repeat(4);
  assert.equal(fitsH3Duration(text, "zh"), false);
  const packed = packScenesForH3([scene("segment-1", text)], "zh");
  assert.ok(packed.length >= 2);
  assert.equal(packed.map((item) => item.text).join(""), text);
  for (const item of packed) {
    assert.equal(fitsH3Duration(item.text, "zh"), true);
    assert.ok(measureSegmentSeconds(item.text, "zh") <= 15);
  }
  assert.equal(packed[0]?.id, "segment-1-t1");
  assert.equal(packed[1]?.id, "segment-1-t2");
});

test("buildOfficialSpeakerSvml emits one H3 take per packed scene and fuses them on the timeline", () => {
  const text = "用了一个月才敢分享的高速吹风机中空涵道强劲风力不伤发丝低噪护发冷热循环恒温".repeat(4);
  const official = buildOfficialSpeakerSvml({
    scenes: [scene("segment-1", text)],
    language: "zh",
    capabilities: { fishSpeech: false, h3Video: true },
    voiceSampleText: "用了一个月才敢分享",
    voiceCastingDirection: "clear presenter",
    voiceAssetRel: "../assets/voice-reference.wav",
    productImageRef: "product-reference",
  });
  const videos = official.generationBlock.match(/<h3:ReferenceVideo/gu) ?? [];
  const takes = official.timelineTakes.match(/<time:Take /gu) ?? [];
  assert.ok(videos.length >= 2);
  assert.equal(takes.length, videos.length);
  assert.match(official.generationBlock, /id="segment_1_t1-take"/u);
  assert.match(official.timelineTakes, /source=\{segment_1_t1-semantic\.take\}/u);
  assert.match(official.timelineTakes, /source=\{segment_1_t2-semantic\.take\}/u);
  assert.equal(official.scriptBody.includes("</HOST>"), false);
  for (const match of official.generationBlock.matchAll(/duration="(\d+)"/gu)) {
    const duration = Number(match[1]);
    assert.ok(duration >= 4 && duration <= 15, `duration ${duration}`);
  }
});
