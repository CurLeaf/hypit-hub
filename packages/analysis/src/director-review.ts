import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeProductReferences } from "./product-reference.js";
import { resolveTargetDurationSeconds } from "./target-duration.js";
import { buildAdaptationScenes } from "./scenes-from-structure.js";
import type { ScenePlan } from "./scene-plan.js";
import type { AnalysisSessionView, BriefView, DirectorReviewView, TreatmentView, ViralInsightView } from "./shared.js";
import {
  resolveTierListMode,
  TIER_LIST_DIRECTOR_HINT,
  validateSpokenScriptTierLabels,
} from "./tier-list-mode.js";

const DIRECTOR_SUBDIR = ".hypit/analysis/director";
const DIRECTOR_DRAFT_FILES = ["BRIEF.md", "TREATMENT.md", "scenes.json"] as const;

export type DirectorSceneDraft = {
  readonly id: string;
  readonly text: string;
};

export type DirectorPackage = {
  readonly briefMarkdown?: string;
  readonly treatmentMarkdown?: string;
  readonly scenes: readonly DirectorSceneDraft[];
};

export function directorReviewDir(workspaceRoot: string): string {
  return join(workspaceRoot, DIRECTOR_SUBDIR);
}

export async function resetDirectorDrafts(workspaceRoot: string): Promise<void> {
  const dir = directorReviewDir(workspaceRoot);
  for (const name of DIRECTOR_DRAFT_FILES) {
    await rm(join(dir, name), { force: true });
  }
}

