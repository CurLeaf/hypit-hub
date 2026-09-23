import assert from "node:assert/strict";
import test from "node:test";

import {
  hasCommittedProductAdaptation,
  shouldInvalidateForDurationChange,
  shouldInvalidateForGoalChange,
} from "../src/product-adaptation-invalidation.js";
import type { AnalysisSessionView } from "../src/shared.js";

const directorReview = {
  status: "approved" as const,
  dir: "",
  requestPath: "",
  briefPath: "",
  treatmentPath: "",
  scenesPath: "",
  checklistPath: "",
  adaptationGoal: "旧产品说明",
};

function session(overrides: Partial<AnalysisSessionView> = {}): AnalysisSessionView {
  return {
    workspaceRoot: "/tmp",
    productReferencePath: "/tmp/product.png",
    adaptationGoal: "旧产品说明",
    directorReview,
    ...overrides,
  };
}

test("shouldInvalidateForGoalChange skips draft-stage goal edits", () => {
  const draft = session({ directorReview: undefined, adaptation: undefined });
  assert.equal(shouldInvalidateForGoalChange(draft, "", "新产品"), false);
});

test("shouldInvalidateForGoalChange invalidates after approval when goal changes", () => {
  assert.equal(
    shouldInvalidateForGoalChange(session(), "旧产品说明", "新产品说明"),
    true,
  );
});

test("shouldInvalidateForGoalChange ignores unchanged goal blur", () => {
  assert.equal(
    shouldInvalidateForGoalChange(session(), "旧产品说明", "旧产品说明"),
    false,
  );
});

test("shouldInvalidateForDurationChange invalidates after approval when duration changes", () => {
  assert.equal(
    shouldInvalidateForDurationChange(session(), 20, 45),
    true,
  );
  assert.equal(
    shouldInvalidateForDurationChange(session(), 20, 20),
    false,
  );
});

test("hasCommittedProductAdaptation detects approved review", () => {
  assert.equal(hasCommittedProductAdaptation(session()), true);
  assert.equal(hasCommittedProductAdaptation(session({ directorReview: undefined })), false);
});
