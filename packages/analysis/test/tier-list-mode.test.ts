import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTierListSpokenScriptGuide,
  contentUsesTierList,
  H3_TIER_LIST_OVERLAY_BLOCK,
  resolveTierListMode,
  spokenScriptMentionsTierLabels,
  validateSpokenScriptTierLabels,
} from "../src/tier-list-mode.js";

test("contentUsesTierList detects ranking vocabulary without loose English matches", () => {
  assert.equal(contentUsesTierList("市面上的牛奶多如牛毛，标签写着夯到爆"), true);
  assert.equal(contentUsesTierList("plain product demo with no ranking"), false);
  assert.equal(contentUsesTierList("improve your search rank with this product"), false);
});

test("resolveTierListMode reads adaptationGoal even when insight is generic", () => {
  assert.equal(resolveTierListMode({
    insight: {
      summary: "普通产品介绍",
      hookAnalysis: "直接展示卖点",
      whyViral: "",
      howItWorks: "",
      replicationTips: [],
    },
    adaptationGoal: "60秒牛奶排行榜测评",
    scenes: [{ text: "今天推荐这款保温杯", scenePromptHint: "product close-up" }],
  }), true);
});

test("spokenScriptMentionsTierLabels accepts standard labels but rejects 夯到爆", () => {
  assert.equal(spokenScriptMentionsTierLabels("第一款给到夯，口感不错"), true);
  assert.equal(spokenScriptMentionsTierLabels("标签写着夯到爆"), false);
  assert.equal(spokenScriptMentionsTierLabels("这款属于人上人级别"), true);
});

test("validateSpokenScriptTierLabels returns actionable error", () => {
  assert.deepEqual(validateSpokenScriptTierLabels("普通推荐，没有等级词"), [
    "口播必须明确念出排行榜五级标准词之一：夯、顶级、人上人、NPC、底边（不要使用「夯到爆」「从夯到拉」等变体）",
  ]);
});

test("buildTierListSpokenScriptGuide requires standard tier labels only", () => {
  const guide = buildTierListSpokenScriptGuide(["悦鲜活", "金典"]);
  assert.match(guide, /禁止使用「夯到爆」/u);
  assert.match(guide, /夯、顶级、人上人、NPC、底边/u);
});

test("H3_TIER_LIST_OVERLAY_BLOCK uses shared tier labels", () => {
  assert.match(H3_TIER_LIST_OVERLAY_BLOCK, /夯, 顶级, 人上人, NPC, 底边/u);
});
