import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeH3ShotAction } from "../src/h3-shot-prompt.js";

test("sanitizeH3ShotAction accepts English action text", () => {
  const action = "Tight handheld framing with energetic hook delivery and clear product visibility.";
  assert.equal(sanitizeH3ShotAction(action), action);
});

test("sanitizeH3ShotAction rejects Chinese action text", () => {
  assert.equal(
    sanitizeH3ShotAction("快节奏口播，前三秒抛出价格锚点。"),
    undefined,
  );
});

test("sanitizeH3ShotAction rejects empty action text", () => {
  assert.equal(sanitizeH3ShotAction("   "), undefined);
});
