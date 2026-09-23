import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import { tileFrames, tileSampleTimes } from "@hypit/video-cli";

function tileFrameCount(seconds: number): number {
  return Math.min(9, Math.max(4, Math.round(seconds * 1.5)));
}

import type { AnalysisSessionView, ReferenceArchiveView, StructureEventView } from "./shared.js";
import { formatTime } from "./shared.js";

function referenceSlug(videoName: string | undefined): string {
  const base = (videoName ?? "reference").replace(/\.[^.]+$/u, "");
  const slug = base.replace(/[^\w.-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  return slug.length > 0 ? slug : "reference";
}

function transcriptWordsForTile(session: AnalysisSessionView): readonly { readonly text: string; readonly start_seconds: number; readonly end_seconds: number }[] {
  return (session.transcript?.words ?? [])
    .filter((word) => word.start !== undefined && word.end !== undefined)
    .map((word) => ({
      text: word.text,
      start_seconds: word.start!,
      end_seconds: word.end!,
    }));
}

function buildAnalysisMarkdown(session: AnalysisSessionView, referenceDir: string): string {
  const formats = (session.formats ?? []).map((item) => "- **" + item.title + "**（" + item.confidence + "）：" + item.reason).join("\n");
  const transcript = session.transcript?.passages?.map((passage) => passage.text).join(" ") ?? "";
  return [
    "# 参考片分析",
    "",
    "## 概览",
    "- 源文件：`" + (session.videoName ?? "unknown") + "`",
    "- 画幅：" + (session.probe?.width ?? "?") + "×" + (session.probe?.height ?? "?"),
    "- 时长：约 " + (session.probe?.duration ?? "?") + "s",
    "- 转写词数：" + (session.transcript?.words?.length ?? 0),
    "- 画面变化点：" + (session.boundaries?.length ?? 0),
    "",
    "## 推断格式",
    formats.length > 0 ? formats : "- 竖屏 UGC / 口播（默认）",
    "",
    "## 口播摘要",
    transcript.slice(0, 800),
    "",
    "## 证据",
    "- 词级转写：`transcript.json`",
    "- 全片概览：`evidence/overview-tile.jpg`",
    "- 分段网格：见 `evidence/segment-*.jpg`",
    "- 切镜细节：见 `evidence/cut-*.jpg`",
    "",
    "## 说明",
    "本文件记录参考片事实与机器推断；爆款解读见 `INSIGHT.md`，导演时间线见 `TIMELINE.md`，复刻方案见 `productions/*/TREATMENT.md`。",
    "",
    "_归档目录：`" + referenceDir.replace(/\\/gu, "/") + "`_",
  ].join("\n");
}

function phaseTitle(event: StructureEventView): string {
  if (event.kind === "hook") return "开场 Hook";
  if (event.kind === "segment") return event.title;
  if (event.kind === "visual-cut") return "画面变化";
  return event.title;
}

export function buildProgressMarkdown(insightComplete = false): string {
  return [
    "# 深读进度",
    "",
    "- [x] 媒体探测与转写",
    "- [x] 画面变化检测",
    "- [x] 分段证据网格",
    "- [x] TIMELINE.md 初稿",
    insightComplete ? "- [x] INSIGHT.md 爆款解读" : "- [ ] INSIGHT.md 爆款解读",
    "- [ ] Agent 审片后修订 Treatment",
    "- [ ] Studio 微调组件参数",
  ].join("\n");
}

export async function syncInsightToReferenceArchive(referenceDir: string, markdown: string): Promise<void> {
  await mkdir(referenceDir, { recursive: true });
  await writeFile(join(referenceDir, "INSIGHT.md"), `${markdown}\n`, "utf8");
  await markInsightComplete(referenceDir);
}

export async function ensureReferenceArchiveOnDisk(session: AnalysisSessionView): Promise<AnalysisSessionView> {
  const referenceDir = session.referenceArchive?.referenceDir;
  if (referenceDir !== undefined) {
    try {
      await access(join(referenceDir, "ANALYSIS.md"));
      return session;
    } catch {
      // archive metadata exists but files are missing — rebuild below
    }
  }
  const referenceArchive = await writeReferenceArchive(session);
  const next = { ...session, referenceArchive };
  if (session.analysisPath !== undefined) {
    try {
      const raw = JSON.parse(await readFile(session.analysisPath, "utf8")) as Record<string, unknown>;
      await writeFile(session.analysisPath, `${JSON.stringify({ ...raw, referenceArchive }, null, 2)}\n`, "utf8");
    } catch {
      // keep in-memory archive even if analysis snapshot cannot be updated
    }
  }
  return next;
}

export async function markInsightComplete(referenceDir: string): Promise<void> {
  const progressMarkdownPath = join(referenceDir, "PROGRESS.md");
  try {
    const existing = await readFile(progressMarkdownPath, "utf8");
    if (existing.includes("- [x] INSIGHT.md 爆款解读")) return;
  } catch {
    // progress file may not exist yet
  }
  await writeFile(progressMarkdownPath, `${buildProgressMarkdown(true)}\n`, "utf8");
}

function buildTimelineMarkdown(session: AnalysisSessionView, evidencePaths: readonly string[]): string {
  const phases: StructureEventView[] = [];
  const hook = session.events?.find((event) => event.kind === "hook");
  if (hook !== undefined) phases.push(hook);
  for (const segment of session.segments ?? []) {
    phases.push({
      id: segment.id,
      kind: "segment",
      at: segment.start,
      end: segment.end,
      title: segment.label,
      detail: segment.text,
    });
  }
  const lines: string[] = [
    "# 参考片时间线",
    "",
    "按官方 Hypit 深读规范组织：源媒体时间 + 语义阶段 + 视听行为。词级时间见 `transcript.json`。",
    "",
  ];
  for (const phase of phases) {
    const end = phase.end ?? phase.at;
    const relEvidence = evidencePaths.find((path) => path.includes("segment-") && path.includes(phase.id));
    const cuts = (session.boundaries ?? []).filter((boundary) => boundary.at >= phase.at && boundary.at <= end);
    lines.push("## " + formatTime(phase.at) + "–" + formatTime(end) + " · " + phaseTitle(phase));
    lines.push("");
    lines.push(phase.detail.slice(0, 400));
    lines.push("");
    if (cuts.length > 0) {
      lines.push("本段内有 " + cuts.length + " 处画面变化（" + cuts.map((cut) => formatTime(cut.at)).join("、") + "）。B-roll 或全屏切换应跟随口播语义时机。");
      lines.push("");
    }
    if (relEvidence !== undefined) {
      lines.push("证据：`" + relative(session.workspaceRoot, relEvidence).replace(/\\/gu, "/") + "`");
      lines.push("");
    }
  }
  const moments = (session.events ?? []).filter((event) => event.kind === "moment");
  if (moments.length > 0) {
    lines.push("## 高冲击 Moment");
    lines.push("");
    for (const moment of moments) {
      lines.push("- **" + formatTime(moment.at) + "**：" + moment.detail);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function writeReferenceArchive(session: AnalysisSessionView): Promise<ReferenceArchiveView> {
  if (session.videoPath === undefined || session.probe === undefined) {
    throw new Error("缺少参考视频，无法归档");
  }
  const slug = referenceSlug(session.videoName);
  const referenceDir = join(session.workspaceRoot, "references", slug);
  const evidenceDir = join(referenceDir, "evidence");
  await mkdir(evidenceDir, { recursive: true });

  const sourceCopy = join(referenceDir, basename(session.videoPath));
  try {
    await copyFile(session.videoPath, sourceCopy);
  } catch {
    // keep path reference only
  }

  if (session.transcript?.path !== undefined) {
    await copyFile(session.transcript.path, join(referenceDir, "transcript.json"));
  }

  const evidencePaths: string[] = [];
  const words = transcriptWordsForTile(session);

  const overviewPath = join(evidenceDir, "overview-tile.jpg");
  const overviewTimes = tileSampleTimes(0, session.probe.duration, tileFrameCount(session.probe.duration));
  await tileFrames(session.videoPath, overviewTimes, overviewPath, 360, 3, words.length > 0 ? words : undefined);
  evidencePaths.push(overviewPath);

  for (const segment of session.segments ?? []) {
    const span = Math.max(0.5, segment.end - segment.start);
    const path = join(evidenceDir, segment.id + "-tile.jpg");
    const times = tileSampleTimes(segment.start, segment.end, tileFrameCount(span));
    await tileFrames(session.videoPath, times, path, 320, Math.min(3, times.length), words.length > 0 ? words : undefined);
    evidencePaths.push(path);
  }

  for (const [index, boundary] of (session.boundaries ?? []).slice(0, 8).entries()) {
    const start = Math.max(0, boundary.at - 0.6);
    const end = Math.min(session.probe.duration, boundary.at + 0.6);
    const path = join(evidenceDir, "cut-" + String(index + 1) + "-tile.jpg");
    const times = tileSampleTimes(start, end, 4);
    await tileFrames(session.videoPath, times, path, 280, 2, words.length > 0 ? words : undefined);
    evidencePaths.push(path);
  }

  const analysisMarkdownPath = join(referenceDir, "ANALYSIS.md");
  const timelineMarkdownPath = join(referenceDir, "TIMELINE.md");
  const progressMarkdownPath = join(referenceDir, "PROGRESS.md");

  await writeFile(analysisMarkdownPath, buildAnalysisMarkdown(session, referenceDir) + "\n", "utf8");
  await writeFile(timelineMarkdownPath, buildTimelineMarkdown(session, evidencePaths) + "\n", "utf8");
  await writeFile(progressMarkdownPath, `${buildProgressMarkdown(false)}\n`, "utf8");

  return {
    referenceDir,
    analysisMarkdownPath,
    timelineMarkdownPath,
    progressMarkdownPath,
    evidenceDir,
    evidencePaths,
  };
}
