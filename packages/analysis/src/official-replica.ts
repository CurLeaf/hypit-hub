import { readFile } from "node:fs/promises";

import type { ChatGatewayConfig } from "./llm.js";
import { loadChatGateway } from "./llm.js";
import type { RuntimeCapabilities } from "./runtime-capabilities.js";
import type { AnalysisSessionView } from "./shared.js";

export type OfficialPathCheck = {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type OfficialPathReport = {
  readonly ok: boolean;
  readonly checks: readonly OfficialPathCheck[];
};

const DEFAULT_SCENE_PROMPT_MARK = "Chinese product promo scene";

function hasOfficialTtsVoice(svml: string): boolean {
  return svml.includes("generated-speech")
    || svml.includes('id="voice-reference"')
    || svml.includes('id="presenter-voice"')
    || svml.includes("fish:VoiceDesign");
}

export function hasOfficialH3PromptTemplate(svml: string): boolean {
  return svml.includes("h3-kit.h3-ugc-replica-v1");
}

function countH3ReferenceVideos(svml: string): number {
  return (svml.match(/<h3:ReferenceVideo/gu) ?? []).length;
}

function usesLegacyPerSceneH3(svml: string): boolean {
  return /id="scene_\d+-take"/u.test(svml)
    || /id="segment[_-]\d+-take"/u.test(svml)
    || svml.includes("speaker-kit.speaker-v1");
}

function usesTimelineH3Takes(svml: string): boolean {
  const ids = [...svml.matchAll(/<h3:ReferenceVideo id="([^"]+)"/gu)].map((match) => match[1]);
  if (ids.length === 0) return false;
  return ids.every((id) => /^shot_\d+-take$/u.test(id));
}

function hasH3LastFrameChain(svml: string): boolean {
  const takeCount = countH3ReferenceVideos(svml);
  if (takeCount <= 1) return true;
  return /<pipeline:ExtractFrame[^>]+at="last"/u.test(svml)
    && /<h3:Reference image=\{shot_\d+-last\.image\}\/>/u.test(svml);
}

export function isDefaultScenePrompt(prompt: string): boolean {
  return prompt.includes(DEFAULT_SCENE_PROMPT_MARK)
    || prompt.startsWith("Vertical 9:16 short-form social video frame, cinematic lighting, clean composition.");
}

export async function loadOfficialGateway(
  runtimePath: string | undefined,
  workspaceRoot: string,
): Promise<ChatGatewayConfig | undefined> {
  return loadChatGateway(runtimePath, workspaceRoot);
}

export function assertOfficialLlmGateway(gateway: ChatGatewayConfig | undefined): ChatGatewayConfig {
  if (gateway === undefined) {
    throw new Error("缺少 Runtime 网关（gateway.default）。请配置 OPENAI_BASE_URL，并运行 hypit runtime use。");
  }
  const secret = process.env[gateway.apiKeyEnv]?.trim();
  if (secret === undefined || secret.length === 0) {
    throw new Error(`官方复刻需要对话模型：请配置 ${gateway.apiKeyEnv}（用于 Insight / Brief / Treatment / 口播改写 / 场景 prompt）`);
  }
  return gateway;
}

export function assertOfficialH3Credential(
  capabilities: RuntimeCapabilities,
  videoAroll: boolean,
): void {
  if (!videoAroll || !capabilities.h3Video) return;
  const secret = process.env.H3_VIDEO_API_KEY?.trim();
  if (secret === undefined || secret.length === 0) {
    throw new Error("已启用 MiniMax H3 口播，但缺少 H3_VIDEO_API_KEY。请在 .env 配置后重启 analysis。");
  }
  const baseUrl = process.env.H3_VIDEO_BASE_URL?.trim();
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new Error("已启用 MiniMax H3 口播，但缺少 H3_VIDEO_BASE_URL。请在 .env 配置后重启 analysis。");
  }
}

export function validateOfficialSvml(
  svml: string,
  options: { readonly videoAroll: boolean; readonly requireProductReference: boolean },
): OfficialPathReport {
  const checks: OfficialPathCheck[] = [
    {
      id: "product-reference",
      label: "参考图写入工程",
      ok: svml.includes('id="product-reference"'),
      detail: "应含 assets/product-reference 与 gpt/H3 Reference 绑定",
    },
    {
      id: "tts-audio",
      label: "音色样本已写入工程",
      ok: hasOfficialTtsVoice(svml) || !options.requireProductReference,
      detail: options.videoAroll
        ? "H3 口播使用 TTS 音色样本（presenter-voice / voice-reference / fish:VoiceDesign），不以参考片原声做口播轨"
        : "官方路径使用 generated-speech.wav，而非 reference-audio（参考片原声）",
    },
    {
      id: "h3-aroll",
      label: "H3 A-roll 口播",
      ok: !options.videoAroll || svml.includes("h3:ReferenceVideo"),
      detail: "启用 H3 口播时应含 h3:ReferenceVideo + h3-ugc-replica-v1 prompt",
    },
    {
      id: "speaker-template",
      label: "H3 prompt 模板",
      ok: !options.videoAroll || hasOfficialH3PromptTemplate(svml),
      detail: "H3 prompt 应使用 h3-kit.h3-ugc-replica-v1（非 speaker-kit）",
    },
    {
      id: "h3-timeline-shots",
      label: "H3 时间轴分镜",
      ok: !options.videoAroll || (usesTimelineH3Takes(svml) && !usesLegacyPerSceneH3(svml)),
      detail: "启用 H3 口播时应为 shot_N-take（≤15s/镜），非 scene_N-take 按切点逐段生成",
    },
    {
      id: "h3-frame-chain",
      label: "H3 尾帧衔接",
      ok: !options.videoAroll || hasH3LastFrameChain(svml),
      detail: "多镜 H3 口播应含 ExtractFrame(at=last) 与 shot_N-last.image 参考衔接",
    },
    {
      id: "gpt-reference",
      label: "B-roll 参考图 edits",
      ok: svml.includes("<gpt:Reference image={product-reference")
        || (options.videoAroll && svml.includes("<h3:Reference image={product-reference")),
      detail: "分镜图或 H3 口播应通过 Reference 绑定产品参考图（asset:Image 发布裸 id）",
    },
    {
      id: "no-reference-audio",
      label: "未使用参考片原声",
      ok: !svml.includes('id="reference-audio"'),
      detail: "官方路径不应以 reference-audio 作为口播轨",
    },
  ];
  const relevant = options.requireProductReference
    ? checks
    : checks.filter((check) => check.id === "product-reference");
  const ok = relevant.every((check) => check.ok);
  return { ok, checks: relevant };
}

