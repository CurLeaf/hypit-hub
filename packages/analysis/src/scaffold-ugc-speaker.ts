import type { SpeechEstimateLanguage } from "@hypit/estimate";

import { sanitizeH3ShotAction } from "./h3-shot-prompt.js";
import type { ScenePlan } from "./scene-plan.js";
import {
  fitsH3Duration,
  H3_MAX_DURATION_SEC,
  H3_MIN_DURATION_SEC,
  resolveMeasureLanguage,
} from "./measure-segments.js";
import { buildOfficialScript, sanitizeScriptId } from "./script-format.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import { groupScenesIntoShots, type ShotPlan } from "./shot-plan.js";

/** Soft cap to avoid runaway cost; long references are truncated to this many H3 shots. */
export const MAX_H3_TAKES = 12;

const PHRASE_DELIMITER = /([。！？!?；;，,、])/u;

function xmlEscape(text: string): string {
  return text.replace(/[<>&]/gu, "");
}

function compactLen(text: string): number {
  return text.replace(/\s+/gu, "").length;
}

function splitKeepingDelimiters(text: string): string[] {
  const parts = text.split(PHRASE_DELIMITER);
  const phrases: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const piece = parts[index] ?? "";
    if (piece.length === 0) continue;
    if (PHRASE_DELIMITER.test(piece) && phrases.length > 0) {
      phrases[phrases.length - 1] += piece;
      continue;
    }
    phrases.push(piece);
  }
  return phrases.length > 0 ? phrases : [text];
}

function tokensForHardSplit(text: string, language: SpeechEstimateLanguage): string[] {
  if (language === "en" || language === "es") {
    return text.match(/\S+\s*/gu) ?? [...text];
  }
  return [...text];
}

function greedyPack(text: string, language: SpeechEstimateLanguage): string[] {
  const tokens = tokensForHardSplit(text, language);
  const packed: string[] = [];
  let current = "";
  for (const token of tokens) {
    const trial = current + token;
    if (current.length > 0 && !fitsH3Duration(trial, language)) {
      packed.push(current.trim());
      current = token;
      continue;
    }
    current = trial;
  }
  if (current.trim().length > 0) packed.push(current.trim());
  return packed;
}

/** Split spoken copy so each piece's estimated delivery fits one H3 request (≤15s). */
export function splitSpokenTextForH3(
  text: string,
  language: SpeechEstimateLanguage | string = "zh",
): string[] {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return [];
  const resolved = resolveMeasureLanguage(language);
  if (fitsH3Duration(trimmed, resolved)) return [trimmed];

  const packed: string[] = [];
  let current = "";
  const flush = (): void => {
    const value = current.trim();
    if (value.length > 0) packed.push(value);
    current = "";
  };

  for (const phrase of splitKeepingDelimiters(trimmed)) {
    const trial = `${current}${phrase}`;
    if (fitsH3Duration(trial.trim(), resolved)) {
      current = trial;
      continue;
    }
    flush();
    if (fitsH3Duration(phrase.trim(), resolved)) {
      current = phrase;
      continue;
    }
    packed.push(...greedyPack(phrase, resolved));
  }
  flush();
  return packed.length > 0 ? packed : [trimmed];
}

/** Turn over-long scenes into sequential H3 takes; later fused on the Film timeline. */
export function packScenesForH3(
  scenes: readonly ScenePlan[],
  language: SpeechEstimateLanguage | string = "zh",
): readonly ScenePlan[] {
  const resolved = resolveMeasureLanguage(language);
  const packed: ScenePlan[] = [];
  for (const scene of scenes) {
    const parts = splitSpokenTextForH3(scene.text, resolved);
    if (parts.length <= 1) {
      packed.push(parts.length === 1 ? { ...scene, text: parts[0]! } : scene);
      continue;
    }
    const totalUnits = parts.reduce((sum, part) => sum + Math.max(1, compactLen(part)), 0);
    const span = Math.max(0, scene.end - scene.start);
    let cursor = scene.start;
    parts.forEach((text, index) => {
      const weight = Math.max(1, compactLen(text)) / totalUnits;
      const duration = span * weight;
      const start = cursor;
      const end = index === parts.length - 1 ? scene.end : start + duration;
      cursor = end;
      const takeId = `${scene.id}-t${index + 1}`;
      packed.push({
        ...scene,
        id: takeId,
        momentId: takeId,
        start,
        end,
        text,
      });
    });
  }
  return packed;
}

