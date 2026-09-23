import { copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { generateUgcReplicaProject } from "./scaffold-ugc.js";
import { ensureProductionLayout } from "./scaffold-paths.js";

import { normalizeProductReferences } from "./product-reference.js";
import type { SpeechMode } from "./speech-synth.js";
import type { AdaptationView, AnalysisSessionView, BriefView, TreatmentView, ViralInsightView } from "./shared.js";

const UGC_TEMPLATE = "packages/analysis/templates";

const SUPPORTED_FORMATS = new Set(["ugc", "explainer", "talking-head"]);

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
  readonly productReferencePaths?: readonly string[];
  readonly videoAroll?: boolean;
  readonly brief?: BriefView;
  readonly goal?: string;
  readonly preparedAdaptation?: AdaptationView;
}): Promise<{ readonly authorPath: string; readonly runPath: string }> {
  const formatId = input.formatId;
  const productReferencePaths = input.productReferencePaths ?? normalizeProductReferences(input.session).paths;
  if (!SUPPORTED_FORMATS.has(formatId) && productReferencePaths.length === 0) {
    throw new Error("当前只生成竖屏 UGC 口播工程，请选择 UGC 或讲解格式");
  }
  const hasProductReference = productReferencePaths.length > 0;
  const speechMode: SpeechMode = hasProductReference ? "tts" : (input.speechMode ?? "reference");
  const effectiveFormatId = formatId === "explainer" || formatId === "talking-head" ? formatId : "ugc";
  const ugcTemplateDir = resolve(input.distributionRoot, UGC_TEMPLATE);

  const layout = await ensureProductionLayout(input.productionDir);
  await copyFile(join(ugcTemplateDir, "recipes.svs"), layout.recipesPath);

  return generateUgcReplicaProject({
    session: input.session,
    insight: input.insight,
    treatment: input.treatment,
    productionDir: input.productionDir,
    layout,
    templateDir: ugcTemplateDir,
    workspaceRoot: input.workspaceRoot,
    formatId: effectiveFormatId,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    speechMode,
    ...(productReferencePaths.length === 0 ? {} : { productReferencePaths }),
    ...(input.videoAroll === undefined ? {} : { videoAroll: input.videoAroll }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.preparedAdaptation === undefined ? {} : { preparedAdaptation: input.preparedAdaptation }),
  });
}
