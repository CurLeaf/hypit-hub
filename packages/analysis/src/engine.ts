import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { MemoryResourceStore } from "@hypit/driver-node";
import type { Need } from "@hypit/protocol";
import { sealSpeechEvidenceAudio } from "@hypit/speech";
import { speechEvidenceTypes } from "@hypit/speech-evidence";
import type { AlignedTranscriptEvidence } from "@hypit/speech-evidence";
import { whisperXCapabilities, whisperXRequestForEvidenceAudio } from "@hypit/whisperx";
import type { WhisperXLanguage } from "@hypit/whisperx";
import {
  creationEnvironment,
  extractSpeechEvidenceBytes,
  probeMedia,
  readTranscript,
  tileFrames,
  tileSampleTimes,
  visualBoundaries,
  type CreationHost,
} from "@hypit/video-cli";

import { writeReferenceArchive } from "./reference-archive.js";

import type {
  AnalysisSessionView,
  FormatSuggestionView,
  SpeechSegmentView,
  StructureEventView,
  TranscriptPassageView,
  TranscriptWordView,
} from "./shared.js";
import { joinTranscriptText, transcriptSnippetAt } from "./transcript-text.js";
import { formatTime } from "./shared.js";

const EVIDENCE_SAMPLE_RATE = 16_000;

function round(value: number): number { return Number(value.toFixed(3)); }

function seconds(sample: number | undefined): number | undefined {
  return sample === undefined ? undefined : round(sample / EVIDENCE_SAMPLE_RATE);
}

function passagesFromAligned(aligned: AlignedTranscriptEvidence): readonly TranscriptPassageView[] {
  return aligned.passages.map((passage) => {
    const words = passage.words.map((word): TranscriptWordView => {
      const start = seconds(word.startSample);
      const end = seconds(word.endSampleExclusive);
      return {
        text: word.text,
        ...(start === undefined ? {} : { start }),
        ...(end === undefined ? {} : { end }),
      };
    });
    const start = seconds(passage.startSample);
    const end = seconds(passage.endSampleExclusive);
    return {
      text: words.map((word) => word.text).join(" "),
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      words,
    };
  });
}

export async function transcribeVideo(input: {
  readonly source: string;
  readonly language: WhisperXLanguage;
  readonly host: CreationHost;
  onPhase?(phase: string): void;
}): Promise<{ readonly passages: readonly TranscriptPassageView[]; readonly words: readonly TranscriptWordView[] }> {
  const evidence = await extractSpeechEvidenceBytes(input.source);
  const resources = new MemoryResourceStore();
  const artifact = await resources.put(evidence.bytes, "audio/wav");
  const audio = sealSpeechEvidenceAudio({ artifact, sampleFrames: evidence.sampleFrames });
  const need: Need = {
    id: "need:hypit-analysis-transcribe",
    capability: whisperXCapabilities.alignment,
    returns: speechEvidenceTypes.alignedTranscript,
    constraints: whisperXRequestForEvidenceAudio(audio, { language: input.language }),
    result: "record:hypit-analysis-transcribe",
  };
  let previousPhase: string | undefined;
  const fulfillment = await input.host.invoke(need, resources, {
    reportProgress: async (progress) => {
      if (progress.phase === previousPhase) return;
      previousPhase = progress.phase;
      input.onPhase?.(progress.phase);
    },
    reportDiagnostic: async (diagnostic) => { input.onPhase?.(diagnostic.message); },
  });
  if (fulfillment.value.kind !== "inline") throw new Error("转写结果不可用");
  const passages = passagesFromAligned(fulfillment.value.value as unknown as AlignedTranscriptEvidence);
  const words = passages.flatMap((passage) => passage.words);
  return { passages, words };
}

