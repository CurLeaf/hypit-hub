import assert from "node:assert/strict";
import test from "node:test";

import {
  buildH3ShotActionFallback,
  buildOfficialSpeakerSvml,
  measureH3ShotDuration,
  resolveH3ShotAction,
} from "../src/scaffold-ugc-speaker.js";
import type { ScenePlan } from "../src/scene-plan.js";

const capabilities = { fishSpeech: false, h3Video: true };

function scene(start: number, end: number, text: string, prompt = "Vertical product close-up"): ScenePlan {
  return {
    id: `scene-${start}`,
    momentId: `scene-${start}`,
    start,
    end,
    text,
    prompt,
  };
}

test("buildOfficialSpeakerSvml uses timeline-based 15s H3 duration per shot", () => {
  const scenes = [
    scene(0, 10, "第一段口播内容"),
    scene(10, 20, "第二段口播内容"),
  ];
  const result = buildOfficialSpeakerSvml({
    scenes,
    referenceDuration: 20,
    language: "zh",
    capabilities,
    voiceSampleText: "测试音色",
    voiceCastingDirection: "Bright promo voice",
    voiceAssetRel: "../assets/voice-reference.wav",
    productImageRef: "product-reference",
  });

  assert.match(result.generationBlock, /duration="15"/u);
  assert.match(result.generationBlock, /duration="5"/u);
  assert.doesNotMatch(result.generationBlock, /tts-master/u);
  assert.doesNotMatch(result.generationBlock, /-tts\.media/u);
  assert.match(result.semanticBlock, /media=\{shot_1-media\.media\}/u);
});

test("measureH3ShotDuration follows reference timeline slots", () => {
  assert.equal(measureH3ShotDuration({ durationSeconds: 15 }), 15);
  assert.equal(measureH3ShotDuration({ durationSeconds: 5 }), 5);
  assert.equal(measureH3ShotDuration({ durationSeconds: 3.2 }), 4);
});

test("buildOfficialSpeakerSvml wires reference image and audio for each H3 take", () => {
  const scenes = [scene(0, 8, "单段口播")];
  const result = buildOfficialSpeakerSvml({
    scenes,
    referenceDuration: 8,
    language: "zh",
    capabilities,
    voiceSampleText: "测试音色",
    voiceCastingDirection: "Bright promo voice",
    voiceAssetRel: "../assets/voice-reference.wav",
    productImageRef: "product-reference",
  });

  assert.match(result.generationBlock, /<h3:Reference image=\{product-reference\}\/>/u);
  assert.match(result.generationBlock, /<h3:Reference audio=\{presenter-voice\}\/>/u);
  assert.match(result.generationBlock, /h3-kit\.h3-ugc-replica-v1/u);
  assert.doesNotMatch(result.generationBlock, /h3-speaker-v1/u);
});

test("buildOfficialSpeakerSvml chains last-frame reference for follow-up shots", () => {
  const scenes = [
    scene(0, 15, "前半段"),
    scene(15, 20, "后半段"),
  ];
  const result = buildOfficialSpeakerSvml({
    scenes,
    referenceDuration: 20,
    language: "zh",
    capabilities,
    voiceSampleText: "测试音色",
    voiceCastingDirection: "Bright promo voice",
    voiceAssetRel: "../assets/voice-reference.wav",
    productImageRef: "product-reference",
  });

  assert.match(result.generationBlock, /<h3:Reference image=\{shot_1-last\.image\}\/>/u);
  assert.equal((result.generationBlock.match(/<h3:ReferenceVideo/gu) ?? []).length, 2);
  assert.match(result.semanticBlock, /whisperx:SemanticTake id="shot_1-semantic"/u);
  assert.match(result.semanticBlock, /whisperx:SemanticTake id="shot_2-semantic"/u);
  assert.match(result.timelineTakes, /source=\{shot_1-semantic\.take\}/u);
  assert.match(result.timelineTakes, /source=\{shot_2-semantic\.take\}/u);
});

test("resolveH3ShotAction falls back when action map contains Chinese", () => {
  const action = resolveH3ShotAction(
    { id: "shot_1", index: 0, scenePromptHint: "Close-up product demo" },
    new Map([["shot_1", "快节奏口播，前三秒抛出价格锚点。"]]),
  );
  assert.match(action, /lip-sync the supplied script/u);
  assert.doesNotMatch(action, /[\u4e00-\u9fff]/u);
});

test("resolveH3ShotAction prefers LLM English action map", () => {
  const action = resolveH3ShotAction(
    { id: "shot_1", index: 0, scenePromptHint: "Hands holding product in bright kitchen" },
    new Map([["shot_1", "Tight handheld framing with energetic hook delivery and clear product visibility."]]),
  );
  assert.match(action, /energetic hook delivery/u);
  assert.doesNotMatch(action, /[\u4e00-\u9fff]/u);
});

test("buildH3ShotActionFallback is English-only", () => {
  const action = buildH3ShotActionFallback({
    index: 0,
    scenePromptHint: "Close-up product demo on kitchen counter",
  });
  assert.match(action, /lip-sync the supplied script/u);
  assert.match(action, /Open with strong hook energy/u);
  assert.doesNotMatch(action, /[\u4e00-\u9fff]/u);
});
