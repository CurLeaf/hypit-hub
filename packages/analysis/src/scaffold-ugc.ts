import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import { promisify } from "node:util";

import type { ProductionLayout } from "./scaffold-paths.js";
import { runMarkup } from "./scaffold-paths.js";
import { buildScenePrompts, buildScenes, scriptDialogue, type ScenePlan } from "./scene-plan.js";
import { buildAdaptationScenes } from "./scenes-from-structure.js";
import { adaptScenesForProduct } from "./script-adapt.js";
import { resolveSpeechAudio, type SpeechMode } from "./speech-synth.js";

import { buildH3ShotActions } from "./h3-shot-prompt.js";
import { adaptationMatchesReference } from "./replica-readiness.js";
import { loadRuntimeCapabilities } from "./runtime-capabilities.js";
import { buildOfficialSpeakerSvml } from "./scaffold-ugc-speaker.js";
import { groupScenesIntoShots } from "./shot-plan.js";
import { sanitizeScriptId } from "./script-format.js";
import type { AdaptationView, AnalysisSessionView, BriefView, TreatmentView, ViralInsightView } from "./shared.js";

const execFileAsync = promisify(execFile);

export async function extractReferenceAudio(videoPath: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-map", "0:a:0", "-vn",
    "-ac", "1", "-ar", "48000",
    "-c:a", "pcm_s16le",
    destination,
  ], { windowsHide: true });
}

export async function extractVoiceReferenceSample(
  sourceAudioPath: string,
  destination: string,
  maxSeconds = 6,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourceAudioPath,
    "-t", String(maxSeconds),
    "-ac", "1", "-ar", "48000",
    "-c:a", "pcm_s16le",
    destination,
  ], { windowsHide: true });
}

function relativeAssetPath(fromDir: string, absolutePath: string): string {
  return "./" + relative(fromDir, absolutePath).replace(/\\/gu, "/");
}

function sceneHasSpeech(scene: { readonly text: string }): boolean {
  return scene.text.replace(/\s+/gu, "").length > 0;
}

function brollDuringRef(
  momentId: string,
  useOfficialSpeaker: boolean,
  hasProductReference: boolean,
): string {
  const segId = sanitizeScriptId(momentId);
  if (useOfficialSpeaker || hasProductReference) {
    return `story.segment.${segId}`;
  }
  return `story.selection.${segId}`;
}

function scenesForBroll(
  scenes: readonly ScenePlan[],
  useOfficialSpeaker: boolean,
): readonly ScenePlan[] {
  if (useOfficialSpeaker) {
    return scenes.filter((scene) => sceneHasSpeech(scene));
  }
  return scenes.slice(1);
}

function scenesForStillImages(
  scenes: readonly ScenePlan[],
  useVideoAroll: boolean,
  useOfficialSpeaker: boolean,
  hasProductReference: boolean,
): readonly ScenePlan[] {
  if (useOfficialSpeaker) {
    // H3 takes own the picture; stills are unused on the official timeline.
    return [];
  }
  if (useVideoAroll || hasProductReference) return scenes.slice(1);
  return scenes;
}

function defaultPhoneUgcBlocks(scene: ScenePlan, insight: ViralInsightView): string {
  const person = [
    "A confident young Chinese short-form video presenter in casual modern clothing.",
    "Natural skin, approachable expression, vertical phone-video aesthetic.",
    "Theme: " + (scene.text.slice(0, 80) || insight.summary),
  ].join(" ");
  const shot = "Close half-body view speaking to camera with natural hand gestures. Vertical 9:16 framing, face toward lens.";
  const setting = "Bright indoor lifestyle setting with soft natural light and shallow depth of field. No readable text.";
  const prompt = scene.prompt.replace(/[<>&]/gu, "");
  return `
  <text:Value id="${scene.id}-person">${person.replace(/[<>&]/gu, "")}</text:Value>
  <text:Value id="${scene.id}-shot">${shot}</text:Value>
  <text:Value id="${scene.id}-setting">${setting}</text:Value>
  <text:Render id="${scene.id}-render" template={ugc.phone-ugc-v1}>
    <text:Set name="person" text={${scene.id}-person}/>
    <text:Set name="shot" text={${scene.id}-shot}/>
    <text:Set name="setting" text={${scene.id}-setting}/>
  </text:Render>
  <text:Value id="${scene.id}-prompt">${prompt}</text:Value>
  <gpt:Image id="${scene.id}" prompt={${scene.id}-render} aspect-ratio="9:16" resolution="1K"/>`;
}

