import { chatCompletion, loadChatGateway } from "./llm.js";
import type { ShotPlan } from "./shot-plan.js";
import type { TreatmentView, ViralInsightView } from "./shared.js";

const CJK_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf]/u;

/** H3 action prompts should be English-only for the model template. */
export function sanitizeH3ShotAction(action: string): string | undefined {
  const trimmed = action.trim();
  if (trimmed.length === 0 || CJK_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

export async function buildH3ShotActions(input: {
  readonly shots: readonly ShotPlan[];
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly runtimePath?: string;
  readonly workspaceRoot: string;
  readonly requireSuccess?: boolean;
}): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (input.shots.length === 0) return result;

  const gateway = await loadChatGateway(input.runtimePath, input.workspaceRoot);
  if (gateway === undefined) {
    if (input.requireSuccess === true) {
      throw new Error("缺少对话模型配置，无法生成 H3 英文 visual-direction prompt");
    }
    return result;
  }

  const shotIds = input.shots.map((shot) => shot.id);
  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "You write English visual-direction prompts for MiniMax H3 reference-to-video (r2va).",
        "Output a strict JSON object: keys must exactly match the input shot ids (" + shotIds.join(", ") + "); values are English action strings.",
        "Each value: 2–4 sentences. Cover framing, performance energy, product/subject visibility, and viral pacing cues translated from the analysis.",
        "The spoken script is supplied separately — do not quote dialogue. Mention lip-sync to the supplied script.",
        "Output English only. No Chinese characters.",
      ].join("\n"),
      user: JSON.stringify({
        insight: {
          summary: input.insight.summary,
          hookAnalysis: input.insight.hookAnalysis,
          whyViral: input.insight.whyViral,
          howItWorks: input.insight.howItWorks,
          replicationTips: input.insight.replicationTips,
        },
        treatment: input.treatment?.markdown?.slice(0, 2000),
        shots: input.shots.map((shot) => ({
          id: shot.id,
          index: shot.index,
          dialoguePreview: shot.text.slice(0, 120),
          scenePromptHint: shot.scenePromptHint.slice(0, 500),
        })),
      }, null, 2),
    });
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) {
      if (input.requireSuccess === true) throw new Error("H3 action prompt 模型未返回有效 JSON");
      return result;
    }
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    for (const shot of input.shots) {
      const value = parsed[shot.id];
      if (typeof value === "string") {
        const sanitized = sanitizeH3ShotAction(value);
        if (sanitized !== undefined) result.set(shot.id, sanitized);
      }
    }
    if (input.requireSuccess === true) {
      const missing = input.shots.filter((shot) => !result.has(shot.id));
      if (missing.length > 0) {
        throw new Error("H3 action prompt 生成不完整：缺少 " + missing.map((shot) => shot.id).join("、"));
      }
    }
  } catch (error) {
    if (input.requireSuccess === true) throw error;
  }
  return result;
}
