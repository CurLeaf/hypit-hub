import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { runCheck } from "./build-runner.js";
import { markInsightComplete } from "./reference-archive.js";
import { generateFormatReplicaProject } from "./scaffold-format.js";

import type {
  AnalysisSessionView,
  BriefView,
  FormatSuggestionView,
  ScaffoldView,
  TreatmentView,
  ViralInsightView,
} from "./shared.js";
import {
  analysisContextForLlm,
  buildInsightFromSession,
  buildInsightMarkdown,
} from "./insight-builder.js";
import { chatCompletion, extractJsonObject, loadChatGateway } from "./llm.js";
import { assertOfficialLlmGateway, formatOfficialPathReport, validateOfficialSvml } from "./official-replica.js";
import { normalizeTranscriptText } from "./transcript-text.js";

const WORKFLOW_STATE = ".hypit/analysis/workflow.json";

export type WorkflowState = Pick<AnalysisSessionView,
  "insight" | "brief" | "treatment" | "scaffold" | "build" | "adaptation" | "adaptationGoal"
  | "productReferencePath" | "productReferenceName" | "videoAroll"> & {
  readonly videoPath?: string;
  readonly videoUrl?: string;
};

export async function loadWorkflowState(workspaceRoot: string): Promise<WorkflowState> {
  try {
    const raw = JSON.parse(await readFile(join(workspaceRoot, WORKFLOW_STATE), "utf8")) as WorkflowState;
    return raw;
  } catch {
    return {};
  }
}

