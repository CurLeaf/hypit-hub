import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficialSpeakerSvml, MAX_H3_TAKES, selectH3Shots } from "../src/scaffold-ugc-speaker.js";
import type { ScenePlan } from "../src/scene-plan.js";

const replicaScenes: readonly ScenePlan[] = [
  { id: "scene-1", momentId: "scene-1", start: 0, end: 2.667, text: "用了两个月天天吹才敢分享的高速护发吹风机", prompt: "p1" },
  { id: "scene-2", momentId: "scene-2", start: 2.667, end: 4.333, text: "机搭载HCR合金聚热环恒温出风", prompt: "p2" },
  { id: "scene-3", momentId: "scene-3", start: 4.333, end: 7, text: "风均匀不忽高忽低吹完不炸毛", prompt: "p3" },
  { id: "scene-4", momentId: "scene-4", start: 7, end: 10.167, text: "毛合金聚热环结构气流加温更均匀", prompt: "p4" },
  { id: "scene-5", momentId: "scene-5", start: 10.167, end: 11.833, text: "匀高速电机快干又护发很省心", prompt: "p5" },
  { id: "scene-6", momentId: "scene-6", start: 11.833, end: 15.167, text: "心强韧发根防脱三百多性价比拉满", prompt: "p6" },
  { id: "scene-7", momentId: "scene-7", start: 15.167, end: 17.5, text: "满但吹完顺滑又有型姐妹们别犹豫", prompt: "p7" },
  { id: "scene-8", momentId: "scene-8", start: 17.5, end: 20.667, text: "豫还能当造型风嘴日常冲冲冲", prompt: "p8" },
];

test("buildOfficialSpeakerSvml emits timeline shot structure for 21s replica", () => {
  const official = buildOfficialSpeakerSvml({
    scenes: replicaScenes,
    referenceDuration: 21,
    language: "zh",
    capabilities: { fishSpeech: false, h3Video: true },
    voiceSampleText: replicaScenes[0]!.text,
    voiceCastingDirection: "clear presenter",
    voiceAssetRel: "../assets/voice-reference.wav",
    productImageRef: "product-reference",
  });

  assert.match(official.generationBlock, /id="shot_1-take"/u);
  assert.match(official.generationBlock, /id="shot_2-take"/u);
  assert.match(official.generationBlock, /h3-kit\.h3-ugc-replica-v1/u);
  assert.match(official.generationBlock, /duration="15"/u);
  assert.match(official.generationBlock, /duration="6"/u);
  assert.match(official.generationBlock, /<h3:Reference image=\{shot_1-last\.image\}\/>/u);
  assert.match(official.generationBlock, /ExtractFrame id="shot_1-last"/u);
  assert.doesNotMatch(official.generationBlock, /scene_\d+-take/u);
  assert.doesNotMatch(official.generationBlock, /speaker-kit\.speaker-v1/u);
  assert.equal(official.h3ShotPlan.takeCount, 2);
  assert.equal(official.h3ShotPlan.truncated, false);
});

test("selectH3Shots truncates very long references at MAX_H3_TAKES", () => {
  const longScene: ScenePlan = {
    id: "scene-long",
    momentId: "scene-long",
    start: 0,
    end: 240,
    text: "长口播".repeat(200),
    prompt: "prompt",
  };
  const plan = selectH3Shots([longScene], 240);
  assert.equal(plan.plannedTakeCount, 16);
  assert.equal(plan.shots.length, MAX_H3_TAKES);
  assert.equal(plan.truncated, true);
});
