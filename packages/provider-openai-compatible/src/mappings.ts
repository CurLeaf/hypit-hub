import type { CapabilityRef } from "@hypit/protocol";
import type { GenerationWireMapping } from "@hypit/generation";

const GPT_IMAGE = { name: "@hypit/gpt-image", version: "1" } as const;
const SEEDANCE = { name: "@hypit/seedance", version: "1" } as const;
const MINIMAX = { name: "@hypit/minimax-h3", version: "1" } as const;

const seedance = (name: string): GenerationWireMapping => ({
  capability: { module: SEEDANCE, name },
  result: "video",
  routes: [{ model: name }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    referenceImage: { as: "urlArray", field: "reference_image_urls" },
    referenceVideo: { as: "urlArray", field: "reference_videos" },
    referenceAudio: { as: "urlArray", field: "reference_audios" },
    firstFrame: { as: "url", field: "first_frame" },
    lastFrame: { as: "url", field: "last_frame" },
    resolution: { as: "value", field: "resolution" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    duration: { as: "value", field: "seconds" },
    generateAudio: { as: "value", field: "generate_audio" },
    webSearch: { as: "value", field: "web_search" },
  },
});

export const gptImage2Mapping: GenerationWireMapping = {
  capability: { module: GPT_IMAGE, name: "gpt-image-2" },
  result: "image",
  routes: [{ model: "gpt-image-2" }],
  fields: {
    prompt: { as: "value", field: "prompt" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    resolution: { as: "value", field: "resolution", whenAbsent: "1K" },
    background: { as: "value", field: "background" },
    images: { as: "itemObject", field: "reference_images", urlKey: "url", fieldKeys: {} },
  },
};

export const seedanceMappings: readonly GenerationWireMapping[] = [
  seedance("seedance-2"),
  seedance("seedance-2-fast"),
  seedance("seedance-2-mini"),
  seedance("seedance-2.5"),
];

export const minimaxH3Mapping: GenerationWireMapping = {
  capability: { module: MINIMAX, name: "minimax-h3" },
  result: "video",
  routes: [
    { model: "minimax-h3/image-to-video", whenPresent: ["lastFrame"] },
    { model: "minimax-h3/image-to-video", whenPresent: ["firstFrame"] },
    { model: "minimax-h3/reference-to-video", whenPresent: ["referenceImage"] },
    { model: "minimax-h3/reference-to-video", whenPresent: ["referenceVideo"] },
    { model: "minimax-h3/text-to-video" },
  ],
  fields: {
    prompt: { as: "value", field: "prompt" },
    duration: { as: "value", field: "seconds" },
    resolution: { as: "value", field: "resolution", whenAbsent: "2k" },
    aspectRatio: { as: "value", field: "aspect_ratio" },
    referenceImage: { as: "urlArray", field: "reference_image_urls" },
    referenceVideo: { as: "urlArray", field: "reference_videos" },
    referenceAudio: { as: "urlArray", field: "reference_audios" },
    firstFrame: { as: "url", field: "first_frame" },
    lastFrame: { as: "url", field: "last_frame" },
  },
};

export const openAiCompatibleMappings: readonly GenerationWireMapping[] = [
  gptImage2Mapping,
  ...seedanceMappings,
  minimaxH3Mapping,
];

export function mappingForCapability(capability: CapabilityRef): GenerationWireMapping | undefined {
  const key = `${capability.module.name}@${capability.module.version}#${capability.name}`;
  return openAiCompatibleMappings.find((item) =>
    `${item.capability.module.name}@${item.capability.module.version}#${item.capability.name}` === key);
}
