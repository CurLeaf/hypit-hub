import assert from "node:assert/strict";
import test from "node:test";

import { groupScenesIntoShots, planShotDurations } from "../src/shot-plan.js";
import type { ScenePlan } from "../src/scene-plan.js";

function scene(start: number, end: number, text: string): ScenePlan {
  return {
    id: `scene-${start}`,
    momentId: `scene-${start}`,
    start,
    end,
    text,
    prompt: "prompt",
  };
}

test("planShotDurations keeps short references as one H3 shot", () => {
  assert.deepEqual(planShotDurations(17), [15]);
  assert.deepEqual(planShotDurations(8), [8]);
});

test("planShotDurations splits long references into 15s shots within tolerance", () => {
  assert.deepEqual(planShotDurations(20), [15, 5]);
  assert.deepEqual(planShotDurations(32), [15, 15]);
  const total35 = planShotDurations(35).reduce((sum, seconds) => sum + seconds, 0);
  assert.ok(Math.abs(total35 - 35) <= 5);
});

test("groupScenesIntoShots keeps tail dialogue when output is shorter than reference", () => {
  const scenes = [
    scene(0, 15, "前半段口播内容"),
    scene(15, 17, "尾部口播内容"),
  ];
  const shots = groupScenesIntoShots(scenes, 17);
  assert.equal(shots.length, 1);
  assert.ok(shots[0]?.text.includes("尾部口播内容"));
});

test("groupScenesIntoShots merges scene prompt hints for multi-scene shots", () => {
  const scenes = [
    { ...scene(0, 10, "第一段口播"), prompt: "Close-up jacket detail" },
    { ...scene(10, 20, "第二段口播"), prompt: "Full-body streetwear walk" },
  ];
  const shots = groupScenesIntoShots(scenes, 20);
  assert.equal(shots.length, 2);
  assert.match(shots[0]?.scenePromptHint ?? "", /Close-up jacket detail/u);
  assert.match(shots[0]?.scenePromptHint ?? "", /Full-body streetwear walk/u);
});

test("groupScenesIntoShots merges dialogue by timeline instead of per cut", () => {
  const scenes = [
    scene(0, 2.6, "穿了三个月通勤周末都穿才敢分享的叠穿套装"),
    scene(2.6, 4.3, "大口袋工装夹克机能感直接拉满"),
    scene(4.3, 7, "军绿配色白内搭怎么搭都好看"),
    scene(7, 9.9, "内外层次已经配好不用自己凑"),
    scene(9.9, 13, "松紧收口廓形上身有余量省心又好搭"),
    scene(13, 15.1, "三百多的价格性价比直接拉满"),
    scene(15.1, 17.5, "但上身好看又有型兄弟们别犹豫"),
    scene(17.5, 20, "夹克单穿周末出街冲冲冲"),
  ];
  const shots = groupScenesIntoShots(scenes, 20);
  assert.equal(shots.length, 2);
  assert.equal(shots[0]?.durationSeconds, 15);
  assert.equal(shots[1]?.durationSeconds, 5);
  assert.ok(shots[0]?.text.includes("叠穿套装"));
  assert.ok(shots[1]?.text.includes("别犹豫"));
});

test("groupScenesIntoShots merges dialogue without literal separators", () => {
  const scenes = [
    scene(0, 10, "第一段口播内容"),
    scene(10, 20, "第二段口播内容"),
  ];
  const shots = groupScenesIntoShots(scenes, 10);
  assert.equal(shots.length, 1);
  assert.doesNotMatch(shots[0]?.text ?? "", /\|\|/u);
  assert.ok(shots[0]?.text.includes("第一段口播内容"));
  assert.ok(shots[0]?.text.includes("第二段口播内容"));
});
