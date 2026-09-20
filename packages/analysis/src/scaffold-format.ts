import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { generateRankingReplicaProject } from "./scaffold-ranking.js";
import { generateUgcReplicaProject } from "./scaffold-ugc.js";
import { ensureProductionLayout } from "./scaffold-paths.js";

import type { SpeechMode } from "./speech-synth.js";
import type { AdaptationView, AnalysisSessionView, BriefView, TreatmentView, ViralInsightView } from "./shared.js";

const FORMAT_TEMPLATE: Record<string, string> = {
  ranking: "examples/ranking-football",
  interview: "examples/interview",
  podcast: "examples/podcast",
  ugc: "examples/byok-openai-compatible/templates/ugc-replica",
  explainer: "examples/byok-openai-compatible/templates/ugc-replica",
  "talking-head": "examples/byok-openai-compatible/templates/ugc-replica",
};

function recipesFileName(formatId: string): string {
  if (formatId === "ranking") return "recipes.svs";
  if (formatId === "interview" || formatId === "podcast") return "reference.svs";
  return "recipes.svs";
}

const RANKING_MEDIA_OVERLAY = `

  media.hero {
    stack-order: 5;
    fit: cover;
    frame-x: 0.5;
    frame-y: 0.5;
    content-x: 0.5;
    content-y: 0.5;
  }

  media.broll {
    stack-order: 40;
    fit: cover;
    shadows: 0 18 34 -8 #000000D9;
  }

  motion.broll {
    enter: pop;
    enter-frames: 6;
    enter-easing: ease-out;
    exit: fade;
    exit-frames: 4;
    exit-easing: ease-in;
  }
`;

export async function generateFormatReplicaProject(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment: TreatmentView;
  readonly productionDir: string;
  readonly distributionRoot: string;
  readonly workspaceRoot: string;
  readonly formatId: string;
  readonly runtimePath?: string;
  readonly speechMode?: SpeechMode;
  readonly productReferencePath?: string;
  readonly videoAroll?: boolean;
  readonly brief?: BriefView;
  readonly goal?: string;
  readonly preparedAdaptation?: AdaptationView;
}): Promise<{ readonly authorPath: string; readonly runPath: string }> {
  const formatId = input.formatId;
  const hasProductReference = input.productReferencePath !== undefined;
  const speechMode: SpeechMode = hasProductReference ? "tts" : (input.speechMode ?? "reference");
  const useOfficialUgc = hasProductReference || formatId === "ugc" || formatId === "explainer" || formatId === "talking-head";
  const effectiveFormatId = useOfficialUgc
    ? (formatId === "explainer" || formatId === "talking-head" ? formatId : "ugc")
    : formatId;
  const templateKey = FORMAT_TEMPLATE[effectiveFormatId] ?? FORMAT_TEMPLATE.ugc;
  const templateDir = resolve(input.distributionRoot, templateKey);
  const ugcTemplateDir = resolve(input.distributionRoot, "examples/byok-openai-compatible/templates/ugc-replica");

  if (formatId === "interview" || formatId === "podcast") {
    throw new Error("采访/播客格式脚手架尚未实现，请选择竖屏 UGC 或榜单 Ranking");
  }
  if (hasProductReference && !useOfficialUgc) {
    throw new Error("上传参考图后请使用竖屏 UGC 官方复刻路径（含 H3 口播与参考图 edits）");
  }

  const layout = await ensureProductionLayout(input.productionDir);
  const recipesSource = join(templateDir, recipesFileName(effectiveFormatId));
  const ugcRecipes = join(ugcTemplateDir, "recipes.svs");
  try {
    await copyFile(recipesSource, layout.recipesPath);
  } catch {
    await copyFile(ugcRecipes, layout.recipesPath);
  }

  if (effectiveFormatId === "ranking") {
    let recipes = await readFile(layout.recipesPath, "utf8");
    recipes = recipes
      .replace(/max-lines:\s*2/u, "max-lines: 4")
      .replace(/max-words-per-line:\s*4/u, "max-words-per-line: 8")
      .replace(/y:\s*0\.55/u, "y: 0.48")
      .replace(/size:\s*44/u, "size: 38");
    const closeTag = "</sheet>";
    const closeIndex = recipes.lastIndexOf(closeTag);
    if (closeIndex < 0) throw new Error("recipes.svs 缺少 </sheet> 闭合标签");
    await writeFile(
      layout.recipesPath,
      recipes.slice(0, closeIndex) + RANKING_MEDIA_OVERLAY + "\n" + recipes.slice(closeIndex),
      "utf8",
    );
  }

  if (effectiveFormatId !== "ugc" && effectiveFormatId !== "explainer" && effectiveFormatId !== "talking-head") {
    try {
      await copyFile(join(templateDir, "reference.svml"), join(input.productionDir, "reference-template.svml"));
    } catch {
      // optional
    }
  }

  if (effectiveFormatId === "ranking") {
    return generateRankingReplicaProject({
      session: input.session,
      insight: input.insight,
      treatment: input.treatment,
      productionDir: input.productionDir,
      layout,
      templateAssetsDir: join(templateDir, "assets"),
      workspaceRoot: input.workspaceRoot,
      runtimePath: input.runtimePath,
      speechMode,
    });
  }

  return generateUgcReplicaProject({
    session: input.session,
    insight: input.insight,
    treatment: input.treatment,
    productionDir: input.productionDir,
    layout,
    templateDir: ugcTemplateDir,
    workspaceRoot: input.workspaceRoot,
    formatId: effectiveFormatId,
    runtimePath: input.runtimePath,
    speechMode,
    productReferencePath: input.productReferencePath,
    videoAroll: input.videoAroll,
    brief: input.brief,
    goal: input.goal,
    preparedAdaptation: input.preparedAdaptation,
  });
}
