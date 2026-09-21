export { createOpenAiCompatibleProvider, providerModule } from "./provider.js";
export {
  capabilityKey,
  defaultOpenAiCompatibleRoutes,
  normalizeBaseUrl,
  OpenAiCompatibleClient,
  parseVideoAdapter,
  VIDEO_ADAPTERS,
} from "./client.js";
export type { OpenAiCompatibleProviderOptions, OpenAiCompatibleRoutes, VideoAdapter } from "./client.js";
export type { S3PublicUploadConfig } from "./s3-public-upload.js";
