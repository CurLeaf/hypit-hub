import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficialScript, formatHostDialogue } from "../src/script-format.js";

test("formatHostDialogue inserts pause markers every six characters", () => {
  assert.equal(formatHostDialogue("一二三四五六七八"), "一二三四五六 || 七八");
});

test("buildOfficialScript uses unclosed HOST role cues", () => {
  const script = buildOfficialScript([
    { id: "segment_1", text: "用了三个月才敢分享的吹风机" },
    { id: "segment_2", text: "姐妹們別猶豫衝衝衝" },
  ]);
  assert.equal(script.includes("</HOST>"), false);
  assert.match(script, /<segment_1>\s+<HOST>用了三个月才 \|\| 敢分享的吹风 \|\| 机\s+<\/segment_1>/u);
  assert.match(script, /<segment_2>\s+<HOST>@segment_2 姐妹們別猶豫 \|\| 衝衝衝 @\/segment_2\s+<\/segment_2>/u);
});