export async function saveWorkflowState(workspaceRoot: string, state: WorkflowState): Promise<void> {
  const path = join(workspaceRoot, WORKFLOW_STATE);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearWorkflowState(workspaceRoot: string): Promise<void> {
  const path = join(workspaceRoot, WORKFLOW_STATE);
  try {
    await writeFile(path, "{}\n", "utf8");
  } catch {
    // no workflow file yet
  }
}

export function mergeWorkflowState(session: AnalysisSessionView, workflow: WorkflowState): AnalysisSessionView {
  if (session.videoPath === undefined) return session;
  if (workflow.videoPath !== session.videoPath) return session;
  return { ...session, ...workflow };
}

export async function loadSavedInsight(workspaceRoot: string): Promise<ViralInsightView | undefined> {
  const jsonPath = join(workspaceRoot, ".hypit", "analysis", "INSIGHT.json");
  try {
    const raw = JSON.parse(await readFile(jsonPath, "utf8")) as ViralInsightView;
    if (typeof raw.summary !== "string" || raw.summary.trim().length === 0) return undefined;
    return { ...raw, path: jsonPath };
  } catch {
    return undefined;
  }
}

export async function enrichSessionWithSavedInsight(session: AnalysisSessionView): Promise<AnalysisSessionView> {
  if (session.insight !== undefined || session.analysisPath === undefined) return session;
  const insight = await loadSavedInsight(session.workspaceRoot);
  return insight === undefined ? session : { ...session, insight };
}

async function persistInsight(
  session: AnalysisSessionView,
  insight: ViralInsightView,
): Promise<ViralInsightView> {
  const analysisDir = join(session.workspaceRoot, ".hypit", "analysis");
  await mkdir(analysisDir, { recursive: true });
  const jsonPath = join(analysisDir, "INSIGHT.json");
  await writeFile(jsonPath, `${JSON.stringify(insight, null, 2)}\n`, "utf8");

  const markdown = buildInsightMarkdown(insight, session.videoName);
  const markdownPath = join(analysisDir, "INSIGHT.md");
  await writeFile(markdownPath, `${markdown}\n`, "utf8");

  const referenceDir = session.referenceArchive?.referenceDir;
  if (referenceDir !== undefined) {
    await writeFile(join(referenceDir, "INSIGHT.md"), `${markdown}\n`, "utf8");
    await markInsightComplete(referenceDir);
  }

  return { ...insight, path: jsonPath };
}

export async function generateInsight(input: {
  readonly session: AnalysisSessionView;
  readonly runtimePath?: string;
  onPhase?(phase: string): void;
  readonly requireLlm?: boolean;
}): Promise<ViralInsightView> {
  input.onPhase?.("解读爆款逻辑…");
  const gateway = await loadChatGateway(input.runtimePath, input.session.workspaceRoot);
  if (input.requireLlm === true) {
    assertOfficialLlmGateway(gateway);
  }
  const fallback = buildInsightFromSession(input.session);
  if (gateway === undefined) {
    if (input.requireLlm === true) throw new Error("无法加载对话模型网关");
    return persistInsight(input.session, fallback);
  }
  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "你是 Hypit 官方风格的短视频内容策略分析师，擅长拆解信息流广告与竖屏口播片。",
        "根据参考片的转写、切镜时间点与格式推断，用流畅中文解释「为什么可能火、怎么火的、如何复刻」。",
        "要求：",
        "1. 禁止输出机器模板句，不要写「约 X 个词分布在 Y 秒」这类统计套话。",
        "2. 必须引用具体台词、时间段（如 0:03.5）和画面变化与口播的对应关系。",
        "3. 输出严格 JSON，不要 markdown 代码块外的文字。",
        "字段：summary(string, 2-3句), whyViral(array of {title,detail}), howItWorks(array of {title,detail}), hookAnalysis(string), replicationTips(string[])。",
        "4. detail 每条 2-4 句，具体可读，全部中文。",
      ].join("\n"),
      user: `请分析这条参考片：\n${analysisContextForLlm(input.session)}`,
    });
    const parsed = extractJsonObject(content);
    const insight: ViralInsightView = {
      summary: String(parsed.summary ?? fallback.summary),
      whyViral: Array.isArray(parsed.whyViral) && parsed.whyViral.length > 0 ? parsed.whyViral.map((item) => {
        const row = item as Record<string, unknown>;
        return { title: String(row.title ?? ""), detail: String(row.detail ?? "") };
      }) : fallback.whyViral,
      howItWorks: Array.isArray(parsed.howItWorks) && parsed.howItWorks.length > 0 ? parsed.howItWorks.map((item) => {
        const row = item as Record<string, unknown>;
        return { title: String(row.title ?? ""), detail: String(row.detail ?? "") };
      }) : fallback.howItWorks,
      hookAnalysis: String(parsed.hookAnalysis ?? fallback.hookAnalysis),
      replicationTips: Array.isArray(parsed.replicationTips) && parsed.replicationTips.length > 0
        ? parsed.replicationTips.map(String)
        : fallback.replicationTips,
    };
    return persistInsight(input.session, insight);
  } catch (error) {
    if (input.requireLlm === true) throw error;
    return persistInsight(input.session, fallback);
  }
}

function primaryFormat(session: AnalysisSessionView): FormatSuggestionView | undefined {
  const formats = session.formats ?? [];
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...formats].sort((left, right) => rank[left.confidence] - rank[right.confidence])[0];
}

function productReferenceBriefLine(session: AnalysisSessionView): string {
  if (session.productReferencePath === undefined) return "";
  const label = session.productReferenceName ?? "用户参考图";
  const mode = session.videoAroll ?? true
    ? "A-roll 使用 `h3:ReferenceVideo`（MiniMax H3，参考图+TTS 音色+改写口播），B-roll 使用 `gpt:Image` 参考"
    : "生成各分镜画面时作为 `gpt:Image` 参考输入；口播文案按爆款结构改写并用 TTS 配音";
  return "- 用户参考图：" + label + "（" + mode + "）";
}

