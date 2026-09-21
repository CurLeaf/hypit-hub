import { access, copyFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import type { ProductionLayout } from "./scaffold-paths.js";
import { runMarkup } from "./scaffold-paths.js";
import { buildScenePrompts, buildScenes } from "./scene-plan.js";
import { resolveSpeechAudio, type SpeechMode } from "./speech-synth.js";
import { extractReferenceAudio } from "./scaffold-ugc.js";

import type { AnalysisSessionView, TreatmentView, ViralInsightView } from "./shared.js";

const TIERS = ["s", "a", "b", "c", "d"] as const;

type RankingItem = {
  readonly id: string;
  readonly tier: string;
  readonly label: string;
  readonly text: string;
  readonly prompt: string;
};

function buildRankingItems(session: AnalysisSessionView, insight: ViralInsightView): readonly RankingItem[] {
  const segments = session.segments ?? [];
  const source = segments.length > 0
    ? segments.slice(0, 5)
    : [{ id: "segment-1", label: "段落 1", start: 0, end: session.probe?.duration ?? 15, text: insight.summary, wordCount: 0 }];
  return source.map((segment, index) => {
    const text = segment.text.replace(/\s+/gu, " ").trim();
    const id = "tier-" + (index + 1);
    return {
      id,
      tier: TIERS[index % TIERS.length]!,
      label: segment.label,
      text,
      prompt: "Square icon portrait for a tier-list ranking board, bold studio lighting, " + text.slice(0, 80) + ", no text, no logos, editorial product style.",
    };
  });
}

function chunkSpokenText(text: string, chunkSize = 6): string {
  const words = text.replace(/\s+/gu, "");
  if (words.length === 0) return "";
  const chunks: string[] = [];
  for (let offset = 0; offset < words.length; offset += chunkSize) {
    chunks.push(words.slice(offset, offset + chunkSize));
  }
  return chunks.join(" || ");
}

function rankingDialogue(
  items: readonly RankingItem[],
  scenes: ReturnType<typeof buildScenes>,
  speechMode: SpeechMode,
): { readonly dialogue: string; readonly spokenText: string } {
  const scriptParts: string[] = [];
  const spokenParts: string[] = [];

  if (speechMode === "tts") {
    const intro = "今天我们来给这些内容排个级。";
    scriptParts.push(intro);
    spokenParts.push(intro);
  }

  for (const [index, item] of items.entries()) {
    const words = item.text.replace(/\s+/gu, "");
    const body = words.length > 0 ? chunkSpokenText(item.text) : chunkSpokenText(item.label);
    if (body.length === 0) continue;
    scriptParts.push("@" + item.id + " " + body + " @/" + item.id);
    spokenParts.push(words.length > 0 ? words : item.label.replace(/\s+/gu, ""));

    const scene = scenes[index + 1];
    if (scene !== undefined && scene.text.length > 0) {
      const sceneBody = chunkSpokenText(scene.text);
      if (sceneBody.length > 0) {
        scriptParts.push("@" + scene.momentId + " " + sceneBody + " @/" + scene.momentId);
        spokenParts.push(scene.text.replace(/\s+/gu, ""));
      }
    }
  }

  return {
    dialogue: scriptParts.join(" || "),
    spokenText: spokenParts.join(""),
  };
}

async function copyRankingSfx(templateAssetsDir: string, assetsDir: string): Promise<void> {
  const missing: string[] = [];
  for (const asset of ["ranking-appear.wav", "ranking-move.wav"]) {
    const source = join(templateAssetsDir, asset);
    try {
      await access(source);
      await copyFile(source, join(assetsDir, asset));
    } catch {
      missing.push(source);
    }
  }
  if (missing.length > 0) {
    throw new Error("缺少 Ranking 音效：" + missing.join("、"));
  }
}

export async function generateRankingReplicaProject(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment: TreatmentView;
  readonly productionDir: string;
  readonly layout: ProductionLayout;
  readonly templateAssetsDir: string;
  readonly workspaceRoot: string;
  readonly runtimePath?: string;
  readonly speechMode: SpeechMode;
}): Promise<{ readonly authorPath: string; readonly runPath: string }> {
  const { session, insight, treatment, layout, productionDir, templateAssetsDir } = input;
  if (session.probe === undefined) throw new Error("缺少媒体探测信息");

  const assetsDir = layout.assetsDir;
  await copyRankingSfx(templateAssetsDir, assetsDir);

  const items = buildRankingItems(session, insight);
  const baseScenes = buildScenes(session, insight);
  const promptMap = await buildScenePrompts({
    session,
    insight,
    treatment,
    formatId: "ranking",
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    scenes: baseScenes,
  });
  const scenes = buildScenes(session, insight, promptMap);
  const brollScenes = items
    .map((_, index) => scenes[index + 1])
    .filter((scene): scene is NonNullable<typeof scene> => scene !== undefined && scene.text.length > 0);
  const { dialogue, spokenText } = rankingDialogue(items, scenes, input.speechMode);

  const audioPath = join(assetsDir, input.speechMode === "tts" ? "generated-speech.wav" : "reference-audio.wav");
  await resolveSpeechAudio({
    mode: input.speechMode,
    session,
    destination: audioPath,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    scriptText: spokenText,
    extractReferenceAudio,
  });
  const language = session.transcript?.language ?? "zh";
  const width = Math.max(720, session.probe.width);
  const height = Math.max(1280, session.probe.height);

  const presenterPrompt = "Vertical 9:16 classroom or studio host, confident presenter holding microphone, cinematic UGC lighting, Chinese short video ranking show, no readable text.";
  const iconBlocks = items.map((item) => `
  <text:Value id="${item.id}-icon-prompt">${item.prompt.replace(/[<>&]/gu, "")}</text:Value>
  <gpt:Image id="${item.id}-icon" prompt={${item.id}-icon-prompt} aspect-ratio="1:1" resolution="1K"/>`).join("\n");

  const brollBlocks = brollScenes.map((scene) => `
  <text:Value id="${scene.id}-prompt">${scene.prompt.replace(/[<>&]/gu, "")}</text:Value>
  <gpt:Image id="${scene.id}" prompt={${scene.id}-prompt} aspect-ratio="1:1" resolution="1K"/>`).join("\n");

  const tierItems = items.map((item) => `
    <ranking:TierItem id="${item.id}-row" tier="${item.tier}" entry="drop" icon={${item.id}-icon.image} during={story.selection.${item.id}}/>`).join("\n");

  const brollItems = brollScenes.map((scene) => `
    <media-track:Item id="${scene.id}-card" image={${scene.id}.image}
      extent={broll-extent} during={story.selection.${scene.momentId}}
      frame={broll-frame} appearance={recipes.media.broll}
      motion={recipes.motion.broll}/>`).join("\n");

  const audioRel = "./../assets/" + basename(audioPath);
  const appearRel = "./../assets/ranking-appear.wav";
  const moveRel = "./../assets/ranking-move.wav";

  const svml = `<?svml using="@hypit/markup@1"?>
<svml>
  <import from="@hypit/script@1"/>
  <import as="text" from="@hypit/text@1"/>
  <import as="asset" from="@hypit/media@1"/>
  <import as="gpt" from="@hypit/gpt-image@1"/>
  <import as="pipeline" from="@hypit/media-pipeline@1"/>
  <import as="whisperx" from="@hypit/whisperx@1"/>
  <import as="time" from="@hypit/timeline-author@1"/>
  <import as="sound" from="@hypit/sound@1"/>
  <import as="media-track" from="@hypit/media-track@1"/>
  <import as="caption-fine" from="@hypit/caption-fine@1"/>
  <import as="fonts" from="@hypit/fonts-open@1"/>
  <import as="spatial" from="@hypit/spatial@1"/>
  <import as="program" from="@hypit/program-space@1"/>
  <import as="ranking" from="@hypit/ranking@1"/>
  <import as="film" from="@hypit/film@1"/>
  <import as="render" from="@hypit/render-hyperframes@1"/>
  <import as="recipes" source="../recipes.svs"/>

  <script id="story">
    <main>
      <HOST>${dialogue.replace(/[<>&]/gu, "")}
    </main>
  </script>

  <text:Value id="presenter-prompt">${presenterPrompt}</text:Value>
  <gpt:Image id="presenter" prompt={presenter-prompt} aspect-ratio="9:16" resolution="1K"/>
  <asset:Audio id="speech-audio" src="${audioRel}"/>
  <asset:Audio id="ranking-appear-sfx" src="${appearRel}"/>
  <asset:Audio id="ranking-move-sfx" src="${moveRel}"/>
${iconBlocks}
${brollBlocks}

  <program:Clock id="clock" frame-rate="30"/>
  <spatial:Canvas id="vertical" width="${width}" height="${height}"/>
  <spatial:Frame id="speech-frame" within={vertical} left="0%" top="0%" right="100%" bottom="52%"/>
  <spatial:Frame id="tier-frame" within={vertical} left="0%" top="55%" right="100%" bottom="100%"/>
  <spatial:Frame id="broll-frame" within={vertical} left="10%" top="18%" right="90%" bottom="48%"/>
  <spatial:Extent id="hero-extent" width="${width}" height="${Math.round(height * 0.55)}"/>
  <spatial:Extent id="broll-extent" width="1024" height="1024"/>

  <pipeline:Normalize id="speech-media" source={speech-audio}
    video="none" audio="default" span-authority="audio" clock={clock}/>
  <pipeline:Normalize id="ranking-appear-media" source={ranking-appear-sfx}
    video="none" audio="default" span-authority="audio" clock={clock}/>
  <pipeline:Normalize id="ranking-move-media" source={ranking-move-sfx}
    video="none" audio="default" span-authority="audio" clock={clock}/>
  <whisperx:SemanticTake id="speech-semantic" narrative={story}
    segment={story.segment.main} media={speech-media.media} language="${language}"/>

  <time:Timeline id="speech" clock={clock}>
    <time:Take source={speech-semantic.take}/>
  </time:Timeline>

  <sound:Style id="speech-sound-style"/>
  <sound:Track id="speech-sound" timeline={speech.timeline}>
    <sound:Use style={speech-sound-style}/>
  </sound:Track>

  <media-track:Track id="hero" timeline={speech.timeline} canvas={vertical}>
    <media-track:Item id="presenter-card" image={presenter.image}
      extent={hero-extent} during="program"
      frame={speech-frame} appearance={recipes.media.hero}/>
${brollItems}
  </media-track:Track>

  <fonts:Stack id="display-font" family="noto-sans-sc" weight="700" style="normal"/>
  <fonts:Stack id="tier-font" family="noto-sans-sc" weight="400" style="normal"/>
  <ranking:TierBoardStyle id="tier-style" recipe={recipes.ranking.football} font={tier-font}/>
  <ranking:TierBoard id="tiers" timeline={speech.timeline} canvas={vertical} frame={tier-frame}
    during="program" style={tier-style}
    appear-sound={ranking-appear-media.media}
    move-sound={ranking-move-media.media}>
${tierItems}
  </ranking:TierBoard>

  <caption-fine:Style id="caption-style" recipe={recipes.caption.primary} font={display-font}/>
  <caption-fine:Track id="captions" document={story.caption} timeline={speech.timeline}>
    <caption-fine:Use style={caption-style}/>
  </caption-fine:Track>

  <film:Film id="main" canvas={vertical} timeline={speech.timeline} appearance={recipes.film.vertical}>
    <film:Track source={hero.visual}/>
    <film:Track source={speech-sound.audio}/>
    <film:Track source={tiers.visual}/>
    <film:Track source={tiers.audio}/>
    <film:Track source={captions.track}/>
  </film:Film>
  <render:Video id="final" composition={main.composition} timeline={speech.timeline}/>
</svml>
`;

  await writeFile(layout.authorPath, svml, "utf8");
  await writeFile(layout.runPath, runMarkup("../authors/main.svml"), "utf8");
  await writeFile(join(productionDir, "REPLICA.md"), [
    "# Ranking 复刻工程",
    "",
    "格式：榜单 / tier-list（@hypit/ranking + TierBoard）",
    "口播：" + input.speechMode,
    "",
    ...items.map((item) => "- " + item.tier.toUpperCase() + " · " + item.text.slice(0, 40)),
    "",
    "hypit plan runs/final.svrun",
    "hypit build runs/final.svrun --follow",
  ].join("\n"), "utf8");

  return { authorPath: layout.authorPath, runPath: layout.runPath };
}
