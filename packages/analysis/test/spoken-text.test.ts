import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeAdjacentSceneTexts,
  mergeSpokenSceneTexts,
  normalizeSpokenChinese,
  spokenTextOverlap,
  toSimplifiedChinese,
} from "../src/spoken-text.js";

test("spokenTextOverlap finds shared boundary characters", () => {
  assert.equal(spokenTextOverlap("護髮吹風機", "機創新HCR"), 1);
  assert.equal(spokenTextOverlap("立住髮根髮", "髮絲均勻"), 1);
  assert.equal(spokenTextOverlap("柔順合金", "金聚熱環"), 1);
});

test("mergeSpokenSceneTexts removes cut-boundary duplicates", () => {
  const merged = mergeSpokenSceneTexts([
    "用了三個月吹了好幾次才敢分享的護髮吹風機",
    "機創新HCR聚熱環出風就能立住髮根髮",
    "髮絲均勻受熱不會乾枯毛躁就柔順合金",
    "金聚熱環結構出風穩定不傷髮質吹",
  ]);
  assert.equal(
    merged,
    "用了三個月吹了好幾次才敢分享的護髮吹風機創新HCR聚熱環出風就能立住髮根髮絲均勻受熱不會乾枯毛躁就柔順合金聚熱環結構出風穩定不傷髮質吹",
  );
});

test("dedupeAdjacentSceneTexts keeps non-overlapping scene fragments", () => {
  const scenes = dedupeAdjacentSceneTexts([
    { id: "scene-1", text: "護髮吹風機" },
    { id: "scene-2", text: "機創新HCR" },
    { id: "scene-3", text: "HCR聚熱環" },
  ]);
  assert.deepEqual(scenes.map((scene) => scene.text), ["護髮吹風機", "創新HCR", "聚熱環"]);
});

test("toSimplifiedChinese converts traditional copy", () => {
  assert.equal(
    toSimplifiedChinese("用了三個月吹了好幾次才敢分享的護髮吹風機"),
    "用了三个月吹了好几次才敢分享的护发吹风机",
  );
});

test("normalizeSpokenChinese compacts whitespace and simplifies", () => {
  assert.equal(
    normalizeSpokenChinese("  護髮 吹風機 \n"),
    "护发吹风机",
  );
});
