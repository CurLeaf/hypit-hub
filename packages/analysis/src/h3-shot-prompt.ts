import { chatCompletion, extractJsonObject, loadChatGateway } from "./llm.js";
import type { ShotPlan } from "./shot-plan.js";
import type { BriefView, TreatmentView, ViralInsightView } from "./shared.js";
import {
  buildTierListSpokenScriptGuide,
  resolveTierListMode,
  usesTierListOverlayFromContext,
} from "./tier-list-mode.js";

export {
  buildTierListSpokenScriptGuide,
  contentUsesTierList,
  H3_TIER_LABELS,
  H3_TIER_LIST_OVERLAY_BLOCK,
  resolveTierListMode,
  spokenScriptMentionsTierLabels,
  TIER_LIST_DIRECTOR_HINT,
  usesTierListOverlayFromContext,
  validateSpokenScriptTierLabels,
} from "./tier-list-mode.js";

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
  readonly brief?: BriefView;
  readonly adaptationGoal?: string;
  readonly runtimePath?: string;
  readonly workspaceRoot: string;
  readonly requireSuccess?: boolean;
  readonly useTierListOverlay?: boolean;
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

  const useTierListOverlay = input.useTierListOverlay
    ?? resolveTierListMode({
      insight: input.insight,
      ...(input.treatment === undefined ? {} : { treatment: input.treatment }),
      ...(input.brief === undefined ? {} : { brief: input.brief }),
      ...(input.adaptationGoal === undefined ? {} : { adaptationGoal: input.adaptationGoal }),
      scenes: input.shots,
    });

  const shotIds = input.shots.map((shot) => shot.id);
  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "You write English visual-direction prompts for MiniMax H3 reference-to-video (r2va).",
        "Output a strict JSON object: keys must exactly match the input shot ids (" + shotIds.join(", ") + "); values are English action strings.",
        "Each value: 2–4 sentences. Cover framing, performance energy, product/subject visibility, and viral pacing cues translated from the analysis.",
        useTierListOverlay
          ? "A separate tier-list overlay slot supplies the left-side ranking panel — do not restate that layout. Focus action on presenter framing, product visibility, lip-sync energy, and which tier row should pulse for this beat. Do not add competing title stickers or extra overlays."
          : "Do not invent ranking panels, title stickers, or other readable on-screen graphics unless the analysis explicitly requires them.",
        "The spoken script is supplied separately — do not quote dialogue. Mention lip-sync to the supplied script.",
        "Output English only. No Chinese characters.",
      ].join("\n"),
      user: JSON.stringify({
        useTierListOverlay,
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
    let parsed: Record<string, unknown>;
    try {
      parsed = extractJsonObject(content);
    } catch {
      if (input.requireSuccess === true) throw new Error("H3 action prompt 模型未返回有效 JSON");
      return result;
    }
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
