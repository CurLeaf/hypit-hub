import { Converter } from "../vendor/opencc-js/dist/esm/t2cn.js";

const toSimplified = Converter({ from: "tw", to: "cn" });

export function compactSpokenText(text: string): string {
  return text.replace(/\s+/gu, "").trim();
}

export function spokenTextOverlap(left: string, right: string): number {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size -= 1) {
    if (left.endsWith(right.slice(0, size))) return size;
  }
  return 0;
}

/** Join cut-aligned scene fragments without duplicating boundary characters. */
export function mergeSpokenSceneTexts(texts: readonly string[]): string {
  const normalized = texts.map(compactSpokenText).filter((text) => text.length > 0);
  if (normalized.length === 0) return "";
  let merged = normalized[0]!;
  for (let index = 1; index < normalized.length; index += 1) {
    const next = normalized[index]!;
    merged += next.slice(spokenTextOverlap(merged, next));
  }
  return merged;
}

/** Remove duplicate characters introduced by cut-aligned ASR windows. */
export function dedupeAdjacentSceneTexts<T extends { readonly text: string }>(
  scenes: readonly T[],
): T[] {
  if (scenes.length === 0) return [];
  const result: T[] = [{ ...scenes[0]!, text: compactSpokenText(scenes[0]!.text) }];
  for (let index = 1; index < scenes.length; index += 1) {
    const previous = result[result.length - 1]!.text;
    const next = compactSpokenText(scenes[index]!.text);
    const overlap = spokenTextOverlap(previous, next);
    result.push({ ...scenes[index]!, text: next.slice(overlap) });
  }
  return result;
}

export function toSimplifiedChinese(text: string): string {
  if (text.length === 0) return text;
  return toSimplified(text);
}

export function normalizeSpokenChinese(text: string): string {
  return toSimplifiedChinese(compactSpokenText(text));
}

export function normalizeSceneTexts<T extends { readonly text: string }>(
  scenes: readonly T[],
): T[] {
  return dedupeAdjacentSceneTexts(
    scenes.map((scene) => ({ ...scene, text: normalizeSpokenChinese(scene.text) })),
  );
}
