import assert from "node:assert/strict";
import test from "node:test";

import { isCliCheckInvocationError, shouldBlockBuildOnScaffoldCheck } from "../src/scaffold-check.js";

test("CLI --runtime on check does not block Build", () => {
  assert.equal(isCliCheckInvocationError("--runtime does not apply to check"), true);
  assert.equal(shouldBlockBuildOnScaffoldCheck(false, "--runtime does not apply to check"), false);
});

test("a real scaffold check failure still blocks Build", () => {
  assert.equal(shouldBlockBuildOnScaffoldCheck(false, "SCRIPT_SEGMENT_CLOSE: Malformed Segment close."), true);
  assert.equal(shouldBlockBuildOnScaffoldCheck(true, "ok"), false);
});
