import { chatCompletion, extractJsonObject, loadChatGateway } from "./llm.js";
import type { ShotPlan } from "./shot-plan.js";
import type { TreatmentView } from "./shared.js";

export type ProductReferenceCatalogItem = {
  readonly id: string;
  readonly name: string;
};

const PRODUCT_VISIBILITY_PATTERN = /\b(?:product|packaging|label|hero|box|bottle|device|package|insert|close-up|holding|hands-only|b-roll|demo|detail|spec|subject|dryer|counter|marble|upright|coiled|wardrobe|presenter|ugc)\b/iu;

export function buildProductReferenceCatalog(
  assetIds: readonly string[],
  names: readonly string[],
): readonly ProductReferenceCatalogItem[] {
  return assetIds.map((id, index) => ({
    id,
    name: names[index]?.trim() || id,
  }));
}

function shotNeedsProductReference(input: {
  readonly action: string;
  readonly scenePromptHint: string;
}): boolean {
  const combined = `${input.action} ${input.scenePromptHint}`;
  if (PRODUCT_VISIBILITY_PATTERN.test(combined)) return true;
  if (/product or subject from the reference image/u.test(input.action)) return true;
  if (/keep the product/u.test(combined)) return true;
  return false;
}

function chineseNameFragments(name: string): readonly string[] {
  const chars = [...name.match(/[\u4e00-\u9fff]/gu) ?? []];
  const fragments = new Set<string>();
  for (let length = 2; length <= Math.min(4, chars.length); length += 1) {
    for (let index = 0; index <= chars.length - length; index += 1) {
      fragments.add(chars.slice(index, index + length).join(""));
    }
  }
  return [...fragments];
}

function matchCatalogByName(
  haystack: string,
  catalog: readonly ProductReferenceCatalogItem[],
): readonly string[] {
  const normalized = haystack.toLowerCase();
  const matched = new Map<string, ProductReferenceCatalogItem>();
  for (const item of catalog) {
    const name = item.name.trim();
    if (name.length === 0 || name === "参考图") continue;
    if (normalized.includes(name.toLowerCase())) {
      matched.set(item.id, item);
      continue;
    }
    if (chineseNameFragments(name).some((fragment) => haystack.includes(fragment))) {
      matched.set(item.id, item);
    }
  }
  return [...matched.values()].map((item) => item.id);
}

function matchCatalogByEnglishHints(
  action: string,
  catalog: readonly ProductReferenceCatalogItem[],
): readonly string[] {
  const lower = action.toLowerCase();
  const hints: Array<{ readonly pattern: RegExp; readonly fragments: readonly string[] }> = [
    { pattern: /\b(?:packaging|label|ingredient|box)\b/u, fragments: ["包装", "配料", "盒"] },
    { pattern: /\b(?:pour|liquid|cling|texture)\b/u, fragments: ["倒", "挂壁", "奶"] },
    { pattern: /\b(?:hair dryer|dryer|product hero|hero insert)\b/u, fragments: ["吹风", "产品"] },
  ];
  const matched = new Map<string, ProductReferenceCatalogItem>();
  for (const { pattern, fragments } of hints) {
    if (!pattern.test(lower)) continue;
    for (const item of catalog) {
      if (fragments.some((fragment) => item.name.includes(fragment))) {
        matched.set(item.id, item);
      }
    }
  }
  return [...matched.values()].map((item) => item.id);
}

/** Infer which uploaded product references a shot needs from its visual-direction prompt. */
export function inferProductReferencesFromShot(input: {
  readonly action: string;
  readonly scenePromptHint: string;
  readonly dialogue: string;
  readonly catalog: readonly ProductReferenceCatalogItem[];
}): readonly string[] {
  if (input.catalog.length === 0) return [];
  if (!shotNeedsProductReference(input)) return [];

  if (input.catalog.length === 1) {
    return [input.catalog[0]!.id];
  }

  const haystack = `${input.action} ${input.scenePromptHint} ${input.dialogue}`;
  const byName = matchCatalogByName(haystack, input.catalog);
  if (byName.length > 0) return byName;
  const byHints = matchCatalogByEnglishHints(input.action, input.catalog);
  if (byHints.length > 0) return byHints;
  return [input.catalog[0]!.id];
}

