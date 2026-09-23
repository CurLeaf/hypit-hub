import type { AdaptationView } from "./shared.js";

function pathBasename(path: string): string {
  return path.split(/[/\\]/u).pop() ?? path;
}

/** GPT Image edits 上限 */
export const MAX_GPT_PRODUCT_REFERENCE_IMAGES = 16;
/** MiniMax H3 reference_image 上限 */
export const MAX_H3_PRODUCT_REFERENCE_IMAGES = 9;
/** 官方复刻默认走 H3 A-roll，上传上限与 H3 对齐 */
export const MAX_PRODUCT_REFERENCE_IMAGES = MAX_H3_PRODUCT_REFERENCE_IMAGES;

export function maxProductReferenceImages(input: { readonly videoAroll?: boolean }): number {
  return (input.videoAroll ?? true)
    ? MAX_H3_PRODUCT_REFERENCE_IMAGES
    : MAX_GPT_PRODUCT_REFERENCE_IMAGES;
}

export type ProductReferenceFields = {
  readonly productReferencePaths?: readonly string[];
  readonly productReferenceNames?: readonly string[];
  readonly productReferencePath?: string;
  readonly productReferenceName?: string;
};

export function normalizeProductReferences(
  input: ProductReferenceFields,
): { readonly paths: readonly string[]; readonly names: readonly string[] } {
  if (input.productReferencePaths !== undefined && input.productReferencePaths.length > 0) {
    const paths = input.productReferencePaths;
    const names = input.productReferenceNames?.length === paths.length
      ? input.productReferenceNames
      : paths.map((path, index) => input.productReferenceNames?.[index] ?? pathBasename(path));
    return { paths, names };
  }
  if (input.productReferencePaths !== undefined && input.productReferencePath !== undefined) {
    return {
      paths: [input.productReferencePath],
      names: [input.productReferenceName ?? pathBasename(input.productReferencePath)],
    };
  }
  if (input.productReferencePath !== undefined) {
    return {
      paths: [input.productReferencePath],
      names: [input.productReferenceName ?? "参考图"],
    };
  }
  return { paths: [], names: [] };
}

export function hasProductReference(input: ProductReferenceFields): boolean {
  return normalizeProductReferences(input).paths.length > 0;
}

export function productReferenceAssetId(index: number): string {
  return index === 0 ? "product-reference" : `product-reference-${index + 1}`;
}

export function productReferenceAssetFileName(index: number, ext: string): string {
  return index === 0 ? `product-reference${ext}` : `product-reference-${index + 1}${ext}`;
}

export function productReferenceLabels(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0]!;
  return `${names.length} 张参考图（${names.join("、")}）`;
}

export function productReferenceSources(adaptation: AdaptationView | undefined): readonly string[] {
  if (adaptation === undefined) return [];
  if (adaptation.productReferenceSources !== undefined && adaptation.productReferenceSources.length > 0) {
    return adaptation.productReferenceSources;
  }
  if (adaptation.productReferenceSource !== undefined) return [adaptation.productReferenceSource];
  return [];
}

export function adaptationMatchesReference(
  adaptation: AdaptationView | undefined,
  paths: readonly string[],
): boolean {
  if (adaptation === undefined || paths.length === 0) return false;
  const sources = productReferenceSources(adaptation);
  return sources.length === paths.length && sources.every((source, index) => source === paths[index]);
}

export function referencesChanged(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length !== next.length || previous.some((path, index) => path !== next[index]);
}

export function productReferenceSessionUpdate(
  paths: readonly string[],
  names: readonly string[],
): ProductReferenceFields {
  return {
    productReferencePaths: paths,
    productReferenceNames: names,
    ...(paths[0] === undefined ? {} : { productReferencePath: paths[0], productReferenceName: names[0] }),
  };
}

export function countProductReferenceAssets(svml: string): number {
  const ids = new Set<string>();
  for (const match of svml.matchAll(/<asset:Image\s+id="(product-reference(?:-\d+)?)"/gu)) {
    ids.add(match[1]!);
  }
  return ids.size;
}

export function hasProductReferenceBindings(svml: string, count: number): boolean {
  if (count <= 0) return false;
  if (!svml.includes('id="product-reference"')) return false;
  for (let index = 2; index <= count; index += 1) {
    if (!svml.includes(`id="product-reference-${index}"`)) return false;
  }
  return svml.includes("<gpt:Reference image={product-reference")
    || svml.includes("<h3:Reference image={product-reference");
}

export function clearedProductReferenceSessionFields(): ProductReferenceFields {
  return {
    productReferencePaths: undefined,
    productReferenceNames: undefined,
    productReferencePath: undefined,
    productReferenceName: undefined,
  };
}