function faithfulBriefFromReference(session: AnalysisSessionView, insight: ViralInsightView): string {
  const format = primaryFormat(session);
  const transcript = normalizeTranscriptText(session.transcript?.passages?.[0]?.text ?? "");
  const structure = (session.segments ?? []).map((segment) => segment.label).join(" → ") || "按参考片口播段落";
  const formatLine = format === undefined
    ? ""
    : "- 推荐格式模板：" + format.title + "（" + format.confidence + "）— " + format.reason;
  const lines = [
    "# Brief",
    "",
    "## 目标",
    "忠实复刻参考片的结构与传播逻辑，生成一条语义与节奏相似的竖屏短视频。",
    "",
    "## 从参考片继承（默认）",
    "- 叙事结构：" + structure,
    "- Hook 设计：" + insight.hookAnalysis,
    "- 画幅与时长：" + (session.probe?.width ?? "?") + "×" + (session.probe?.height ?? "?") + "，约 " + (session.probe?.duration ?? "?") + "s",
    "- 视听系统：口播节奏 + 画面变化点（" + (session.boundaries?.length ?? 0) + " 处）+ 词级字幕时机",
    ...(formatLine.length > 0 ? [formatLine] : []),
    ...(productReferenceBriefLine(session).length > 0 ? [productReferenceBriefLine(session)] : []),
    "",
    "## 参考片核心内容",
    transcript.slice(0, 500),
    "",
    "## 说明",
    "未特别声明的层、关系、Hook/收束逻辑均从参考片继承；具体 casting、素材 prompt 由 Treatment 与 SVML 实现。",
  ];
  return lines.join("\n");
}

async function copyBriefToDir(brief: BriefView, productionDir: string): Promise<BriefView> {
  const path = join(productionDir, "BRIEF.md");
  await writeFile(path, `${brief.markdown.trim()}\n`, "utf8");
  return { markdown: brief.markdown, path };
}

async function copyTreatmentToDir(treatment: TreatmentView, productionDir: string): Promise<TreatmentView> {
  const path = join(productionDir, "TREATMENT.md");
  await writeFile(path, `${treatment.markdown.trim()}\n`, "utf8");
  return { markdown: treatment.markdown, path };
}

async function loadBriefFromPath(path: string): Promise<BriefView> {
  return { markdown: await readFile(path, "utf8"), path };
}

async function loadTreatmentFromPath(path: string): Promise<TreatmentView> {
  return { markdown: await readFile(path, "utf8"), path };
}

export async function resolveWorkflowBrief(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly productionDir: string;
  readonly replacements?: string;
  readonly goal?: string;
  readonly runtimePath?: string;
  readonly requireLlm?: boolean;
}): Promise<BriefView> {
  if (input.session.adaptation?.briefPath !== undefined && await fileExists(input.session.adaptation.briefPath)) {
    const brief = await loadBriefFromPath(input.session.adaptation.briefPath);
    return copyBriefToDir(brief, input.productionDir);
  }
  if (input.session.brief?.path !== undefined && await fileExists(input.session.brief.path)) {
    return copyBriefToDir(input.session.brief, input.productionDir);
  }
  return generateBrief({
    session: input.session,
    insight: input.insight,
    ...(input.replacements === undefined ? {} : { replacements: input.replacements }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    outputDir: input.productionDir,
    ...(input.requireLlm === undefined ? {} : { requireLlm: input.requireLlm }),
  });
}

export async function resolveWorkflowTreatment(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly brief: BriefView;
  readonly productionDir: string;
  readonly runtimePath?: string;
  readonly requireLlm?: boolean;
}): Promise<TreatmentView> {
  if (input.session.adaptation?.treatmentPath !== undefined && await fileExists(input.session.adaptation.treatmentPath)) {
    const treatment = await loadTreatmentFromPath(input.session.adaptation.treatmentPath);
    return copyTreatmentToDir(treatment, input.productionDir);
  }
  if (input.session.treatment?.path !== undefined && await fileExists(input.session.treatment.path)) {
    return copyTreatmentToDir(input.session.treatment, input.productionDir);
  }
  return generateTreatment({
    session: input.session,
    insight: input.insight,
    brief: input.brief,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    outputDir: input.productionDir,
    ...(input.requireLlm === undefined ? {} : { requireLlm: input.requireLlm }),
  });
}