export function selectSpeakingScenes(scenes: readonly ScenePlan[]): readonly ScenePlan[] {
  const spoken = scenes.filter((scene) => scene.text.replace(/\s+/gu, "").length > 0);
  if (spoken.length <= MAX_H3_TAKES) return spoken;
  return spoken.slice(0, MAX_H3_TAKES);
}

export function selectH3Shots(
  scenes: readonly ScenePlan[],
  referenceDuration: number,
): {
  readonly shots: readonly ShotPlan[];
  readonly plannedTakeCount: number;
  readonly truncated: boolean;
} {
  const all = groupScenesIntoShots(scenes, referenceDuration);
  const truncated = all.length > MAX_H3_TAKES;
  return {
    shots: truncated ? all.slice(0, MAX_H3_TAKES) : all,
    plannedTakeCount: all.length,
    truncated,
  };
}

/** Timeline slot for one H3 request (4–15s); last shot keeps the remainder from the reference. */
export function measureH3ShotDuration(shot: { readonly durationSeconds: number }): number {
  const seconds = Math.ceil(shot.durationSeconds);
  return Math.min(H3_MAX_DURATION_SEC, Math.max(H3_MIN_DURATION_SEC, seconds));
}

export function buildH3ShotActionFallback(shot: {
  readonly index: number;
  readonly scenePromptHint: string;
}): string {
  const hint = shot.scenePromptHint.trim();
  const parts = [
    "Vertical 9:16 UGC product presenter shot; lip-sync the supplied script with natural emphasis.",
    hint.length > 0 ? hint : "Keep the product or subject from the reference image clearly visible.",
    shot.index === 0
      ? "Open with strong hook energy in the first three seconds."
      : "Continue seamlessly from the prior clip with matching lighting, wardrobe, and framing.",
  ];
  return parts.join(" ");
}

export function resolveH3ShotAction(
  shot: Pick<ShotPlan, "id" | "index" | "scenePromptHint">,
  actionMap?: ReadonlyMap<string, string>,
): string {
  const mapped = actionMap?.get(shot.id);
  if (mapped !== undefined) {
    const sanitized = sanitizeH3ShotAction(mapped);
    if (sanitized !== undefined) return sanitized;
  }
  return buildH3ShotActionFallback(shot);
}

type H3Take = {
  readonly id: string;
  readonly text: string;
  readonly shot: ShotPlan;
};

function resolveReferenceDuration(
  scenes: readonly ScenePlan[],
  referenceDuration: number,
): number {
  if (referenceDuration > 0) return referenceDuration;
  const sceneEnd = scenes.reduce((max, scene) => Math.max(max, scene.end), 0);
  return Math.max(4, Math.ceil(sceneEnd));
}

function expandShotsForH3(shots: readonly ShotPlan[]): readonly H3Take[] {
  return shots.map((shot) => ({ id: shot.id, text: shot.text, shot }));
}