export function deriveSpeechSegments(words: readonly TranscriptWordView[], gapSeconds = 0.85): readonly SpeechSegmentView[] {
  if (words.length === 0) return [];
  const segments: SpeechSegmentView[] = [];
  let current: TranscriptWordView[] = [];
  let segmentStart = words[0]!.start ?? 0;
  for (const word of words) {
    const previous = current.at(-1);
    const gap = previous?.end !== undefined && word.start !== undefined ? word.start - previous.end : 0;
    if (current.length > 0 && gap >= gapSeconds) {
      const end = previous?.end ?? segmentStart;
      segments.push({
        id: `segment-${segments.length + 1}`,
        label: `段落 ${segments.length + 1}`,
        start: segmentStart,
        end,
        text: joinTranscriptText(current),
        wordCount: current.length,
      });
      current = [];
      segmentStart = word.start ?? end;
    }
    current.push(word);
  }
  if (current.length > 0) {
    const end = current.at(-1)?.end ?? segmentStart;
    segments.push({
      id: `segment-${segments.length + 1}`,
      label: `段落 ${segments.length + 1}`,
      start: segmentStart,
      end,
      text: joinTranscriptText(current),
      wordCount: current.length,
    });
  }
  return segments;
}

export function deriveStructureEvents(input: {
  readonly duration: number;
  readonly segments: readonly SpeechSegmentView[];
  readonly boundaries: readonly { readonly at: number; readonly score: number }[];
  readonly words: readonly TranscriptWordView[];
}): readonly StructureEventView[] {
  const events: StructureEventView[] = [];
  const hookEnd = Math.min(5, input.duration);
  const hookWords = input.words.filter((word) => (word.end ?? word.start ?? 0) <= hookEnd);
  events.push({
    id: "hook",
    kind: "hook",
    at: 0,
    end: hookEnd,
    title: "开场 Hook",
    detail: hookWords.length > 0
      ? joinTranscriptText(hookWords)
      : "前 5 秒画面与节奏决定留存；检查是否有强对比、悬念或视觉冲击。",
  });
  for (const segment of input.segments) {
    events.push({
      id: segment.id,
      kind: "segment",
      at: segment.start,
      end: segment.end,
      title: segment.label,
      detail: segment.text,
    });
  }
  for (const [index, boundary] of input.boundaries.slice(0, 24).entries()) {
    events.push({
      id: `cut-${index + 1}`,
      kind: "visual-cut",
      at: boundary.at,
      title: `画面变化 ${formatTime(boundary.at)}`,
      detail: `视觉差异分数 ${boundary.score.toFixed(2)}；可能是切镜、转场或图形出现。`,
    });
  }
  const ranked = [...input.boundaries].sort((left, right) => right.score - left.score).slice(0, 3);
  for (const [index, boundary] of ranked.entries()) {
    const narration = transcriptSnippetAt(input.words, boundary.at);
    const narrationNote = narration.length > 0 ? `此时口播：「${narration.slice(0, 40)}${narration.length > 40 ? "…" : ""}」。` : "";
    events.push({
      id: `moment-${index + 1}`,
      kind: "moment",
      at: boundary.at,
      title: `高冲击 Moment ${index + 1}`,
      detail: `在 ${formatTime(boundary.at)} 附近画面变化最强，适合作为揭晓、转场或强调点。${narrationNote}`,
    });
  }
  return events.sort((left, right) => left.at - right.at);
}

export function suggestFormats(input: {
  readonly duration: number;
  readonly segments: readonly SpeechSegmentView[];
  readonly words: readonly TranscriptWordView[];
  readonly width: number;
  readonly height: number;
}): readonly FormatSuggestionView[] {
  const joined = input.words.map((word) => word.text).join(" ").toLowerCase();
  const vertical = input.height > input.width;
  const suggestions: FormatSuggestionView[] = [];
  if (/rank|tier|top|第.{0,2}名|排行|榜单|级别/u.test(joined)) {
    suggestions.push({
      id: "ranking",
      title: "Ranking / 榜单",
      confidence: "high",
      reason: "台词或结构出现排名、分级、对比语言。",
      example: "examples/ranking-football/reference.svml",
    });
  }
  if (/host|guest|采访|问答|你觉得|为什么/u.test(joined) || input.segments.length >= 4) {
    suggestions.push({
      id: "interview",
      title: "街头采访 / 对话",
      confidence: input.segments.length >= 4 ? "medium" : "low",
      reason: "多段口语交替或采访式提问结构。",
      example: "examples/interview/reference.svml",
    });
  }
  if (/podcast|播客|我们|今天聊/u.test(joined)) {
    suggestions.push({
      id: "podcast",
      title: "播客 / 双人对话",
      confidence: "medium",
      reason: "长段叙述或播客式开场。",
      example: "examples/podcast/reference.svml",
    });
  }
  if (vertical && input.duration <= 90) {
    suggestions.push({
      id: "ugc",
      title: "竖屏 UGC / 口播",
      confidence: "medium",
      reason: "竖屏短视频时长与口播密度匹配信息流形态。",
      example: "examples/byok-openai-compatible/minimal.svml",
    });
  }
  suggestions.push({
    id: "explainer",
    title: "讲解 / 产品说明",
    confidence: suggestions.length === 0 ? "high" : "low",
    reason: "通用讲解片结构：Hook → 论证 → 演示 → 收束。",
    example: "examples/complex-explainer/productions/explainer/",
  });
  return suggestions;
}