export async function generateBrief(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly replacements?: string;
  readonly goal?: string;
  readonly runtimePath?: string;
  readonly outputDir?: string;
  readonly requireLlm?: boolean;
}): Promise<BriefView> {
  const format = primaryFormat(input.session);
  const gateway = await loadChatGateway(input.runtimePath, input.session.workspaceRoot);
  if (input.requireLlm === true) {
    assertOfficialLlmGateway(gateway);
  }
  let markdown = faithfulBriefFromReference(input.session, input.insight);
  if (gateway !== undefined) {
    try {
      const formatHint = format === undefined
        ? ""
        : "推断格式：" + format.title + "，理由：" + format.reason;
      const hasProductAdaptation = input.session.productReferencePath !== undefined
        || (input.goal?.trim().length ?? 0) > 0
        || (input.replacements?.trim().length ?? 0) > 0;
      markdown = await chatCompletion({
        gateway,
        system: [
          "你是视频制片人。用户给了一条爆款参考片，要写 BRIEF.md（中文 Markdown）。",
          hasProductAdaptation
            ? "用户要换用自己的产品/参考图：保留参考片的结构、Hook、段落节奏与视听系统，但口播卖点、产品名称与 CTA 必须改为用户的新主体。"
            : "核心原则：忠实改编——未提及的关系从参考片继承（结构、Hook、段落节奏、字幕/画面系统），不要臆造用户没要求的替换。",
          "根据分析推断：这是什么格式、受众是谁、要保留哪些语义时机关系。",
          formatHint,
        ].filter((line) => line.length > 0).join("\n"),
        user: "参考片分析：\n" + JSON.stringify({
          insight: input.insight,
          probe: input.session.probe,
          transcript: input.session.transcript?.passages?.[0]?.text,
          segments: input.session.segments,
          events: input.session.events,
          boundaries: input.session.boundaries,
          formats: input.session.formats,
          userGoal: input.goal,
          productReplacements: input.replacements,
          productReference: input.session.productReferenceName,
        }, null, 2),
      });
    } catch (error) {
      if (input.requireLlm === true) throw error;
    }
  } else if (input.requireLlm === true) {
    throw new Error("官方复刻需要 LLM 撰写 Brief，但未配置 gateway.default");
  }
  const productionDir = input.outputDir ?? join(
    input.session.workspaceRoot,
    ".hypit",
    "analysis",
    "workflow",
    `brief-${Date.now()}`,
  );
  await mkdir(productionDir, { recursive: true });
  const path = join(productionDir, "BRIEF.md");
  await writeFile(path, `${markdown.trim()}\n`, "utf8");
  return { markdown, path };
}

export async function generateTreatment(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly brief: BriefView;
  readonly runtimePath?: string;
  readonly outputDir?: string;
  readonly requireLlm?: boolean;
}): Promise<TreatmentView> {
  const gateway = await loadChatGateway(input.runtimePath, input.session.workspaceRoot);
  if (input.requireLlm === true) {
    assertOfficialLlmGateway(gateway);
  }
  const productionDir = input.outputDir
    ?? (input.brief.path === undefined
      ? join(input.session.workspaceRoot, ".hypit", "analysis", "workflow", `treatment-${Date.now()}`)
      : resolve(input.brief.path, ".."));
  const structureLines = input.insight.howItWorks
    .map((item) => "- **" + item.title + "**：" + item.detail)
    .join("\n");
  let markdown = [
    "# Treatment",
    "",
    "## 创意前提",
    input.insight.summary,
    "",
    "## 结构",
    structureLines,
    "",
    "## 视听系统",
    "- A-roll：竖屏口播或 AI 生成画面",
    "- 字幕：词级高亮，跟随口播",
    "- B-roll：在 Moment 处切换产品图/演示",
    "",
    "## CTA",
    "在结尾 3 秒重复核心卖点。",
    "",
  ].join("\n");
  if (gateway !== undefined) {
    try {
      markdown = await chatCompletion({
        gateway,
        system: "你是导演。根据参考片分析与 Brief 写 TREATMENT.md（中文 Markdown）。说明新片如何复刻参考片的 Hook、段落、Moment、字幕与画面变化时机——保留语义关系，用导演语言描述 A-roll/B-roll/Caption 系统。不要写代码或包名。",
        user: `Brief:\n${input.brief.markdown}\n\n结构事件:\n${JSON.stringify(input.session.events)}\n\n洞察:\n${JSON.stringify(input.insight)}`,
      });
    } catch (error) {
      if (input.requireLlm === true) throw error;
    }
  } else if (input.requireLlm === true) {
    throw new Error("官方复刻需要 LLM 撰写 Treatment，但未配置 gateway.default");
  }
  const path = join(productionDir, "TREATMENT.md");
  await writeFile(path, `${markdown.trim()}\n`, "utf8");
  return { markdown, path };
}

