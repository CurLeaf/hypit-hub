import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import { buildAdaptationScenes } from "./scenes-from-structure.js";
import { adaptScenesForProduct } from "./script-adapt.js";
import { extractReferenceAudio, extractVoiceReferenceSample } from "./scaffold-ugc.js";
import { resolveSpeechAudio } from "./speech-synth.js";
import { generateBrief, generateInsight, generateTreatment } from "./workflow.js";

import type { AdaptationView, AnalysisSessionView } from "./shared.js";

const ADAPTATION_SUBDIR = ".hypit/analysis/adaptation";

export function adaptationDir(workspaceRoot: string): string {
  return join(workspaceRoot, ADAPTATION_SUBDIR);
}

export async function prepareProductAdaptation(input: {
  readonly session: AnalysisSessionView;
  readonly runtimePath?: string;
  readonly goal?: string;
  readonly onPhase?(phase: string): void;
}): Promise<AdaptationView> {
  const { session } = input;
  if (session.analysisPath === undefined) throw new Error("请先完成参考视频分析");
  if (session.productReferencePath === undefined) throw new Error("请先上传参考图");

  const dir = adaptationDir(session.workspaceRoot);
  await mkdir(dir, { recursive: true });

  input.onPhase?.("解读参考片…");
  const insight = await generateInsight({
    session,
    runtimePath: input.runtimePath,
    requireLlm: true,
  });

  input.onPhase?.("撰写 Brief…");
  const brief = session.brief ?? await generateBrief({
    session,
    insight,
    goal: input.goal,
    runtimePath: input.runtimePath,
    requireLlm: true,
  });
  await writeFile(join(dir, "BRIEF.md"), `${brief.markdown.trim()}\n`, "utf8");

  input.onPhase?.("撰写 Treatment…");
  const treatment = session.treatment ?? await generateTreatment({
    session,
    insight,
    brief,
    runtimePath: input.runtimePath,
    requireLlm: true,
  });
  await writeFile(join(dir, "TREATMENT.md"), `${treatment.markdown.trim()}\n`, "utf8");

  input.onPhase?.("按 Brief/Treatment 改写口播…");
  const baseScenes = buildAdaptationScenes(session, insight);
  const adaptedScenes = await adaptScenesForProduct({
    session,
    insight,
    brief,
    treatment,
    scenes: baseScenes,
    goal: input.goal,
    runtimePath: input.runtimePath,
    requireSuccess: true,
  });
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
