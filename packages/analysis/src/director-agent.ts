import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { approveDirectorReview } from "./director-review.js";
import { normalizeProductReferences } from "./product-reference.js";
import { resolveTargetDurationSeconds } from "./target-duration.js";
import type {
  AnalysisSessionView,
  DirectorAgentConfigView,
  DirectorAgentView,
  ViralInsightView,
} from "./shared.js";

export type DirectorAgentProviderId = "cursor" | "manual";

export type RunDirectorAgentInput = {
  readonly workspaceRoot: string;
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly onPhase?: (phase: string) => void;
};

export type RunDirectorAgentResult = {
  readonly ok: boolean;
  readonly provider: DirectorAgentProviderId;
  readonly issues?: readonly string[];
  readonly error?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly resultText?: string;
};

const DEFAULT_MODEL = "composer-2.5";

function normalizeAgentMode(raw: string | undefined): DirectorAgentProviderId {
  const value = raw?.trim().toLowerCase();
  if (value === "cursor" || value === "auto") return "cursor";
  return "manual";
}

function isAutoEnabled(provider: DirectorAgentProviderId): boolean {
  if (provider === "manual") return false;
  const raw = process.env.HYPIT_DIRECTOR_AGENT_AUTO?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  return true;
}

export function resolveDirectorAgentConfig(): DirectorAgentConfigView {
  const provider = normalizeAgentMode(process.env.HYPIT_DIRECTOR_AGENT);
  const model = process.env.HYPIT_DIRECTOR_AGENT_MODEL?.trim() || DEFAULT_MODEL;
  if (provider === "manual") {
    return { provider, auto: false, available: false, model, missing: "HYPIT_DIRECTOR_AGENT=manual" };
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return {
      provider: "cursor",
      auto: false,
      available: false,
      model,
      missing: "缺少 CURSOR_API_KEY",
    };
  }
  return {
    provider: "cursor",
    auto: isAutoEnabled("cursor"),
    available: true,
    model,
  };
}

function relPath(workspaceRoot: string, absolutePath: string | undefined): string {
  if (absolutePath === undefined) return "（未就绪）";
  return relative(workspaceRoot, absolutePath).replace(/\\/gu, "/") || ".";
}

