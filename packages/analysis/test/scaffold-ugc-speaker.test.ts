import assert from "node:assert/strict";
import test from "node:test";

import {
  buildH3ShotActionFallback,
  buildOfficialSpeakerSvml,
  measureH3ShotDuration,
  refineShotsForH3Speech,
  resolveH3ShotAction,
  selectH3Shots,
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

test("buildOfficialSpeakerSvml chains product and last-frame references for follow-up shots", () => {
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

  const shot2Block = result.generationBlock.split('id="shot_2-take"')[1] ?? "";
  assert.match(shot2Block, /<h3:Reference image=\{product-reference\}\/>/u);
  assert.match(shot2Block, /<h3:Reference image=\{shot_1-last\.image\}\/>/u);
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

test("refineShotsForH3Speech splits over-long dialogue into multiple H3 takes", () => {
  const longText = "穿了三个月通勤周末都穿才敢分享的叠穿套装，大口袋工装夹克机能感直接拉满，军绿配色白内搭怎么搭都好看，内外层次已经配好不用自己凑，松紧收口廓形上身有余量省心又好搭，三百多的价格性价比直接拉满，但上身好看又有型兄弟们别犹豫，夹克单穿周末出街冲冲冲";
  const timelineShots = [{
    id: "shot_1",
    index: 0,
    start: 0,
    end: 45,
    durationSeconds: 45,
    text: longText,
    scenePromptHint: "Vertical product demo",
    scenes: [scene(0, 45, longText)],
  }];
  const refined = refineShotsForH3Speech(timelineShots, "zh");
  assert.ok(refined.length >= 2);
  for (const shot of refined) {
    assert.ok(shot.durationSeconds >= 4 && shot.durationSeconds <= 15);
    assert.ok(shot.text.length > 0);
  }
});

test("selectH3Shots aligns take durations with speech estimates for long targets", () => {
  const longText = "穿了三个月通勤周末都穿才敢分享的叠穿套装，大口袋工装夹克机能感直接拉满，军绿配色白内搭怎么搭都好看，内外层次已经配好不用自己凑，松紧收口廓形上身有余量省心又好搭";
  const { shots } = selectH3Shots([scene(0, 45, longText)], 45, "zh");
  assert.ok(shots.length >= 2);
  assert.ok(shots.every((shot) => shot.durationSeconds >= 4 && shot.durationSeconds <= 15));
});
