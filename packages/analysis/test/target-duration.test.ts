import assert from "node:assert/strict";
import test from "node:test";

import {
  clampTargetDurationSeconds,
  defaultTargetDurationSeconds,
  formatH3TakePlan,
  planH3TakeDurations,
  resolveH3ReferenceDuration,
  resolveTargetDurationSeconds,
} from "../src/target-duration.js";
import type { AnalysisSessionView } from "../src/shared.js";

function session(overrides: Partial<AnalysisSessionView> = {}): AnalysisSessionView {
  return {
    workspaceRoot: "/tmp",
    probe: { duration: 20, width: 1080, height: 1920, frameRate: 30, hasAudio: true },
    ...overrides,
  };
}

test("clampTargetDurationSeconds enforces 4-180 second bounds", () => {
  assert.equal(clampTargetDurationSeconds(2, 20), 4);
  assert.equal(clampTargetDurationSeconds(999, 20), 180);
  assert.equal(clampTargetDurationSeconds(37.6, 20), 38);
});

test("resolveTargetDurationSeconds prefers session override over probe", () => {
  assert.equal(resolveTargetDurationSeconds(session({ targetDurationSeconds: 45 })), 45);
  assert.equal(resolveTargetDurationSeconds(session()), 20);
});

test("resolveH3ReferenceDuration prefers measured speech duration", () => {
  assert.equal(resolveH3ReferenceDuration({
    session: session({ targetDurationSeconds: 45 }),
    adaptation: { status: "complete", generatedSpeechDurationSeconds: 37.2 },
  }), 38);
});

test("planH3TakeDurations splits long speech into 15s H3 takes with short tail", () => {
  assert.deepEqual(planH3TakeDurations(37), [15, 15, 7]);
  assert.deepEqual(planH3TakeDurations(15), [15]);
});

test("formatH3TakePlan renders human-readable shot summary", () => {
  assert.match(formatH3TakePlan([15, 15, 7]), /15s \+ 15s \+ 7s/u);
  assert.match(formatH3TakePlan([15, 15, 7]), /共 3 镜/u);
});
