import assert from "node:assert/strict";
import test from "node:test";

import { buildInsightFromSession } from "../src/insight-builder.ts";
import { joinTranscriptText, normalizeTranscriptText, transcriptSnippetAt } from "../src/transcript-text.ts";

test("joinTranscriptText merges spaced Chinese characters", () => {
  const words = [{ text: "群" }, { text: "星" }, { text: "云" }];
  assert.equal(joinTranscriptText(words), "群星云");
});

test("joinTranscriptText keeps spaces for English tokens", () => {
  const words = [{ text: "Hello" }, { text: "world" }];
  assert.equal(joinTranscriptText(words), "Hello world");
});

test("normalizeTranscriptText compacts spaced Chinese", () => {
  assert.equal(normalizeTranscriptText("群 星 云 重 磅"), "群星云重磅");
});

test("transcriptSnippetAt uses a time window around the cut", () => {
  const words = [
    { text: "张", start: 6.3, end: 6.5 },
    { text: "口", start: 6.6, end: 6.8 },
    { text: "就", start: 6.8, end: 7.0 },
    { text: "来", start: 7.0, end: 7.5 },
    { text: "不", start: 7.6, end: 7.7 },
    { text: "满", start: 7.7, end: 7.8 },
    { text: "意", start: 7.8, end: 8.3 },
    { text: "直", start: 8.3, end: 8.5 },
    { text: "接", start: 8.5, end: 8.7 },
    { text: "喊", start: 8.7, end: 9.2 },
  ];
  const snippet = transcriptSnippetAt(words, 8.1, 1.2);
  assert.match(snippet, /不满意/);
  assert.match(snippet, /直接喊/);
});

test("buildInsightFromSession avoids legacy template phrasing", () => {
  const words = [
    { text: "群", start: 0.2, end: 0.4 },
    { text: "星", start: 0.4, end: 0.6 },
    { text: "云", start: 0.6, end: 1.0 },
    { text: "重", start: 1.0, end: 1.2 },
    { text: "磅", start: 1.2, end: 1.4 },
    { text: "发", start: 1.4, end: 1.6 },
    { text: "布", start: 1.6, end: 2.0 },
    { text: "星", start: 2.2, end: 2.5 },
    { text: "图", start: 2.5, end: 2.8 },
    { text: "2", start: 2.8, end: 3.0 },
    { text: "2", start: 3.0, end: 3.2 },
    { text: "0", start: 3.2, end: 3.7 },
    { text: "不", start: 7.6, end: 7.7 },
    { text: "满", start: 7.7, end: 7.8 },
    { text: "意", start: 7.8, end: 8.3 },
    { text: "直", start: 8.3, end: 8.5 },
    { text: "接", end: 8.7, start: 8.5 },
    { text: "喊", start: 8.7, end: 9.2 },
    { text: "改", start: 9.8, end: 10.2 },
    { text: "到", start: 10.4, end: 10.5 },
    { text: "满", start: 10.5, end: 10.7 },
    { text: "意", start: 10.7, end: 10.9 },
  ];
  const script = joinTranscriptText(words);
  const insight = buildInsightFromSession({
    workspaceRoot: "/tmp",
    videoName: "demo.mp4",
    probe: { width: 768, height: 1344, duration: 15, frameRate: 30, hasAudio: true },
    transcript: { language: "zh", passages: [{ text: script, words }], words },
    boundaries: [{ at: 3.5, score: 0.9 }, { at: 8.1, score: 0.95 }],
    segments: [{
      id: "segment-1",
      label: "段落 1",
      start: 0.2,
      end: 14.8,
      text: script,
      wordCount: words.length,
    }],
    events: [
      { id: "hook", kind: "hook", at: 0, end: 5, title: "开场 Hook", detail: "群星云重磅发布星图220" },
      { id: "moment-1", kind: "moment", at: 8.1, title: "高冲击 Moment 1", detail: "" },
    ],
    formats: [{
      id: "explainer",
      title: "讲解 / 产品说明",
      confidence: "high",
      reason: "产品功能讲解",
      example: "examples/complex-explainer/productions/explainer/",
    }],
  });

  assert.equal(insight.whyViral.length, 4);
  assert.match(insight.summary, /产品发布/);
  assert.doesNotMatch(insight.summary, /以口播\+画面变化驱动信息传递/);
  assert.doesNotMatch(JSON.stringify(insight), /约 \d+ 个词分布在/);
  assert.ok(insight.whyViral.some((item) => item.title === "提前化解使用顾虑"));
});