async function readOptionalText(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export function buildDirectorAgentPrompt(input: RunDirectorAgentInput): string {
  const review = input.session.directorReview;
  const goal = input.session.adaptationGoal?.trim()
    || "用户已上传新产品参考图，请结合参考片结构与参考图改写口播。";
  return [
    "你是 Hypit 爆款复刻流程中的导演 Agent。",
    "",
    `工作目录：${input.workspaceRoot}`,
    "",
    "请在本仓库内完成导演审查，编辑：",
    "- .hypit/analysis/director/BRIEF.md",
    "- .hypit/analysis/director/TREATMENT.md",
    "- .hypit/analysis/director/scenes.json（保持 scene-* id 不变）",
    "",
    "先阅读：",
    `- ${relPath(input.workspaceRoot, review?.requestPath ?? join(input.workspaceRoot, ".hypit/analysis/director/REVIEW_REQUEST.md"))}`,
    ...normalizeProductReferences(input.session).paths.map((path, index) => `- 产品参考图 ${index + 1}：${relPath(input.workspaceRoot, path)}`),
    `- 参考视频转写：${relPath(input.workspaceRoot, input.session.transcript?.path)}`,
    `- 深读归档：${relPath(input.workspaceRoot, input.session.referenceArchive?.referenceDir)}`,
    "",
    `改编说明：${goal}`,
    `目标成片时长：约 ${resolveTargetDurationSeconds(input.session)} 秒。scenes.json 各段口播合计朗读时长应接近该目标，后续会拆成多个 ≤15 秒的 H3 分镜。`,
    "",
    "必须做到：",
    "1. BRIEF.md 写清产品名、品类、可被镜头验证的卖点、口语价格锚点；删除所有占位符（含「请填写」「请写明」）",
    "2. TREATMENT.md 按切点写清每段 A-roll / B-roll 与表演方向",
    "3. scenes.json 各段口播改为新产品/新主体，保留参考片结构与节奏，禁止照搬原片 ASR 台词",
    "4. 不要编造参考图无法验证的规格参数",
    "",
    "完成后用简短中文总结：改了哪些卖点、各段口播主题。不要模拟点击 Analysis UI。",
  ].join("\n");
}

async function runCursorDirectorAgent(input: RunDirectorAgentInput): Promise<RunDirectorAgentResult> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return { ok: false, provider: "cursor", error: "缺少 CURSOR_API_KEY" };
  }

  let Agent: typeof import("@cursor/sdk").Agent;
  let CursorAgentError: typeof import("@cursor/sdk").CursorAgentError | undefined;
  try {
    const sdk = await import("@cursor/sdk");
    Agent = sdk.Agent;
    CursorAgentError = sdk.CursorAgentError;
  } catch {
    return {
      ok: false,
      provider: "cursor",
      error: "未安装 @cursor/sdk。请在仓库根目录执行：pnpm add @cursor/sdk --filter @hypit/analysis",
    };
  }

  const config = resolveDirectorAgentConfig();
  const prompt = buildDirectorAgentPrompt(input);
  input.onPhase?.("Cursor Agent 正在改写导演稿…");

  try {
    const result = await Agent.prompt(prompt, {
      apiKey,
      model: { id: config.model },
      local: {
        cwd: input.workspaceRoot,
        settingSources: [],
      },
    });
    if (result.status === "error") {
      return {
        ok: false,
        provider: "cursor",
        error: `Cursor Agent 运行失败（run ${result.id ?? "unknown"}）`,
        runId: result.id,
        agentId: result.agentId,
        resultText: result.result,
      };
    }
    input.onPhase?.("校验导演稿…");
    const issues = await approveDirectorReview(input.workspaceRoot, {
      session: input.session,
      insight: input.insight,
    });
    if (issues.length > 0) {
      return {
        ok: false,
        provider: "cursor",
        issues,
        error: issues.join("；"),
        runId: result.id,
        agentId: result.agentId,
        resultText: result.result,
      };
    }
    return {
      ok: true,
      provider: "cursor",
      runId: result.id,
      agentId: result.agentId,
      resultText: result.result,
    };
  } catch (error) {
    if (CursorAgentError !== undefined && error instanceof CursorAgentError) {
      return {
        ok: false,
        provider: "cursor",
        error: `Cursor Agent 启动失败：${error.message}`,
      };
    }
    return {
      ok: false,
      provider: "cursor",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDirectorAgent(input: RunDirectorAgentInput): Promise<RunDirectorAgentResult> {
  const config = resolveDirectorAgentConfig();
  if (config.provider === "manual") {
    return { ok: false, provider: "manual", error: "导演 Agent 已设为 manual 模式" };
  }
  if (config.provider === "cursor") {
    return runCursorDirectorAgent(input);
  }
  return { ok: false, provider: config.provider, error: `未知导演 Agent：${config.provider}` };
}

export function initialDirectorAgentView(
  config: DirectorAgentConfigView,
  phase: string,
): DirectorAgentView {
  return {
    provider: config.provider === "manual" ? "cursor" : config.provider,
    status: "running",
    phase,
  };
}

export function completeDirectorAgentView(
  previous: DirectorAgentView | undefined,
  result: RunDirectorAgentResult,
): DirectorAgentView {
  const provider = result.provider === "manual" ? "cursor" : result.provider;
  if (result.ok) {
    return {
      provider,
      status: "complete",
      phase: "导演 Agent 已完成审查",
      runId: result.runId,
      agentId: result.agentId,
      finishedAt: Date.now(),
    };
  }
  return {
    provider,
    status: "error",
    phase: "导演 Agent 未完成",
    error: result.error ?? result.issues?.join("；") ?? "未知错误",
    runId: result.runId,
    agentId: result.agentId,
    finishedAt: Date.now(),
  };
}

export async function loadDirectorAgentContext(workspaceRoot: string, requestPath: string | undefined): Promise<string> {
  const request = await readOptionalText(requestPath);
  if (request === undefined) return "";
  return request.slice(0, 4000);
}