export async function generateUgcReplicaProject(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly productionDir: string;
  readonly layout: ProductionLayout;
  readonly templateDir: string;
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
  const { session, insight, treatment, productionDir, layout, workspaceRoot, formatId } = input;
  if (session.videoPath === undefined) throw new Error("缺少参考视频路径");
  if (session.probe === undefined) throw new Error("缺少媒体探测信息");
  if (input.productReferencePath === undefined) {
    throw new Error("生成视频需要参考图与改编配音，请先在 Analysis 上传参考图并完成配音制作");
  }

  const assetsDir = layout.assetsDir;
  const hasProductReference = input.productReferencePath !== undefined;
  const speechMode: SpeechMode = hasProductReference
    ? "tts"
    : (input.speechMode ?? "reference");

  try {
    await copyFile(session.videoPath, join(assetsDir, basename(session.videoPath)));
  } catch {
    // optional
  }

  const prepared = input.preparedAdaptation?.status === "complete"
    && adaptationMatchesReference(input.preparedAdaptation, input.productReferencePath)
    ? input.preparedAdaptation
    : undefined;

  const baseScenes = hasProductReference
    ? buildAdaptationScenes(session, insight)
    : buildScenes(session, insight);
  let adaptedScenes = baseScenes;
  if (hasProductReference) {
    if (prepared?.dir !== undefined) {
      const raw = JSON.parse(await readFile(join(prepared.dir, "adapted-scenes.json"), "utf8")) as readonly { readonly id: string; readonly text: string }[];
      const textByMoment = new Map(raw.map((item) => [item.id, item.text]));
      adaptedScenes = baseScenes.map((scene) => ({
        ...scene,
        text: textByMoment.get(scene.momentId) ?? scene.text,
      }));
    } else {
      adaptedScenes = await adaptScenesForProduct({
        session,
        insight,
        ...(treatment === undefined ? {} : { treatment }),
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        scenes: baseScenes,
        ...(input.goal === undefined ? {} : { goal: input.goal }),
        ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
        requireSuccess: true,
      });
    }
  }
  const promptMap = await buildScenePrompts({
    session,
    insight,
    ...(treatment === undefined ? {} : { treatment }),
    formatId,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    scenes: adaptedScenes,
    requireSuccess: hasProductReference,
  });
  // 有参考图时以语义段落（segment-*）为权威，避免 buildScenes 切镜 ID（scene-*）冲掉改写口播。
  const scenes = hasProductReference
    ? adaptedScenes.map((scene) => ({
      ...scene,
      prompt: promptMap.get(scene.momentId) ?? scene.prompt,
    }))
    : buildScenes(session, insight, promptMap);
  const dialogue = scriptDialogue(scenes);
  const spokenText = scenes.map((scene) => scene.text.replace(/\s+/gu, "")).filter((text) => text.length > 0).join("");
  const useVideoAroll = hasProductReference && (input.videoAroll ?? true);
  const capabilities = await loadRuntimeCapabilities(input.runtimePath);
  const useOfficialSpeaker = useVideoAroll && hasProductReference;
  const needsReferenceAudioAsset = !useOfficialSpeaker;
  const audioPath = join(assetsDir, speechMode === "tts" ? "generated-speech.wav" : "reference-audio.wav");
  if (needsReferenceAudioAsset) {
    if (prepared?.generatedSpeechPath !== undefined && speechMode === "tts") {
      await copyFile(prepared.generatedSpeechPath, audioPath);
    } else {
      await resolveSpeechAudio({
        mode: speechMode,
        session,
        destination: audioPath,
        ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
        scriptText: spokenText,
        extractReferenceAudio,
      });
    }
  }
  const language = session.transcript?.language ?? "zh";
  const portraitUgc = hasProductReference;
  const width = portraitUgc ? 1080 : Math.max(540, session.probe.width);
  const height = portraitUgc ? 1920 : Math.max(960, session.probe.height);
  const durationSec = Math.ceil(session.probe.duration);

  let productAssetBlock = "";
  if (hasProductReference) {
    const sourceImage = prepared?.productReferencePath ?? input.productReferencePath!;
    const ext = extname(sourceImage) || ".jpg";
    const destination = join(assetsDir, `product-reference${ext}`);
    await copyFile(sourceImage, destination);
    const productRel = relativeAssetPath(layout.authorsDir, destination);
    productAssetBlock = `\n  <asset:Image id="product-reference" src="${productRel}"/>\n`;
  }

  const imageScenes = scenesForStillImages(scenes, useVideoAroll, useOfficialSpeaker, hasProductReference);
  const sceneImageBlocks = imageScenes.map((scene) => {
    const basePrompt = scene.prompt.replace(/[<>&]/gu, "");
    const prompt = hasProductReference
      ? `${basePrompt} Preserve the exact product or subject appearance from the supplied reference image.`
      : basePrompt;
    if (!hasProductReference) {
      return defaultPhoneUgcBlocks({ ...scene, prompt }, insight);
    }
    return `
  <text:Value id="${scene.id}-prompt">${prompt}</text:Value>
  <gpt:Image id="${scene.id}" prompt={${scene.id}-prompt} aspect-ratio="9:16" resolution="1K">
    <gpt:Reference image={product-reference}/>
  </gpt:Image>`;
  }).join("\n");

  const brollScenes = scenesForBroll(scenes, useOfficialSpeaker);
  const brollItems = useOfficialSpeaker
    ? ""
    : brollScenes.map((scene) => `
    <media-track:Item id="${scene.id}-card" image={${scene.id}.image}
      extent={scene-extent} during={${brollDuringRef(scene.momentId, useOfficialSpeaker, hasProductReference)}}
      frame={broll-frame} appearance={recipes.media.broll}
      motion={recipes.motion.broll}/>`).join("\n");

  const audioRel = needsReferenceAudioAsset ? relativeAssetPath(layout.authorsDir, audioPath) : "";
  const heroId = scenes[0]?.id ?? "scene-1";

  let officialSpeakerImports = "";
  let voiceBlock = "";
  let videoArollGenerationBlock = "";
  let scriptBody = dialogue;
  let timelineTakes = "    <time:Take source={speech-semantic.take}/>";
  let heroVisualItems = "";
  let speechSemanticBlock = "";
  let speechNormalizeBlock = `  <pipeline:Normalize id="speech-media" source={reference-audio}
    video="none" audio="default" span-authority="audio" clock={clock}/>`;

  if (useOfficialSpeaker) {
    const voiceSamplePath = join(assetsDir, "voice-reference.wav");
    if (prepared?.voiceReferencePath !== undefined) {
      await copyFile(prepared.voiceReferencePath, voiceSamplePath);
    } else if (prepared?.generatedSpeechPath !== undefined) {
      await extractVoiceReferenceSample(prepared.generatedSpeechPath, voiceSamplePath);
    } else if (!capabilities.fishSpeech) {
      const speechSource = join(assetsDir, "generated-speech.wav");
      await resolveSpeechAudio({
        mode: "tts",
        session,
        destination: speechSource,
        ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
        scriptText: spokenText,
        extractReferenceAudio,
      });
      await extractVoiceReferenceSample(speechSource, voiceSamplePath);
    }
    const voiceRel = relativeAssetPath(layout.authorsDir, voiceSamplePath);
    const speakingScenes = scenes.filter((scene) => scene.text.replace(/\s+/gu, "").length > 0);
    const shotActions = await buildH3ShotActions({
      shots: groupScenesIntoShots(scenes, durationSec),
      insight,
      ...(treatment === undefined ? {} : { treatment }),
      ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
      workspaceRoot: session.workspaceRoot,
    });
    const official = buildOfficialSpeakerSvml({
      scenes,
      referenceDuration: durationSec,
      language,
      capabilities,
      voiceSampleText: speakingScenes[0]?.text ?? spokenText.slice(0, 120),
      voiceCastingDirection:
        "A clear, engaging Chinese short-form product presenter voice: bright, confident, conversational, with natural emphasis for social-video promo delivery.",
      ...(capabilities.fishSpeech ? {} : { voiceAssetRel: voiceRel }),
      productImageRef: "product-reference",
      ...(shotActions.size > 0 ? { shotActions } : {}),
    });
    officialSpeakerImports = official.imports;
    voiceBlock = official.voiceBlock;
    videoArollGenerationBlock = official.generationBlock;
    scriptBody = official.scriptBody;
    timelineTakes = official.timelineTakes;
    heroVisualItems = official.visualItems;
    speechSemanticBlock = official.semanticBlock;
    speechNormalizeBlock = "";
  } else {
    heroVisualItems = `    <media-track:Item id="hero" image={${heroId}.image}
      extent={scene-extent} during={story.segment.main}
      frame={speech-frame} appearance={recipes.media.hero}/>`;
    speechSemanticBlock = `  <whisperx:SemanticTake id="speech-semantic" narrative={story}
    segment={story.segment.main} media={speech-media.media} language="${language}"/>`;
  }

  const videoArollImport = useVideoAroll ? `\n  <import as="h3" from="@hypit/minimax-h3@1"/>${officialSpeakerImports}` : "";
  const phoneUgcImport = !hasProductReference ? `\n  <import as="ugc" source="@hypit/gpt-image-kits/phone-ugc-v1"/>` : "";
  const gptImport = sceneImageBlocks.length > 0 ? `\n  <import as="gpt" from="@hypit/gpt-image@1"/>` : "";
  const referenceAudioBlock = needsReferenceAudioAsset
    ? `\n  <asset:Audio id="reference-audio" src="${audioRel}"/>`
    : "";

  const svml = `<?svml using="@hypit/markup@1"?>
<svml>
  <import from="@hypit/script@1"/>
  <import as="text" from="@hypit/text@1"/>
  <import as="asset" from="@hypit/media@1"/>${gptImport}${phoneUgcImport}${videoArollImport}
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="whisperx" from="@hypit/whisperx@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="sound" from="@hypit/sound@1"/>
  <import as="media-track" from="@hypit/media-track@1"/>
  <import as="caption-fine" from="@hypit/caption-fine@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="spatial" from="@hypit/spatial@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="recipes" source="../recipes.svs"/>

  <script id="story">
${useOfficialSpeaker ? scriptBody : `    <main>\n      <NARRATOR>${scriptBody.replace(/[<>&]/gu, "")}\n    </main>`}
  </script>

${referenceAudioBlock}
${productAssetBlock}${voiceBlock}${sceneImageBlocks}

  <time:Clock id="clock" frame-rate="30"/>
  <spatial:Canvas id="vertical" width="${width}" height="${height}"/>
  <spatial:Frame id="speech-frame" within={vertical} left="0%" top="0%" right="100%" bottom="100%"/>
  <spatial:Frame id="broll-frame" within={vertical} left="8%" top="12%" right="92%" bottom="55%"/>
  <spatial:Extent id="scene-extent" width="${width}" height="${height}"/>
${videoArollGenerationBlock}
${speechNormalizeBlock}
${speechSemanticBlock}

  <time:Timeline id="speech" clock={clock}>
${timelineTakes}
  </time:Timeline>

  <sound:Style id="speech-sound-style"/>
  <sound:Track id="speech-sound" timeline={speech.timeline}>
    <sound:Use style={speech-sound-style}/>
  </sound:Track>

  <media-track:Track id="visual" timeline={speech.timeline} canvas={vertical}>
${heroVisualItems}
${brollItems}
  </media-track:Track>

  <fonts:Stack id="display-font" family="noto-sans-sc" weight="700" style="normal"/>
  <caption-fine:Style id="caption-style" recipe={recipes.caption.primary} font={display-font}/>
  <caption-fine:Track id="captions" document={story.caption} timeline={speech.timeline}>
    <caption-fine:Use style={caption-style}/>
  </caption-fine:Track>

  <film:Film id="main" canvas={vertical} timeline={speech.timeline} appearance={recipes.film.vertical}>
    <film:Track source={visual.visual}/>
    <film:Track source={speech-sound.audio}/>
    <film:Track source={captions.track}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={speech.timeline}/>
</svml>
`;

  await writeFile(layout.authorPath, svml, "utf8");
  await writeFile(layout.runPath, runMarkup("../authors/main.svml"), "utf8");

  await writeFile(join(productionDir, "REPLICA.md"), [
    "# 复刻工程",
    "",
    "格式：**" + formatId + "**（官方布局：`authors/` + `runs/`）",
    "",
    "参考片：" + (session.videoName ?? basename(session.videoPath)),
    "画幅：" + width + "×" + height + "，时长 " + durationSec + "s",
    "语言：" + language,
    "",
    "## 结构",
    ...scenes.map((scene) => "- " + scene.start + "s–" + scene.end + "s：" + scene.text.slice(0, 40) + "…"),
    "",
    ...(hasProductReference ? ["", "## 参考图与改编", "- 用户参考图已写入 `assets/product-reference.*`。",
      "- 口播文案：按爆款结构改写（对话模型），非参考片原文。",
      "- 配音：Fish VoiceDesign（若 Runtime 已绑定）或 TTS 音色样本（BYOK 兜底）。",
      useVideoAroll
        ? `- A-roll：h3-ugc-replica-v1 + H3 按参考片时间轴每 ≤15s 一镜（共 ${groupScenesIntoShots(scenes, durationSec).length} 镜，尾帧衔接），时间轴与字幕对齐 H3 口型音轨。`
        : "- 画面：`gpt:Image` 的 `<gpt:Reference>` 传入模型。", ""] : []),
    ...(!hasProductReference ? ["", "## 人物画面", "- 无参考图时使用官方 `phone-ugc-v1` 模板生成竖屏口播人物图。", ""] : []),
    "## 命令",
    "hypit plan runs/final.svrun",
    "hypit pricing runs/final.svrun",
    "hypit build runs/final.svrun --follow",
    "hypit studio --run runs/final.svrun",
  ].join("\n"), "utf8");

  return { authorPath: layout.authorPath, runPath: layout.runPath };
}