export async function scaffoldProject(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly brief: BriefView;
  readonly treatment: TreatmentView;
  readonly formatId?: string;
  readonly distributionRoot: string;
  readonly runtimePath?: string;
  readonly speechMode?: "reference" | "tts";
  readonly productReferencePath?: string;
  readonly videoAroll?: boolean;
  readonly goal?: string;
  readonly preparedAdaptation?: AnalysisSessionView["adaptation"];
}): Promise<ScaffoldView> {
  const format = primaryFormat(input.session);
  const formatId = input.formatId ?? format?.id ?? "ugc";
  const productionDir = input.brief.path === undefined
    ? join(input.session.workspaceRoot, "productions", `replica-${Date.now()}`)
    : resolve(input.brief.path, "..");
  await mkdir(productionDir, { recursive: true });

  const templateByFormat: Record<string, string> = {
    ranking: "examples/ranking-football",
    interview: "examples/interview",
    podcast: "examples/podcast",
    ugc: "examples/byok-openai-compatible/templates/ugc-replica",
    explainer: "examples/byok-openai-compatible/templates/ugc-replica",
  };
  const templateKey = templateByFormat[formatId] ?? "examples/byok-openai-compatible/templates/ugc-replica";
  const templateDir = resolve(input.distributionRoot, templateKey);

  const preparedAdaptation = input.preparedAdaptation ?? input.session.adaptation;
  const { authorPath, runPath } = await generateFormatReplicaProject({
    session: input.session,
    insight: input.insight,
    treatment: input.treatment,
    productionDir,
    distributionRoot: input.distributionRoot,
    workspaceRoot: input.session.workspaceRoot,
    formatId,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    ...(input.speechMode === undefined ? {} : { speechMode: input.speechMode }),
    ...(input.productReferencePath === undefined ? {} : { productReferencePath: input.productReferencePath }),
    ...(input.videoAroll === undefined ? {} : { videoAroll: input.videoAroll }),
    brief: input.brief,
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(preparedAdaptation === undefined ? {} : { preparedAdaptation }),
  });
  await writeFile(join(productionDir, "TEMPLATE.md"), [
    "# 结构模板",
    "",
    `推断格式：**${format?.title ?? "竖屏 UGC"}**（${format?.confidence ?? "medium"}）`,
    "",
    format?.reason ?? "根据参考片时长、画幅与口播结构推断。",
    "",
    "完整示例参考：`" + (format?.example ?? "examples/byok-openai-compatible/templates/ugc-replica") + "`",
    "",
    input.productReferencePath !== undefined
      ? "本工程保留参考片结构与 Hook 节奏，口播文案已按用户参考图与改编说明改写；配音由 TTS 生成后接入 H3 / WhisperX。"
      : "本工程已根据参考片转写、切镜点与口播结构自动生成 Script、分镜图 prompt、卡拉 OK 字幕与音频对齐。",
    ...(input.productReferencePath !== undefined
      ? ["", (input.videoAroll ?? input.session.videoAroll ?? true)
        ? "A-roll：`h3:ReferenceVideo`（参考图 + TTS 音色样本 + 新口播文案）。B-roll：`gpt:Image` 参考图。"
        : "用户参考图已接入各分镜 `gpt:Image` 的 `<gpt:Reference>`，用于保持产品/人物外观一致。"]
      : []),
  ].join("\n"), "utf8");

  await writeFile(join(productionDir, "INSIGHT.md"), `${buildInsightMarkdown(input.insight, input.session.videoName)}\n`, "utf8");
  await writeFile(join(productionDir, "ANALYSIS.md"), `${buildInsightMarkdown(input.insight, input.session.videoName)}\n`, "utf8");

  const authorSvml = await readFile(authorPath, "utf8");
  const pipelineReport = validateOfficialSvml(authorSvml, {
    videoAroll: input.videoAroll ?? input.session.videoAroll ?? true,
    requireProductReference: input.productReferencePath !== undefined,
  });
  await writeFile(join(productionDir, "PIPELINE.md"), formatOfficialPathReport(pipelineReport), "utf8");
  if (input.productReferencePath !== undefined && !pipelineReport.ok) {
    throw new Error("工程未通过官方复刻路径校验：\n" + pipelineReport.checks.filter((c) => !c.ok).map((c) => `${c.label}：${c.detail}`).join("\n"));
  }

  if (input.brief.path !== undefined) {
    await copyFile(input.brief.path, join(productionDir, "BRIEF.md"));
  }
  if (input.treatment.path !== undefined) {
    await copyFile(input.treatment.path, join(productionDir, "TREATMENT.md"));
  }

  let checkOk = true;
  let checkSummary: string | undefined;
  try {
    const check = await runCheck(input.session.workspaceRoot, runPath, input.runtimePath);
    checkOk = check.ok;
    checkSummary = check.summary;
  } catch (error) {
    checkOk = false;
    checkSummary = error instanceof Error ? error.message : String(error);
  }

  return {
    productionDir,
    runPath,
    authorPath,
    formatId,
    runName: basename(runPath),
    checkOk,
    checkSummary,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function runFullReplication(input: {
  readonly session: AnalysisSessionView;
  readonly runtimePath?: string;
  readonly distributionRoot: string;
  readonly replacements?: string;
  readonly goal?: string;
  readonly formatId?: string;
  readonly speechMode?: "reference" | "tts";
  readonly productReferencePath?: string;
  readonly videoAroll?: boolean;
  onPhase?(phase: string): void;
}): Promise<WorkflowState> {
  if (input.session.analysisPath === undefined) throw new Error("请先完成媒体分析");
  if (input.session.productReferencePath === undefined) {
    throw new Error("生成视频需要参考图，请先在「生成」页上传「参考图（产品/人物）」");
  }
  const productionDir = join(input.session.workspaceRoot, "productions", `replica-${Date.now()}`);
  await mkdir(productionDir, { recursive: true });
  input.onPhase?.("解读爆款逻辑…");
  const insight = await generateInsight({
    session: input.session,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    ...(input.onPhase === undefined ? {} : { onPhase: input.onPhase }),
    requireLlm: true,
  });
  input.onPhase?.("撰写 Brief…");
  const brief = await resolveWorkflowBrief({
    session: input.session,
    insight,
    productionDir,
    ...(input.replacements === undefined ? {} : { replacements: input.replacements }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    requireLlm: true,
  });
  input.onPhase?.("撰写 Treatment…");
  const treatment = await resolveWorkflowTreatment({
    session: input.session,
    insight,
    brief,
    productionDir,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    requireLlm: true,
  });
  input.onPhase?.("生成工程文件…");
  const productReferencePath = input.productReferencePath ?? input.session.productReferencePath;
  const videoAroll = input.videoAroll ?? input.session.videoAroll;
  const scaffold = await scaffoldProject({
    session: input.session,
    insight,
    brief,
    treatment,
    distributionRoot: input.distributionRoot,
    ...(input.formatId === undefined ? {} : { formatId: input.formatId }),
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    speechMode: "tts",
    ...(productReferencePath === undefined ? {} : { productReferencePath }),
    ...(videoAroll === undefined ? {} : { videoAroll }),
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.session.adaptation === undefined ? {} : { preparedAdaptation: input.session.adaptation }),
  });
  return { insight, brief, treatment, scaffold };
}
