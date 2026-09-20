import type { ScenePlan } from "./scene-plan.js";
import { measureSegmentSeconds } from "./measure-segments.js";
import { buildOfficialScript, sanitizeScriptId } from "./script-format.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";

/** Soft cap to avoid runaway cost; long scripts still get every segment up to this limit. */
const MAX_TAKES = 12;

function xmlEscape(text: string): string {
  return text.replace(/[<>&]/gu, "");
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
  const speaking = selectSpeakingScenes(input.scenes);
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
    const duration = measureSegmentSeconds(scene.text, input.language === "en" ? "en" : input.language === "es" ? "es" : "zh");
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
      extent={scene-extent} during={story.segment.${segId}}
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