export async function buildOfficialPathReport(input: {
  readonly session: AnalysisSessionView;
  readonly runtimePath?: string;
  readonly forBuild?: boolean;
  readonly svmlPath?: string;
}): Promise<OfficialPathReport> {
  const checks: OfficialPathCheck[] = [];
  const videoAroll = input.session.videoAroll ?? true;
  const gateway = await loadOfficialGateway(input.runtimePath, input.session.workspaceRoot);
  const llmOk = gateway !== undefined && (process.env[gateway.apiKeyEnv]?.trim().length ?? 0) > 0;
  checks.push({
    id: "llm",
    label: "对话模型 (Insight/Brief/Treatment/改写/prompt)",
    ok: llmOk,
    detail: llmOk
      ? `已配置 ${gateway!.apiKeyEnv} → ${gateway!.model}`
      : "请配置 OPENAI_BASE_URL、OPENAI_API_KEY 与 HYPIT_CHAT_MODEL",
  });

  const ttsOk = llmOk;
  checks.push({
    id: "tts",
    label: "TTS 试听 / 音色样本",
    ok: ttsOk,
    detail: ttsOk
      ? `改编审查与 H3 音色样本：${gateway!.ttsModel} / ${gateway!.ttsVoice}`
      : "TTS 与对话模型共用 gateway.default 密钥",
  });

  const h3Ok = !videoAroll
    || ((process.env.H3_VIDEO_API_KEY?.trim().length ?? 0) > 0
      && (process.env.H3_VIDEO_BASE_URL?.trim().length ?? 0) > 0);
  checks.push({
    id: "h3",
    label: "MiniMax H3 口播",
    ok: h3Ok,
    detail: videoAroll
      ? (h3Ok ? "已配置 H3_VIDEO_API_KEY 与 H3_VIDEO_BASE_URL" : "启用 H3 口播需要 H3_VIDEO_API_KEY 与 H3_VIDEO_BASE_URL")
      : "未启用 H3（仅静态分镜 + TTS）",
  });

  checks.push({
    id: "analysis",
    label: "参考片分析完成",
    ok: input.session.analysisPath !== undefined,
    detail: input.session.analysisPath === undefined ? "请先点击「开始分析」" : "已完成",
  });

  const hasReference = input.session.productReferencePath !== undefined;
  checks.push({
    id: "reference-image",
    label: "参考图已上传",
    ok: hasReference,
    detail: hasReference
      ? (input.session.productReferenceName ?? "已上传")
      : "请在「生成」页上传产品/人物参考图",
  });

  const review = input.session.directorReview;
  const reviewOk = !hasReference || review?.status === "approved";
  checks.push({
    id: "director-review",
    label: "导演审查已通过",
    ok: reviewOk,
    detail: review?.status === "approved"
      ? "Agent 已审 BRIEF / Treatment / 口播"
      : hasReference
        ? "请先在 Cursor 编辑 .hypit/analysis/director/ 并点击「导演审查通过」"
        : "上传参考图后启用",
  });

  const adapt = input.session.adaptation;
  const adaptOk = hasReference
    && reviewOk
    && adapt?.status === "complete"
    && adapt.generatedSpeechPath !== undefined
    && adapt.productReferenceSource === input.session.productReferencePath;
  checks.push({
    id: "adaptation",
    label: "改编配音已就绪",
    ok: adaptOk,
    detail: adapt?.status === "running"
      ? (adapt.phase ?? "制作中…")
      : adapt?.status === "error"
        ? (adapt.error ?? "制作失败")
        : adaptOk
          ? "TTS 试听与 H3 音色样本已生成（成片口播由 H3 生成）"
          : reviewOk
            ? "导演审查通过后点击「开始制作配音」"
            : "请先完成导演审查",
  });

  if (input.forBuild === true) {
    checks.push({
      id: "scaffold",
      label: "复刻工程已生成",
      ok: input.session.scaffold?.runPath !== undefined,
      detail: input.session.scaffold?.runPath ?? "请先点击「一键复刻」",
    });
  }

  if (input.svmlPath !== undefined) {
    try {
      const svml = await readFile(input.svmlPath, "utf8");
      const validation = validateOfficialSvml(svml, { videoAroll, requireProductReference: hasReference });
      checks.push(...validation.checks);
    } catch (error) {
      checks.push({
        id: "svml",
        label: "工程 SVML 校验",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

export function formatOfficialPathReport(report: OfficialPathReport): string {
  return [
    "# 官方复刻路径检查",
    "",
    report.ok ? "状态：**已通过**" : "状态：**未通过**（请补齐下列项后再一键复刻）",
    "",
    ...report.checks.map((check) => `- [${check.ok ? "x" : " "}] **${check.label}** — ${check.detail}`),
    "",
  ].join("\n");
}
