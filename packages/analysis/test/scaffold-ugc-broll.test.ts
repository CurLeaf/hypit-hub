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

function scene(id: string, text: string, start = 0, end = 1): ScenePlan {
  return {
    id,
    momentId: id,
    start,
    end,
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

test("buildOfficialSpeakerSvml splits long references into 15s timeline shots with last-frame chain", () => {
  const text = "用了一个月才敢分享的高速吹风机中空涵道强劲风力不伤发丝低噪护发冷热循环恒温".repeat(4);
  const official = buildOfficialSpeakerSvml({
    scenes: [scene("segment-1", text, 0, 32)],
    referenceDuration: 32,
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
  assert.match(official.generationBlock, /duration="15"/u);
  assert.match(official.generationBlock, /<h3:Reference image=\{shot_1-last\.image\}\/>/u);
  assert.match(official.generationBlock, /ExtractFrame id="shot_1-last"/u);
  assert.equal(official.scriptBody.includes("</HOST>"), false);
  for (const match of official.generationBlock.matchAll(/duration="(\d+)"/gu)) {
    const duration = Number(match[1]);
    assert.ok(duration >= 4 && duration <= 15, `duration ${duration}`);
  }
});