export function buildOfficialSpeakerSvml(input: {
  readonly scenes: readonly ScenePlan[];
  readonly referenceDuration?: number;
  readonly language: string;
  readonly capabilities: RuntimeCapabilities;
  readonly voiceSampleText: string;
  readonly voiceCastingDirection: string;
  readonly voiceAssetRel?: string;
  readonly productImageRef: string;
  readonly shotActions?: ReadonlyMap<string, string>;
}): {
  readonly scriptBody: string;
  readonly imports: string;
  readonly voiceBlock: string;
  readonly generationBlock: string;
  readonly semanticBlock: string;
  readonly timelineTakes: string;
  readonly visualItems: string;
  readonly voiceAudioRef: string;
  readonly h3ShotPlan: {
    readonly takeCount: number;
    readonly plannedTakeCount: number;
    readonly truncated: boolean;
  };
} {
  const referenceDuration = resolveReferenceDuration(input.scenes, input.referenceDuration);
  const { shots, plannedTakeCount, truncated } = selectH3Shots(input.scenes, referenceDuration);
  const takes = expandShotsForH3(shots);
  const scriptBody = buildOfficialScript(takes.map((take) => ({
    id: sanitizeScriptId(take.id),
    text: take.text,
  })));

  const imports = [
    input.capabilities.fishSpeech ? `\n  <import as="fish" from="@hypit/fishaudio-speech@1"/>` : "",
    `\n  <import as="h3-kit" source="@hypit/minimax-h3-kits/ugc-replica"/>`,
  ].join("");

  const voiceSample = xmlEscape(input.voiceSampleText.slice(0, 200));
  const casting = xmlEscape(input.voiceCastingDirection);
  let voiceBlock: string;
  let voiceAudioRef: string;
  if (input.capabilities.fishSpeech) {
    voiceBlock = `
  <text:Value id="presenter-voice-sample">${voiceSample}</text:Value>
  <fish:VoiceDesign id="presenter-voice" speech={presenter-voice-sample}>
    ${casting}
  </fish:VoiceDesign>`;
    voiceAudioRef = "presenter-voice.reference";
  } else if (input.voiceAssetRel !== undefined) {
    voiceBlock = `\n  <asset:Audio id="presenter-voice" src="${input.voiceAssetRel}"/>`;
    voiceAudioRef = "presenter-voice";
  } else {
    voiceBlock = "";
    voiceAudioRef = "voice-reference";
  }

  const takeBlocks: string[] = [];
  const semanticBlocks: string[] = [];
  const timelineTakes: string[] = [];
  const visualItems: string[] = [];

  for (const [index, take] of takes.entries()) {
    const takeId = sanitizeScriptId(take.id);
    const duration = measureH3ShotDuration({ durationSeconds: take.shot.durationSeconds });
    const action = xmlEscape(resolveH3ShotAction(take.shot, input.shotActions));
    const imageRef = index === 0
      ? input.productImageRef
      : `${sanitizeScriptId(takes[index - 1]!.id)}-last.image`;
    const blocks = [
      `
  <text:Value id="${takeId}-action">${action}</text:Value>
  <text:Render id="${takeId}-prompt" template={h3-kit.h3-ugc-replica-v1} recipe={recipes.speaker.host}>
    <text:Set name="dialogue" text={story.segment.${takeId}.dialogue}/>
    <text:Set name="action" text={${takeId}-action}/>
  </text:Render>
  <h3:ReferenceVideo id="${takeId}-take" prompt={${takeId}-prompt} duration="${duration}"
    resolution="768P" aspect-ratio="9:16">
    <h3:Reference image={${imageRef}}/>
    <h3:Reference audio={${voiceAudioRef}}/>
  </h3:ReferenceVideo>
  <pipeline:Normalize id="${takeId}-media" source={${takeId}-take.video}
    video="primary-moving" audio="default" span-authority="video" clock={clock}/>`,
    ];
    if (index < takes.length - 1) {
      blocks.push(`
  <pipeline:ExtractFrame id="${takeId}-last" source={${takeId}-take.video}
    video="primary-moving" at="last"/>`);
    }
    takeBlocks.push(blocks.join(""));
    semanticBlocks.push(`
  <whisperx:SemanticTake id="${takeId}-semantic" narrative={story}
    segment={story.segment.${takeId}} media={${takeId}-media.media} language="${input.language}"/>`);
    timelineTakes.push(`    <time:Take source={${takeId}-semantic.take}/>`);
    visualItems.push(`    <media-track:Item id="${takeId}-hero" media={${takeId}-media.media}
      during={story.segment.${takeId}}
      frame={speech-frame} appearance={recipes.media.hero}/>`);
  }

  return {
    scriptBody,
    imports,
    voiceBlock,
    generationBlock: takeBlocks.join("\n"),
    semanticBlock: semanticBlocks.join("\n"),
    timelineTakes: timelineTakes.join("\n"),
    visualItems: visualItems.join("\n"),
    voiceAudioRef,
    h3ShotPlan: {
      takeCount: takes.length,
      plannedTakeCount,
      truncated,
    },
  };
}
