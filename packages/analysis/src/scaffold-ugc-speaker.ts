import type { SpeechEstimateLanguage } from "@hypit/estimate";

import type { ScenePlan } from "./scene-plan.js";
import {
  fitsH3Duration,
  measureSegmentSeconds,
  resolveMeasureLanguage,
} from "./measure-segments.js";
import { buildOfficialScript, sanitizeScriptId } from "./script-format.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";

/** Soft cap to avoid runaway cost; long scripts still get every segment up to this limit. */
const MAX_TAKES = 12;

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
  if (spoken.length <= MAX_TAKES) return spoken;
  return spoken.slice(0, MAX_TAKES);
}

export function buildOfficialSpeakerSvml(input: {
  readonly scenes: readonly ScenePlan[];
  readonly language: string;
  readonly capabilities: RuntimeCapabilities;
  readonly voiceSampleText: string;
  readonly voiceCastingDirection: string;
  readonly voiceAssetRel?: string;
  readonly productImageRef: string;
}): {
  readonly scriptBody: string;
  readonly imports: string;
  readonly voiceBlock: string;
  readonly generationBlock: string;
  readonly semanticBlock: string;
  readonly timelineTakes: string;
  readonly visualItems: string;
  readonly voiceAudioRef: string;
} {
  const speaking = selectSpeakingScenes(packScenesForH3(input.scenes, input.language));
  const scriptBody = buildOfficialScript(speaking.map((scene) => ({
    id: sanitizeScriptId(scene.momentId),
    text: scene.text,
  })));

  const imports = [
    input.capabilities.fishSpeech ? `\n  <import as="fish" from="@hypit/fishaudio-speech@1"/>` : "",
    `\n  <import as="speaker-kit" source="@hypit/seedance-kits/speaker"/>`,
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

  for (const scene of speaking) {
    const segId = sanitizeScriptId(scene.momentId);
    const duration = measureSegmentSeconds(scene.text, input.language);
    const action = xmlEscape(
      "Deliver this passage as an engaged vertical social-video product presenter. "
      + "Natural lip-sync, lively emphasis, small posture shifts between phrases. "
      + "Keep the product/subject from the reference image clearly visible.",
    );
    takeBlocks.push(`
  <text:Value id="${segId}-action">${action}</text:Value>
  <text:Render id="${segId}-prompt" template={speaker-kit.speaker-v1} recipe={recipes.speaker.host}>
    <text:Set name="dialogue" text={story.segment.${segId}.dialogue}/>
    <text:Set name="action" text={${segId}-action}/>
  </text:Render>
  <h3:ReferenceVideo id="${segId}-take" prompt={${segId}-prompt} duration="${duration}"
    resolution="768P" aspect-ratio="9:16">
    <h3:Reference image={${input.productImageRef}}/>
    <h3:Reference audio={${voiceAudioRef}}/>
  </h3:ReferenceVideo>
  <pipeline:Normalize id="${segId}-media" source={${segId}-take.video}
    video="primary-moving" audio="default" span-authority="video" clock={clock}/>
  <whisperx:SemanticTake id="${segId}-semantic" narrative={story}
    segment={story.segment.${segId}} media={${segId}-media.media} language="${input.language}"/>`);
    semanticBlocks.push("");
    timelineTakes.push(`    <time:Take source={${segId}-semantic.take}/>`);
    visualItems.push(`    <media-track:Item id="${segId}-hero" media={${segId}-media.media}
      during={story.segment.${segId}}
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
  };
}
