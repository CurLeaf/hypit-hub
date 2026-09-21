import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  approveDirectorReview,
  canStartAdaptation,
  ensureDirectorReviewRequest,
  resetDirectorDrafts,
  validateDirectorPackage,
  validateDirectorSceneAlignment,
} from "../src/director-review.js";
import { buildAdaptationScenes } from "../src/scenes-from-structure.js";
import type { AnalysisSessionView, ViralInsightView } from "../src/shared.js";

const insight: ViralInsightView = {
  summary: "测试解读",
  whyViral: [],
  howItWorks: [],
  hookAnalysis: "Hook",
  replicationTips: [],
};

function session(root: string): AnalysisSessionView {
  return {
    workspaceRoot: root,
    videoPath: join(root, "video.mp4"),
    productReferencePath: join(root, "product.png"),
    analysisPath: join(root, ".hypit", "analysis", "ANALYSIS.json"),
    probe: { duration: 20, width: 720, height: 1280, frameRate: 30, hasAudio: true },
    boundaries: [{ at: 2.6, score: 0.3 }, { at: 5.0, score: 0.2 }],
    segments: [{ id: "segment-1", label: "段落 1", start: 0, end: 20, text: "原片口播", wordCount: 4 }],
    adaptationGoal: "吹风机",
  };
}

test("canStartAdaptation requires approved director review", () => {
  assert.equal(canStartAdaptation(undefined), false);
  assert.equal(canStartAdaptation({ status: "pending", dir: "", requestPath: "", briefPath: "", treatmentPath: "", scenesPath: "", checklistPath: "" }), false);
  assert.equal(canStartAdaptation({ status: "approved", dir: "", requestPath: "", briefPath: "", treatmentPath: "", scenesPath: "", checklistPath: "" }), true);
});

test("ensureDirectorReviewRequest creates director drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-director-"));
  const review = await ensureDirectorReviewRequest({ session: session(root), insight });
  assert.equal(review.status, "pending");
  const scenes = JSON.parse(await readFile(review.scenesPath, "utf8")) as readonly { id: string }[];
  assert.ok(scenes.length >= 2);
  assert.ok(await readFile(review.briefPath, "utf8").then((text) => text.includes("导演审查稿")));
});

test("resetDirectorDrafts removes stale director drafts", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-director-"));
  const review = await ensureDirectorReviewRequest({ session: session(root), insight });
  await writeFile(review.briefPath, "# BRIEF\n旧产品\n", "utf8");
  await resetDirectorDrafts(root);
  const issues = await approveDirectorReview(root);
  assert.ok(issues.some((issue) => issue.includes("缺少 director/BRIEF.md")));
});

test("validateDirectorSceneAlignment requires scene ids to match reference cuts", () => {
  const baseScenes = buildAdaptationScenes(session("/tmp"), insight);
  const aligned = baseScenes.map((scene) => ({ id: scene.momentId, text: "口播" }));
  assert.deepEqual(validateDirectorSceneAlignment(baseScenes, aligned), []);

  const missing = aligned.slice(0, -1);
  const issues = validateDirectorSceneAlignment(baseScenes, missing);
  assert.ok(issues.some((issue) => issue.includes("缺少")));
});

test("approveDirectorReview rejects placeholder brief", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-director-"));
  const review = await ensureDirectorReviewRequest({ session: session(root), insight });
  await writeFile(review.briefPath, "# BRIEF\n【待替换】\n", "utf8");
  await writeFile(review.treatmentPath, "# TREATMENT\nok\n", "utf8");
  await writeFile(review.scenesPath, `${JSON.stringify([{ id: "scene-1", text: "测试口播" }])}\n`, "utf8");
  const issues = await approveDirectorReview(root);
  assert.ok(issues.some((issue) => issue.includes("占位符")));
});

test("approveDirectorReview rejects unchanged reference scenes", async () => {
  const root = await mkdtemp(join(tmpdir(), "hypit-director-"));
  const review = await ensureDirectorReviewRequest({ session: session(root), insight });
  const baseScenes = buildAdaptationScenes(session(root), insight);
  await writeFile(review.briefPath, "# BRIEF\n产品完整\n", "utf8");
  await writeFile(review.treatmentPath, "# TREATMENT\nok\n", "utf8");
  await writeFile(
    review.scenesPath,
    `${JSON.stringify(baseScenes.map((scene) => ({ id: scene.momentId, text: scene.text })), null, 2)}\n`,
    "utf8",
  );
  const issues = await approveDirectorReview(root, { session: session(root), insight });
  assert.ok(issues.some((issue) => issue.includes("原口播")));
});
