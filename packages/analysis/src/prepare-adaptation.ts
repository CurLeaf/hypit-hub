import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import {
  canStartAdaptation,
  copyDirectorDocsToAdaptation,
  loadDirectorPackage,
} from "./director-review.js";
import { buildAdaptationScenes } from "./scenes-from-structure.js";
import { adaptScenesForProduct } from "./script-adapt.js";
import { extractReferenceAudio, extractVoiceReferenceSample } from "./scaffold-ugc.js";
import type { ScenePlan } from "./scene-plan.js";
import { resolveSpeechAudio } from "./speech-synth.js";
import { generateBrief, generateInsight, generateTreatment } from "./workflow.js";

import type { AdaptationView, AnalysisSessionView, BriefView, TreatmentView } from "./shared.js";

const ADAPTATION_SUBDIR = ".hypit/analysis/adaptation";

export function adaptationDir(workspaceRoot: string): string {
  return join(workspaceRoot, ADAPTATION_SUBDIR);
}

function applyDirectorScenes(
  baseScenes: readonly ScenePlan[],
  directorScenes: readonly { readonly id: string; readonly text: string }[],
): readonly ScenePlan[] {
  const textById = new Map(directorScenes.map((scene) => [scene.id, scene.text]));
  return baseScenes.map((scene) => ({
    ...scene,
    text: textById.get(scene.momentId) ?? textById.get(scene.id) ?? scene.text,
  }));
}

export async function prepareProductAdaptation(input: {
  readonly session: AnalysisSessionView;
  readonly runtimePath?: string;
  readonly goal?: string;
  readonly onPhase?(phase: string): void;
  readonly skipDirectorGate?: boolean;
}): Promise<AdaptationView> {
  const { session } = input;
  if (session.analysisPath === undefined) throw new Error("请先完成参考视频分析");
  if (session.productReferencePath === undefined) throw new Error("请先上传参考图");
  if (input.skipDirectorGate !== true && !canStartAdaptation(session.directorReview)) {
    throw new Error("导演审查尚未通过。请在 Cursor 中编辑 .hypit/analysis/director/ 下的 BRIEF、TREATMENT、scenes.json，再在 UI 点击「导演审查通过」。");
  }

  const dir = adaptationDir(session.workspaceRoot);
  await mkdir(dir, { recursive: true });
  const directorPackage = await loadDirectorPackage(session.workspaceRoot);

  input.onPhase?.("解读参考片…");
  const insight = await generateInsight({
    session,
    runtimePath: input.runtimePath,
    requireLlm: true,
  });

  input.onPhase?.("撰写 Brief…");
  let brief: BriefView;
  if (directorPackage.briefMarkdown !== undefined && directorPackage.briefMarkdown.trim().length > 0) {
    brief = { markdown: directorPackage.briefMarkdown };
  } else {
    brief = session.brief ?? await generateBrief({
      session,
      insight,
      goal: input.goal,
      runtimePath: input.runtimePath,
      requireLlm: true,
    });
  }
  await writeFile(join(dir, "BRIEF.md"), `${brief.markdown.trim()}\n`, "utf8");

  input.onPhase?.("撰写 Treatment…");
  let treatment: TreatmentView;
  if (directorPackage.treatmentMarkdown !== undefined && directorPackage.treatmentMarkdown.trim().length > 0) {
    treatment = { markdown: directorPackage.treatmentMarkdown };
  } else {
    treatment = session.treatment ?? await generateTreatment({
      session,
      insight,
      brief,
      runtimePath: input.runtimePath,
      requireLlm: true,
    });
  }
  await writeFile(join(dir, "TREATMENT.md"), `${treatment.markdown.trim()}\n`, "utf8");

  input.onPhase?.("按 Brief/Treatment 改写口播…");
  const baseScenes = buildAdaptationScenes(session, insight);
  let adaptedScenes: readonly ScenePlan[];
  if (directorPackage.scenes.length > 0) {
    adaptedScenes = applyDirectorScenes(baseScenes, directorPackage.scenes);
  } else {
    adaptedScenes = await adaptScenesForProduct({
      session,
      insight,
      brief,
      treatment,
      scenes: baseScenes,
      goal: input.goal,
      runtimePath: input.runtimePath,
      requireSuccess: true,
    });
  }
  const spokenText = adaptedScenes
    .map((scene) => scene.text.replace(/\s+/gu, ""))
    .filter((text) => text.length > 0)
    .join("");
  if (spokenText.length === 0) throw new Error("改写后的口播为空，请检查参考片转写或改编说明");

  input.onPhase?.("为你的产品合成配音…");
  const generatedSpeechPath = join(dir, "generated-speech.wav");
  await resolveSpeechAudio({
    mode: "tts",
    session,
    destination: generatedSpeechPath,
    runtimePath: input.runtimePath,
    scriptText: spokenText,
    extractReferenceAudio,
  });

  input.onPhase?.("提取 H3 音色样本…");
  const voiceReferencePath = join(dir, "voice-reference.wav");
  await extractVoiceReferenceSample(generatedSpeechPath, voiceReferencePath);

  const ext = extname(session.productReferencePath) || ".jpg";
  const productReferencePath = join(dir, `product-reference${ext}`);
  await copyFile(session.productReferencePath, productReferencePath);

  await writeFile(join(dir, "adapted-scenes.json"), `${JSON.stringify(
    adaptedScenes.map((scene) => ({ id: scene.momentId, text: scene.text })),
    null,
    2,
  )}\n`, "utf8");
  await copyDirectorDocsToAdaptation(session.workspaceRoot, dir);

  return {
    status: "complete",
    phase: "配音已就绪",
    dir,
    generatedSpeechPath,
    voiceReferencePath,
    productReferencePath,
    productReferenceSource: session.productReferencePath,
    briefPath: join(dir, "BRIEF.md"),
    treatmentPath: join(dir, "TREATMENT.md"),
    adaptedScenesPath: join(dir, "adapted-scenes.json"),
  };
}