export function resolveH3ShotImageRefs(input: {
  readonly index: number;
  readonly shotId: string;
  readonly previousTakeId?: string;
  readonly productRefs: readonly string[];
  readonly shotReferencePlan?: ReadonlyMap<string, readonly string[]>;
  /** Used when a shot ends up with no image refs — H3 r2va requires at least one. */
  readonly fallbackProductRef?: string;
}): readonly string[] {
  const planned = input.shotReferencePlan?.get(input.shotId);
  const productRefs = planned !== undefined && planned.length > 0 ? planned : input.productRefs;
  const refs: string[] = [...productRefs];
  if (input.index > 0 && input.previousTakeId !== undefined) {
    refs.push(`${input.previousTakeId}-last.image`);
  }
  const unique = [...new Set(refs)];
  if (unique.length === 0 && input.fallbackProductRef !== undefined) {
    return [input.fallbackProductRef];
  }
  return unique;
}

function parseReferencePlan(
  parsed: Record<string, unknown>,
  shots: readonly ShotPlan[],
  catalog: readonly ProductReferenceCatalogItem[],
): Map<string, readonly string[]> {
  const validIds = new Set(catalog.map((item) => item.id));
  const result = new Map<string, readonly string[]>();
  for (const shot of shots) {
    const value = parsed[shot.id];
    if (!Array.isArray(value)) continue;
    const ids = value.filter((item): item is string => typeof item === "string" && validIds.has(item));
    result.set(shot.id, ids);
  }
  return result;
}

export async function buildH3ShotReferencePlan(input: {
  readonly shots: readonly ShotPlan[];
  readonly resolvedActions: ReadonlyMap<string, string>;
  readonly catalog: readonly ProductReferenceCatalogItem[];
  readonly treatment?: TreatmentView;
  readonly runtimePath?: string;
  readonly workspaceRoot: string;
  readonly requireSuccess?: boolean;
}): Promise<Map<string, readonly string[]>> {
  const result = new Map<string, readonly string[]>();
  for (const shot of input.shots) {
    const action = input.resolvedActions.get(shot.id)
      ?? shot.scenePromptHint
      ?? "";
    result.set(shot.id, inferProductReferencesFromShot({
      action,
      scenePromptHint: shot.scenePromptHint,
      dialogue: shot.text,
      catalog: input.catalog,
    }));
  }

  if (input.catalog.length <= 1 || input.shots.length === 0) {
    return result;
  }

  const gateway = await loadChatGateway(input.runtimePath, input.workspaceRoot);
  if (gateway === undefined) {
    if (input.requireSuccess === true) {
      throw new Error("缺少对话模型配置，无法生成 H3 参考图规划");
    }
    return result;
  }

  const shotIds = input.shots.map((shot) => shot.id);
  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "You plan which uploaded reference images each H3 video shot needs.",
        "Output a strict JSON object: keys must exactly match the input shot ids (" + shotIds.join(", ") + "); values are arrays of reference asset ids.",
        "Only include reference ids that the shot's visual direction actually needs on screen.",
        "Do not attach every reference to every shot — later-introduced packaging or detail refs belong only on shots that show them.",
        "Talking-head or presenter shots that still show the main product should include the primary product reference.",
        "Every shot must include at least one reference image id — H3 r2va cannot run without a Reference image.",
        "Opening hooks without a specific product on screen should still use the primary product reference for visual continuity.",
        "Use only ids from the supplied referenceCatalog.",
      ].join("\n"),
      user: JSON.stringify({
        referenceCatalog: input.catalog,
        treatment: input.treatment?.markdown?.slice(0, 2000),
        shots: input.shots.map((shot) => ({
          id: shot.id,
          index: shot.index,
          dialoguePreview: shot.text.slice(0, 120),
          scenePromptHint: shot.scenePromptHint.slice(0, 500),
          action: (input.resolvedActions.get(shot.id) ?? "").slice(0, 1200),
          heuristicReferences: result.get(shot.id) ?? [],
        })),
      }, null, 2),
    });
    let parsed: Record<string, unknown>;
    try {
      parsed = extractJsonObject(content);
    } catch {
      if (input.requireSuccess === true) throw new Error("H3 参考图规划模型未返回有效 JSON");
      return result;
    }
    const planned = parseReferencePlan(parsed, input.shots, input.catalog);
    for (const shot of input.shots) {
      if (!planned.has(shot.id)) continue;
      const ids = planned.get(shot.id)!;
      if (ids.length > 0) {
        result.set(shot.id, ids);
      }
    }
    if (input.requireSuccess === true) {
      const missing = input.shots.filter((shot) => !planned.has(shot.id));
      if (missing.length > 0) {
        throw new Error("H3 参考图规划不完整：缺少 " + missing.map((shot) => shot.id).join("、"));
      }
    }
  } catch (error) {
    if (input.requireSuccess === true) throw error;
  }
  return result;
}
