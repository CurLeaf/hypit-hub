export { createOpenAiCompatibleProvider, providerModule } from "./provider.js";
export {
  capabilityKey,
  defaultOpenAiCompatibleRoutes,
  normalizeBaseUrl,
  OpenAiCompatibleClient,
} from "./client.js";
export type { OpenAiCompatibleProviderOptions, OpenAiCompatibleRoutes } from "./client.js";
export type { S3PublicUploadConfig } from "./s3-public-upload.js";
