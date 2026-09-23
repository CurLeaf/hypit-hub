import type { ShotPlan } from "./shot-plan.js";
import type { BriefView, TreatmentView, ViralInsightView } from "./shared.js";

const TIER_LIST_PATTERN = /排行|榜单|第.{0,2}名|级别|\btier\b|\brank\b|夯|顶级|人上人|NPC|底边|从.{0,2}到.{0,2}拉/iu;

export const H3_TIER_LABELS = ["夯", "顶级", "人上人", "NPC", "底边"] as const;

export type TierListSceneHint = {
  readonly text: string;
  readonly scenePromptHint: string;
};

/** Full tier-list overlay spec passed through the optional `tier-list` template slot. */
export const H3_TIER_LIST_OVERLAY_BLOCK =
  "Keep a fixed vertical ranking panel on the left ~30% of the 9:16 frame for the full clip. Five stacked tiers labeled "
  + H3_TIER_LABELS.join(", ")
  + " (top to bottom) with a bold colored header row and small product thumbnail slots beside each tier. Style: short-form Chinese social-video tier-list graphic — high contrast, flat vector stickers, readable Chinese labels, stable placement across frames. When the spoken script names one of these five tier labels, highlight that tier row with a subtle glow or scale pulse.";

export function contentUsesTierList(...texts: readonly string[]): boolean {
  return texts.some((text) => TIER_LIST_PATTERN.test(text));
}

export function resolveTierListMode(input: {
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly scenes: readonly TierListSceneHint[];
  readonly adaptationGoal?: string;
  readonly brief?: BriefView;
}): boolean {
  const briefGoal = input.brief?.markdown?.match(/## 目标[\s\S]*?(?=\n## |\n*$)/u)?.[0] ?? "";
  return contentUsesTierList(
    input.insight.summary,
    input.insight.hookAnalysis,
    ...(input.insight.replicationTips ?? []),
    input.treatment?.markdown ?? "",
    input.adaptationGoal ?? "",
    briefGoal,
    ...input.scenes.flatMap((scene) => [scene.text, scene.scenePromptHint]),
  );
}

export function usesTierListOverlayFromContext(input: {
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly shots: readonly Pick<ShotPlan, "text" | "scenePromptHint">[];
  readonly adaptationGoal?: string;
  readonly brief?: BriefView;
}): boolean {
  return resolveTierListMode({
    insight: input.insight,
    ...(input.treatment === undefined ? {} : { treatment: input.treatment }),
    scenes: input.shots,
    ...(input.adaptationGoal === undefined ? {} : { adaptationGoal: input.adaptationGoal }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
  });
}

function scriptMentionsTierLabel(text: string, label: string): boolean {
  if (label === "夯") return /夯(?!到)/u.test(text);
  if (label === "NPC") return /NPC/iu.test(text);
  return text.includes(label);
}

export function spokenScriptMentionsTierLabels(...texts: readonly string[]): boolean {
  const combined = texts.join("");
  return H3_TIER_LABELS.some((label) => scriptMentionsTierLabel(combined, label));
}

export function validateSpokenScriptTierLabels(...texts: readonly string[]): readonly string[] {
  if (spokenScriptMentionsTierLabels(...texts)) return [];
  return [`口播必须明确念出排行榜五级标准词之一：${H3_TIER_LABELS.join("、")}（不要使用「夯到爆」「从夯到拉」等变体）`];
}

/** Structured ranking guidance for spoken-script adaptation. */
export function buildTierListSpokenScriptGuide(
  productReferenceNames: readonly string[] = [],
): string {
  const productLine = productReferenceNames.length > 0
    ? `待评级产品/参考图：${productReferenceNames.join("、")}。请为每一款分配一个等级词，并在口播揭晓时明确念出。`
    : "结合用户上传的产品参考图，为每一款分配一个等级词，并在口播揭晓时明确念出。";
  return [
    `参考片是「榜单 / 排行榜」类内容，左侧视觉为五级排行：${H3_TIER_LABELS.join(" / ")}。`,
    productLine,
    "口播必须保留「先预告排名框架 → 逐款揭晓 → 每款给出等级词 + 一句理由」的节奏。",
    `每款揭晓时必须原样念出五级标准词之一（${H3_TIER_LABELS.join("、")}），例如「给到夯」「顶级档」「人上人」「给到 NPC」「底边档」。`,
    "禁止使用「夯到爆」「从夯到拉」等非标准变体；画面排行榜只识别上述五级词。",
    "若无足够信息把某款落到具体档位，仍须用五级标准词之一收束该段，并说明取舍。",
  ].join("\n");
}

export const TIER_LIST_DIRECTOR_HINT =
  "本片为排行榜复刻：director/scenes.json 每段口播须明确念出五级标准词（夯、顶级、人上人、NPC、底边），不可用「夯到爆」等变体，以便与左侧排行榜 UI 同步。";
