import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductReferenceCatalog,
  inferProductReferencesFromShot,
  resolveH3ShotImageRefs,
} from "../src/h3-shot-reference.js";

const catalog = buildProductReferenceCatalog(
  ["product-reference", "product-reference-2", "product-reference-3"],
  ["吹风机", "包装正面", "倒奶挂壁"],
);

test("inferProductReferencesFromShot selects primary ref for product hero action", () => {
  const refs = inferProductReferencesFromShot({
    action: "Vertical 9:16 B-roll hero insert: the matte white hair dryer with the rose-gold ring stands upright on a marble counter.",
    scenePromptHint: "Product hero close-up",
    dialogue: "性价比直接拉满",
    catalog: catalog.slice(0, 1),
  });
  assert.deepEqual(refs, ["product-reference"]);
});

test("inferProductReferencesFromShot matches named refs from action and dialogue", () => {
  const packaging = inferProductReferencesFromShot({
    action: "Packaging label close-up with ingredient list readable in frame.",
    scenePromptHint: "Box detail insert",
    dialogue: "古法秘制配料表",
    catalog,
  });
  assert.deepEqual(packaging, ["product-reference-2"]);

  const pour = inferProductReferencesFromShot({
    action: "Pouring insert with thick liquid clinging to the glass.",
    scenePromptHint: "B-roll texture demo",
    dialogue: "倒出来能挂壁",
    catalog,
  });
  assert.deepEqual(pour, ["product-reference-3"]);
});

test("inferProductReferencesFromShot returns empty when shot has no product visibility", () => {
  const refs = inferProductReferencesFromShot({
    action: "Continue seamlessly from the prior clip with matching lighting and framing.",
    scenePromptHint: "Neutral studio backdrop, no props",
    dialogue: "别犹豫冲冲冲",
    catalog,
  });
  assert.deepEqual(refs, []);
});

test("resolveH3ShotImageRefs adds last-frame continuity after the first shot", () => {
  const first = resolveH3ShotImageRefs({
    index: 0,
    shotId: "shot_1",
    productRefs: ["product-reference"],
  });
  assert.deepEqual(first, ["product-reference"]);

  const second = resolveH3ShotImageRefs({
    index: 1,
    shotId: "shot_2",
    previousTakeId: "shot_1",
    productRefs: ["product-reference"],
  });
  assert.deepEqual(second, ["product-reference", "shot_1-last.image"]);
});

test("resolveH3ShotImageRefs ignores empty shotReferencePlan and falls back to primary product ref", () => {
  const fromHeuristic = resolveH3ShotImageRefs({
    index: 0,
    shotId: "shot_1",
    productRefs: ["product-reference"],
    shotReferencePlan: new Map([["shot_1", []]]),
  });
  assert.deepEqual(fromHeuristic, ["product-reference"]);

  const fromFallback = resolveH3ShotImageRefs({
    index: 0,
    shotId: "shot_1",
    productRefs: [],
    shotReferencePlan: new Map([["shot_1", []]]),
    fallbackProductRef: "product-reference",
  });
  assert.deepEqual(fromFallback, ["product-reference"]);
});