export async function generateOverviewTile(source: string, duration: number, destination: string): Promise<string> {
  const end = Math.min(duration, 30);
  const count = Math.min(12, Math.max(4, Math.ceil(end)));
  const times = count >= 2 ? tileSampleTimes(0, end, count) : [round(end / 2)];
  await tileFrames(source, times, destination, 240, 4);
  return destination;
}

export async function runFullAnalysis(input: {
  readonly workspaceRoot: string;
  readonly videoPath: string;
  readonly language: WhisperXLanguage;
  readonly runtimePath?: string;
  onPhase?(phase: string): void;
}): Promise<AnalysisSessionView> {
  const videoName = input.videoPath.split(/[\\/]/u).pop();
  const probe = await probeMedia(input.videoPath);
  input.onPhase?.("探测画面与音频…");
  const boundaries = await visualBoundaries(input.videoPath);
  input.onPhase?.("检测画面变化…");
  const analysisDir = join(input.workspaceRoot, ".hypit", "analysis");
  await mkdir(analysisDir, { recursive: true });
  const tilePath = join(analysisDir, "overview-tile.jpg");
  await generateOverviewTile(input.videoPath, probe.duration, tilePath);
  let passages: readonly TranscriptPassageView[] = [];
  let words: readonly TranscriptWordView[] = [];
  let transcriptPath: string | undefined;
  if (probe.hasAudio) {
    input.onPhase?.("转写对白…");
    const environment = creationEnvironment(input.workspaceRoot);
    const { host } = await environment.openHost(input.runtimePath, input.workspaceRoot);
    const transcript = await transcribeVideo({
      source: input.videoPath,
      language: input.language,
      host,
      ...(input.onPhase === undefined ? {} : { onPhase: input.onPhase }),
    });
    passages = transcript.passages;
    words = transcript.words;
    transcriptPath = join(analysisDir, "transcript.json");
    await writeFile(transcriptPath, `${JSON.stringify({
      format: "hypit.transcript@1",
      source: input.videoPath,
      language: input.language,
      audio_seconds: probe.duration,
      passages: passages.map((passage) => ({
        text: passage.text,
        ...(passage.start === undefined ? {} : { start_seconds: passage.start }),
        ...(passage.end === undefined ? {} : { end_seconds: passage.end }),
        words: passage.words.map((word) => ({
          text: word.text,
          ...(word.start === undefined ? {} : { start_seconds: word.start }),
          ...(word.end === undefined ? {} : { end_seconds: word.end }),
        })),
      })),
    }, null, 2)}\n`, "utf8");
  } else {
    input.onPhase?.("无音频轨，跳过转写");
  }
  const segments = deriveSpeechSegments(words);
  const events = deriveStructureEvents({
    duration: probe.duration,
    segments,
    boundaries,
    words,
  });
  const formats = suggestFormats({
    duration: probe.duration,
    segments,
    words,
    width: probe.width,
    height: probe.height,
  });
  input.onPhase?.("归档参考片证据…");
  const referenceArchive = await writeReferenceArchive({
    workspaceRoot: input.workspaceRoot,
    ...(input.runtimePath === undefined ? {} : { runtimeProfile: input.runtimePath }),
    videoPath: input.videoPath,
    ...(videoName === undefined ? {} : { videoName }),
    probe,
    ...(passages.length > 0 ? {
      transcript: { language: input.language, passages, words, ...(transcriptPath === undefined ? {} : { path: transcriptPath }) },
    } : {}),
    boundaries,
    segments,
    events,
    formats,
    tilePath,
  });

  const analysisPath = join(analysisDir, "ANALYSIS.json");
  const session: AnalysisSessionView = {
    workspaceRoot: input.workspaceRoot,
    ...(input.runtimePath === undefined ? {} : { runtimeProfile: input.runtimePath }),
    videoPath: input.videoPath,
    ...(videoName === undefined ? {} : { videoName }),
    probe,
    ...(probe.hasAudio ? {
      transcript: { language: input.language, passages, words, ...(transcriptPath === undefined ? {} : { path: transcriptPath }) },
    } : {}),
    boundaries,
    segments,
    events,
    formats,
    tilePath,
    referenceArchive,
    analysisPath,
    job: { id: "latest", status: "complete" },
  };
  await writeFile(analysisPath, `${JSON.stringify({
    format: "hypit.analysis@1",
    createdAt: new Date().toISOString(),
    source: input.videoPath,
    probe,
    ...(session.transcript === undefined ? {} : { transcript: session.transcript }),
    boundaries,
    segments,
    events,
    formats,
    tilePath,
    referenceArchive,
  }, null, 2)}\n`, "utf8");
  return session;
}

