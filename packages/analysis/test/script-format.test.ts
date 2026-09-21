import assert from "node:assert/strict";
import test from "node:test";

import { buildOfficialScript, formatHostDialogue } from "../src/script-format.js";

test("formatHostDialogue keeps natural continuous speech", () => {
  assert.equal(formatHostDialogue("一二三四五六七八"), "一二三四五六七八");
});

test("buildOfficialScript uses unclosed HOST role cues", () => {
  const script = buildOfficialScript([
    { id: "shot_1", text: "用了三个月才敢分享的吹风机" },
    { id: "shot_2", text: "姐妹們別猶豫衝衝衝" },
  ]);
  assert.equal(script.includes("</HOST>"), false);
  assert.match(script, /<shot_1>\s+<HOST>用了三个月才敢分享的吹风机\s+<\/shot_1>/u);
  assert.match(script, /<shot_2>\s+<HOST>@shot_2 姐妹們別猶豫衝衝衝 @\/shot_2\s+<\/shot_2>/u);
});
