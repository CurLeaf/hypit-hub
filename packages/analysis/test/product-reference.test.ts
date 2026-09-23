import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptationMatchesReference,
  countProductReferenceAssets,
  hasProductReferenceBindings,
  maxProductReferenceImages,
  normalizeProductReferences,
  productReferenceAssetId,
  productReferenceSessionUpdate,
} from "../src/product-reference.js";

test("normalizeProductReferences prefers arrays and falls back to legacy single path", () => {
  assert.deepEqual(
    normalizeProductReferences({
      productReferencePaths: ["/tmp/a.png", "/tmp/b.png"],
      productReferenceNames: ["产品", "包装"],
    }),
    { paths: ["/tmp/a.png", "/tmp/b.png"], names: ["产品", "包装"] },
  );
  assert.deepEqual(
    normalizeProductReferences({ productReferencePath: "/tmp/legacy.jpg", productReferenceName: "旧图" }),
    { paths: ["/tmp/legacy.jpg"], names: ["旧图"] },
  );
  assert.deepEqual(
    normalizeProductReferences({ productReferencePaths: [], productReferencePath: "/tmp/legacy.jpg" }),
    { paths: ["/tmp/legacy.jpg"], names: ["legacy.jpg"] },
  );
});

test("maxProductReferenceImages follows H3 and GPT limits", () => {
  assert.equal(maxProductReferenceImages({ videoAroll: true }), 9);
  assert.equal(maxProductReferenceImages({ videoAroll: false }), 16);
  assert.equal(maxProductReferenceImages({}), 9);
});

test("hasProductReferenceBindings validates multi-image svml", () => {
  const svml = `
    <asset:Image id="product-reference" src="../assets/product-reference.jpg"/>
    <asset:Image id="product-reference-2" src="../assets/product-reference-2.jpg"/>
    <gpt:Reference image={product-reference}/>
    <h3:Reference image={product-reference-2}/>
  `;
  assert.equal(countProductReferenceAssets(svml), 2);
  assert.equal(hasProductReferenceBindings(svml, 2), true);
});

test("productReferenceAssetId keeps single-image id stable", () => {
  assert.equal(productReferenceAssetId(0), "product-reference");
  assert.equal(productReferenceAssetId(1), "product-reference-2");
});

test("adaptationMatchesReference compares full source lists", () => {
  const adaptation = {
    status: "complete" as const,
    productReferenceSources: ["/tmp/a.png", "/tmp/b.png"],
  };
  assert.equal(adaptationMatchesReference(adaptation, ["/tmp/a.png", "/tmp/b.png"]), true);
  assert.equal(adaptationMatchesReference(adaptation, ["/tmp/a.png"]), false);
  assert.equal(
    adaptationMatchesReference({ status: "complete", productReferenceSource: "/tmp/a.png" }, ["/tmp/a.png"]),
    true,
  );
});

test("productReferenceSessionUpdate mirrors first image into legacy fields", () => {
  assert.deepEqual(
    productReferenceSessionUpdate(["/tmp/a.png", "/tmp/b.png"], ["A", "B"]),
    {
      productReferencePaths: ["/tmp/a.png", "/tmp/b.png"],
      productReferenceNames: ["A", "B"],
      productReferencePath: "/tmp/a.png",
      productReferenceName: "A",
    },
  );
});
