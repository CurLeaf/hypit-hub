import assert from "node:assert/strict";
import test from "node:test";

import { buildAdaptationScenes, selectAdaptationBoundaries } from "../src/scenes-from-structure.js";
import type { AnalysisSessionView, ViralInsightView } from "../src/shared.js";

const insight: ViralInsightView = {
  summary: "测试",
  whyViral: [],
  howItWorks: [],
  hookAnalysis: "Hook",
  replicationTips: [],
};

test("selectAdaptationBoundaries caps noisy frame-level cuts", () => {
  const cuts = Array.from({ length: 40 }, (_, index) => ({ at: index * 0.5, score: 0.1 + index * 0.01 }));
  assert.ok(selectAdaptationBoundaries(cuts).length <= 7);
});

test("buildAdaptationScenes uses key visual cuts instead of one speech segment", () => {
  const session: AnalysisSessionView = {
    workspaceRoot: ".",
    probe: { duration: 20, width: 720, height: 1280, frameRate: 30, hasAudio: true },
    boundaries: [
      { at: 2.6, score: 0.35 },
      { at: 4.3, score: 0.4 },
      { at: 7.0, score: 0.3 },
      { at: 10.0, score: 0.45 },
      { at: 13.0, score: 0.25 },
      { at: 15.1, score: 0.28 },
      { at: 17.4, score: 0.22 },
      { at: 2.7, score: 0.12 },
      { at: 2.8, score: 0.11 },
    ],
    segments: [{ id: "segment-1", label: "段落 1", start: 0, end: 20, text: "整段口播", wordCount: 4 }],
    transcript: {
      language: "zh",
      passages: [],
      words: [
        { text: "前", start: 0, end: 1 },
        { text: "后", start: 12, end: 13 },
      ],
    },
  };
  const scenes = buildAdaptationScenes(session, insight);
  assert.ok(scenes.length >= 3);
  assert.ok(scenes.length <= 8);
  assert.equal(scenes[0]?.momentId, "scene-1");
});
