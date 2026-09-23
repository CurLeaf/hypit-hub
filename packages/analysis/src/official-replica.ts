import { readFile } from "node:fs/promises";

import type { ChatGatewayConfig } from "./llm.js";
import { loadChatGateway } from "./llm.js";
import {
  adaptationMatchesReference,
  countProductReferenceAssets,
  hasProductReference,
  hasProductReferenceBindings,
  normalizeProductReferences,
  productReferenceLabels,
} from "./product-reference.js";
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
      label: "参考图已关联",
      ok: (() => {
        const count = countProductReferenceAssets(svml);
        return count > 0 && hasProductReferenceBindings(svml, count);
      })(),
      detail: "产品参考图已正确写入制作项目",
    },
    {
      id: "tts-audio",
      label: "配音音色已就绪",
      ok: hasOfficialTtsVoice(svml) || !options.requireProductReference,
      detail: options.videoAroll
        ? "口播视频将使用改编配音的音色，不会直接使用参考片原声"
        : "成片将使用改编配音音频，不会直接使用参考片原声",
    },
    {
      id: "h3-aroll",
      label: "口播视频轨道",
      ok: !options.videoAroll || svml.includes("h3:ReferenceVideo"),
      detail: "口播视频生成配置已就绪",
    },
    {
      id: "speaker-template",
      label: "口播生成模板",
      ok: !options.videoAroll || hasOfficialH3PromptTemplate(svml),
      detail: "口播视频使用官方复刻模板",
    },
    {
      id: "h3-timeline-shots",
      label: "口播分镜节奏",
      ok: !options.videoAroll || (usesTimelineH3Takes(svml) && !usesLegacyPerSceneH3(svml)),
      detail: "口播已按每段不超过 15 秒拆分",
    },
    {
      id: "h3-frame-chain",
      label: "多段口播衔接",
      ok: !options.videoAroll || hasH3LastFrameChain(svml),
      detail: "多段口播之间的画面过渡已配置",
    },
    {
      id: "h3-burned-captions",
      label: "字幕生成方式",
      ok: !options.videoAroll || !svml.includes("caption-fine"),
      detail: "字幕将在口播视频中直接生成",
    },
    {
      id: "gpt-reference",
      label: "画面参考图绑定",
      ok: svml.includes("<gpt:Reference image={product-reference")
        || (options.videoAroll && svml.includes("<h3:Reference image={product-reference")),
      detail: "补充画面已关联产品参考图",
    },
    {
      id: "no-reference-audio",
      label: "口播来源",
      ok: !svml.includes('id="reference-audio"'),
      detail: "成片口播来自改编配音，而非参考片原声",
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
    label: "文案生成服务",
    ok: llmOk,
    detail: llmOk ? "文案解读与改写服务已就绪" : "文案生成服务未配置，请联系管理员",
  });

  const ttsOk = llmOk;
  checks.push({
    id: "tts",
    label: "配音试听服务",
    ok: ttsOk,
    detail: ttsOk ? "配音试听与音色样本服务已就绪" : "配音服务未配置，请联系管理员",
  });

  const h3Ok = !videoAroll
    || ((process.env.H3_VIDEO_API_KEY?.trim().length ?? 0) > 0
      && (process.env.H3_VIDEO_BASE_URL?.trim().length ?? 0) > 0);
  checks.push({
    id: "h3",
    label: "口播视频生成",
    ok: h3Ok,
    detail: videoAroll
      ? (h3Ok ? "口播视频生成服务已就绪" : "口播视频生成服务未配置，请联系管理员")
      : "当前使用静态画面模式",
  });

  checks.push({
    id: "analysis",
    label: "参考片分析完成",
    ok: input.session.analysisPath !== undefined,
    detail: input.session.analysisPath === undefined ? "请先点击「开始分析」" : "已完成",
  });

  const { names: referenceNames } = normalizeProductReferences(input.session);
  const hasReference = hasProductReference(input.session);
  checks.push({
    id: "reference-image",
    label: "参考图已上传",
    ok: hasReference,
    detail: hasReference
      ? productReferenceLabels(referenceNames)
      : "请在「素材」上传产品/人物参考图",
  });

  const review = input.session.directorReview;
  const reviewOk = !hasReference || review?.status === "approved";
  checks.push({
    id: "director-review",
    label: "导演审查已通过",
    ok: reviewOk,
    detail: review?.status === "approved"
      ? "创意方案与口播文案已确认"
      : hasReference
        ? "请在 Cursor 中确认创意方案与口播文案，然后点击「导演审查通过」"
        : "上传参考图后启用",
  });

  const adapt = input.session.adaptation;
  const adaptOk = hasReference
    && reviewOk
    && adapt?.status === "complete"
    && adapt.generatedSpeechPath !== undefined
    && adaptationMatchesReference(adapt, normalizeProductReferences(input.session).paths);
  checks.push({
    id: "adaptation",
    label: "改编配音已就绪",
    ok: adaptOk,
    detail: adapt?.status === "running"
      ? (adapt.phase ?? "制作中…")
      : adapt?.status === "error"
        ? (adapt.error ?? "制作失败")
        : adaptOk
          ? "改编配音已生成，可试听确认"
          : reviewOk
            ? "导演审查通过后点击「开始制作配音」"
            : "请先完成导演审查",
  });

  if (input.forBuild === true) {
    checks.push({
      id: "scaffold",
      label: "制作项目已生成",
      ok: input.session.scaffold?.runPath !== undefined,
      detail: input.session.scaffold?.runPath === undefined ? "请先点击「一键复刻」" : "制作项目已创建",
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
        label: "制作项目文件",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks };
}

export function formatOfficialPathReport(report: OfficialPathReport): string {
  return [
    "# 复刻准备清单",
    "",
    report.ok ? "状态：**已就绪**" : "状态：**未完成**（请补齐下列项后再一键复刻）",
    "",
    ...report.checks.map((check) => `- [${check.ok ? "x" : " "}] **${check.label}** — ${check.detail}`),
    "",
  ].join("\n");
}