export function canStartAdaptation(review: DirectorReviewView | undefined): boolean {
  return review?.status === "approved";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rel(workspaceRoot: string, absolutePath: string | undefined): string {
  if (absolutePath === undefined) return "（未就绪）";
  return absolutePath.replace(/\\/gu, "/").replace(workspaceRoot.replace(/\\/gu, "/"), ".").replace(/^\.\//u, "");
}

export async function loadDirectorPackage(workspaceRoot: string): Promise<DirectorPackage> {
  const dir = directorReviewDir(workspaceRoot);
  const briefMarkdown = await fileExists(join(dir, "BRIEF.md"))
    ? await readFile(join(dir, "BRIEF.md"), "utf8")
    : undefined;
  const treatmentMarkdown = await fileExists(join(dir, "TREATMENT.md"))
    ? await readFile(join(dir, "TREATMENT.md"), "utf8")
    : undefined;
  let scenes: DirectorSceneDraft[] = [];
  const scenesPath = join(dir, "scenes.json");
  if (await fileExists(scenesPath)) {
    const raw = JSON.parse(await readFile(scenesPath, "utf8")) as readonly { readonly id?: string; readonly text?: string }[];
    scenes = raw
      .filter((item) => typeof item.id === "string" && typeof item.text === "string")
      .map((item) => ({ id: item.id!, text: item.text!.trim() }));
  }
  return { briefMarkdown, treatmentMarkdown, scenes };
}

function normalizeSpokenText(text: string): string {
  return text.replace(/\s+/gu, "");
}

/** Reject when every scene still matches reference ASR (direct copy). */
export function validateDirectorScenesAdapted(
  baseScenes: readonly Pick<ScenePlan, "momentId" | "text">[],
  directorScenes: readonly DirectorSceneDraft[],
): readonly string[] {
  if (directorScenes.length === 0 || baseScenes.length === 0) return [];
  const baseById = new Map(baseScenes.map((scene) => [scene.momentId, normalizeSpokenText(scene.text)]));
  const unchanged = directorScenes.filter((scene) => {
    const base = baseById.get(scene.id);
    return base !== undefined && normalizeSpokenText(scene.text) === base;
  });
  if (unchanged.length === directorScenes.length) {
    return ["scenes.json 仍为参考片原口播，请按新产品改写后再通过审查"];
  }
  return [];
}

/** Director scenes.json must align 1:1 with reference-video adaptation cuts. */
export function validateDirectorSceneAlignment(
  baseScenes: readonly Pick<ScenePlan, "momentId">[],
  directorScenes: readonly DirectorSceneDraft[],
): readonly string[] {
  const issues: string[] = [];
  const baseIds = baseScenes.map((scene) => scene.momentId);
  const directorIds = new Set(directorScenes.map((scene) => scene.id));
  const missing = baseIds.filter((id) => !directorIds.has(id));
  if (missing.length > 0) {
    issues.push(
      `director/scenes.json 缺少与参考片切点对齐的段落：${missing.join("、")}（共需 ${baseIds.length} 段：${baseIds.join("、")}）`,
    );
  }
  const extra = directorScenes.map((scene) => scene.id).filter((id) => !baseIds.includes(id));
  if (extra.length > 0) {
    issues.push(`director/scenes.json 含参考片切点中不存在的段落：${extra.join("、")}`);
  }
  return issues;
}

export function validateDirectorScenesTierLabels(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly brief?: BriefView;
  readonly treatment?: TreatmentView;
  readonly baseScenes: readonly Pick<ScenePlan, "momentId" | "text" | "prompt">[];
  readonly directorScenes: readonly DirectorSceneDraft[];
}): readonly string[] {
  const enabled = resolveTierListMode({
    insight: input.insight,
    ...(input.treatment === undefined ? {} : { treatment: input.treatment }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    adaptationGoal: input.session.adaptationGoal,
    scenes: input.baseScenes.map((scene) => ({
      text: scene.text,
      scenePromptHint: scene.prompt,
    })),
  });
  if (!enabled || input.directorScenes.length === 0) return [];
  return validateSpokenScriptTierLabels(...input.directorScenes.map((scene) => scene.text));
}

export function validateDirectorPackage(package_: DirectorPackage): readonly string[] {
  const issues: string[] = [];
  if (package_.briefMarkdown === undefined || package_.briefMarkdown.trim().length === 0) {
    issues.push("缺少 director/BRIEF.md");
  } else if (/【待替换|【待填|（请填写|（请写明/u.test(package_.briefMarkdown)) {
    issues.push("BRIEF.md 仍含占位符，请补全产品信息");
  }
  if (package_.treatmentMarkdown === undefined || package_.treatmentMarkdown.trim().length === 0) {
    issues.push("缺少 director/TREATMENT.md");
  } else if (/【待替换|【待填|（请填写|（请写明/u.test(package_.treatmentMarkdown)) {
    issues.push("TREATMENT.md 仍含占位符，请补全切点与表演说明");
  }
  const spoken = package_.scenes.map((scene) => scene.text.replace(/\s+/gu, "")).filter((text) => text.length > 0);
  if (spoken.length === 0) {
    issues.push("缺少 director/scenes.json 或口播为空");
  }
  return issues;
}

export async function ensureDirectorReviewRequest(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
}): Promise<DirectorReviewView> {
  const { session, insight } = input;
  const dir = directorReviewDir(session.workspaceRoot);
  await mkdir(dir, { recursive: true });

  const baseScenes = buildAdaptationScenes(session, insight);
  const scenesDraft = baseScenes.map((scene) => ({
    id: scene.momentId,
    text: scene.text.replace(/\s+/gu, ""),
  }));
  const scenesPath = join(dir, "scenes.json");
  if (!(await fileExists(scenesPath))) {
    await writeFile(scenesPath, `${JSON.stringify(scenesDraft, null, 2)}\n`, "utf8");
  }

  const requestPath = join(dir, "REVIEW_REQUEST.md");
  const checklistPath = join(dir, "CHECKLIST.md");
  const briefPath = join(dir, "BRIEF.md");
  const treatmentPath = join(dir, "TREATMENT.md");

  if (!(await fileExists(briefPath))) {
    await writeFile(briefPath, [
      "# BRIEF.md（导演审查稿）",
      "",
      "## 目标",
      session.adaptationGoal?.trim() || "（请填写：新产品是什么、卖给谁、核心卖点）",
      "",
      "## 成片时长",
      `目标口播总时长约 ${resolveTargetDurationSeconds(session)} 秒（将拆分为多个 ≤15 秒的 H3 分镜；scenes.json 各段合计朗读时长应接近该目标）`,
      "",
      "## 从参考片继承",
      `- 结构：${(session.segments ?? []).map((segment) => segment.label).join(" → ") || "按参考片口播与切镜"}`,
      `- Hook：${insight.hookAnalysis}`,
      `- 切点数：${session.boundaries?.length ?? 0}`,
      "",
      "## 产品主体",
      "（请填写产品名称、品类、可被镜头验证的硬指标、口语价格锚点）",
      "",
      "## 说明",
      "由 Cursor Agent（导演）补全本文件后再通过审查。占位符全部替换后才能制作配音。",
    ].join("\n"), "utf8");
  }

  if (!(await fileExists(treatmentPath))) {
    const tierListNote = resolveTierListMode({
      insight,
      scenes: baseScenes.map((scene) => ({ text: scene.text, scenePromptHint: scene.prompt })),
      adaptationGoal: session.adaptationGoal,
    })
      ? `\n\n## 排行榜 UI\n${TIER_LIST_DIRECTOR_HINT}`
      : "";
    await writeFile(treatmentPath, [
      "# TREATMENT.md（导演审查稿）",
      "",
      "## 导演一句话",
      insight.summary,
      "",
      "## 切点与画面",
      `参考片共 ${session.boundaries?.length ?? 0} 处画面变化。请为每个 scene-* 段落写明 B-roll / A-roll 承担者。`,
      "",
      "## 口播与表演",
      "（请写明语速、人设、受众称呼、CTA）",
      tierListNote,
    ].join("\n"), "utf8");
  }

  if (!(await fileExists(checklistPath))) {
    const tierListChecklist = resolveTierListMode({
      insight,
      scenes: baseScenes.map((scene) => ({ text: scene.text, scenePromptHint: scene.prompt })),
      adaptationGoal: session.adaptationGoal,
    })
      ? "\n- [ ] scenes.json 每段口播已明确念出五级标准词（夯、顶级、人上人、NPC、底边）"
      : "";
    await writeFile(checklistPath, [
      "# 导演审查清单",
      "",
      "- [ ] 已读参考片 ANALYSIS / TIMELINE / transcript",
      "- [ ] 已查看产品参考图，品类与卖点正确",
      "- [ ] BRIEF.md 无占位符，产品信息完整",
      "- [ ] TREATMENT.md 切点与段落职能明确",
      "- [ ] scenes.json 各段口播已按新产品改写（非机械换词）",
      tierListChecklist,
      "- [ ] 用户已确认可以制作配音",
    ].join("\n"), "utf8");
  }

  const archive = session.referenceArchive;
  await writeFile(requestPath, [
    "# 导演审查请求",
    "",
    "Analysis 已暂停自动配音，等待 Cursor Agent 完成导演审查。",
    "",
    "## 素材路径",
    `- 参考视频：${rel(session.workspaceRoot, session.videoPath)}`,
    ...normalizeProductReferences(session).paths.map((path, index) => `- 产品参考图 ${index + 1}：${rel(session.workspaceRoot, path)}`),
    `- 转写：${rel(session.workspaceRoot, session.transcript?.path)}`,
    `- 深读归档：${rel(session.workspaceRoot, archive?.referenceDir)}`,
    `- ANALYSIS：${rel(session.workspaceRoot, archive?.analysisMarkdownPath)}`,
    `- TIMELINE：${rel(session.workspaceRoot, archive?.timelineMarkdownPath)}`,
    "",
    "## Agent 应编辑的文件（本目录）",
    "- `BRIEF.md`",
    "- `TREATMENT.md`",
    "- `scenes.json`（键名 scene-* 与切点段落一致，勿改 id）",
    "",
    "## 完成后",
    "在 Analysis UI 点击「导演审查通过」，或 POST `/__analysis/director/approve`。",
    "",
    `改编说明：${session.adaptationGoal ?? "（未填写）"}`,
    `目标成片时长：约 ${resolveTargetDurationSeconds(session)} 秒（口播合计应接近该时长，H3 按 ≤15 秒分镜生成）`,
  ].join("\n"), "utf8");

  return {
    status: "pending",
    phase: "等待导演审查",
    dir,
    requestPath,
    briefPath,
    treatmentPath,
    scenesPath,
    checklistPath,
  };
}

export async function approveDirectorReview(
  workspaceRoot: string,
  context?: { readonly session: AnalysisSessionView; readonly insight: ViralInsightView; readonly brief?: BriefView; readonly treatment?: TreatmentView },
): Promise<readonly string[]> {
  const package_ = await loadDirectorPackage(workspaceRoot);
  const issues = [...validateDirectorPackage(package_)];
  if (context !== undefined && package_.scenes.length > 0) {
    const baseScenes = buildAdaptationScenes(context.session, context.insight);
    issues.push(...validateDirectorSceneAlignment(baseScenes, package_.scenes));
    issues.push(...validateDirectorScenesAdapted(baseScenes, package_.scenes));
    issues.push(...validateDirectorScenesTierLabels({
      session: context.session,
      insight: context.insight,
      ...(context.brief === undefined ? {} : { brief: context.brief }),
      ...(context.treatment === undefined ? {} : { treatment: context.treatment }),
      baseScenes,
      directorScenes: package_.scenes,
    }));
  }
  return issues;
}

export async function copyDirectorDocsToAdaptation(workspaceRoot: string, adaptationRoot: string): Promise<void> {
  const dir = directorReviewDir(workspaceRoot);
  await mkdir(adaptationRoot, { recursive: true });
  for (const name of ["BRIEF.md", "TREATMENT.md", "scenes.json"]) {
    const source = join(dir, name);
    if (await fileExists(source)) {
      await copyFile(source, join(adaptationRoot, name));
    }
  }
}