export async function loadSavedAnalysis(workspaceRoot: string): Promise<AnalysisSessionView | undefined> {
  const analysisPath = join(workspaceRoot, ".hypit", "analysis", "ANALYSIS.json");
  try {
    const raw = JSON.parse(await readFile(analysisPath, "utf8")) as {
      source?: string;
      probe?: AnalysisSessionView["probe"];
      transcript?: AnalysisSessionView["transcript"];
      boundaries?: AnalysisSessionView["boundaries"];
      segments?: AnalysisSessionView["segments"];
      events?: AnalysisSessionView["events"];
      formats?: AnalysisSessionView["formats"];
      tilePath?: string;
      referenceArchive?: AnalysisSessionView["referenceArchive"];
    };
    if (raw.source === undefined || raw.probe === undefined) return undefined;
    const videoName = raw.source.split(/[\\/]/u).pop();
    return {
      workspaceRoot,
      videoPath: raw.source,
      ...(videoName === undefined ? {} : { videoName }),
      probe: raw.probe,
      ...(raw.transcript === undefined ? {} : { transcript: raw.transcript }),
      ...(raw.boundaries === undefined ? {} : { boundaries: raw.boundaries }),
      ...(raw.segments === undefined ? {} : { segments: raw.segments }),
      ...(raw.events === undefined ? {} : { events: raw.events }),
      ...(raw.formats === undefined ? {} : { formats: raw.formats }),
      ...(raw.tilePath === undefined ? {} : { tilePath: raw.tilePath }),
      ...(raw.referenceArchive === undefined ? {} : { referenceArchive: raw.referenceArchive }),
      analysisPath,
      job: { id: "saved", status: "complete" },
    };
  } catch {
    return undefined;
  }
}

export async function importUploadedFile(sourcePath: string, workspaceRoot: string, originalName: string): Promise<string> {
  const uploads = join(workspaceRoot, ".hypit", "analysis", "uploads");
  await mkdir(uploads, { recursive: true });
  const safeName = originalName.replace(/[^\w.\-]+/gu, "_");
  const target = join(uploads, `${Date.now()}-${safeName}`);
  const { copyFile, rename, unlink } = await import("node:fs/promises");
  try {
    await rename(sourcePath, target);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "EXDEV") throw error;
    await copyFile(sourcePath, target);
    await unlink(sourcePath);
  }
  return target;
}

export async function readExistingTranscript(path: string): Promise<{ readonly passages: readonly TranscriptPassageView[]; readonly words: readonly TranscriptWordView[] }> {
  const words = await readTranscript(path);
  const passages: TranscriptPassageView[] = [{
    text: words.map((word) => word.text).join(" "),
    words,
  }];
  return { passages, words };
}
