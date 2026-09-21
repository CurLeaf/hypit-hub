import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";
import type { CanonicalValue } from "@hypit/protocol";

import { defaultOpenAiCompatibleRoutes, normalizeBaseUrl, parseVideoAdapter } from "./client.js";
import { applyVideoAdapterRoutes } from "./minimax-v2.js";
import { createOpenAiCompatibleProvider } from "./provider.js";
import { resolveRuntimeText } from "./runtime-text.js";
import { s3PublicUploadConfigFromEnv } from "./s3-public-upload.js";

function modelMap(config: Record<string, CanonicalValue>): Readonly<Record<string, string>> {
  if (config.models === undefined) throw new Error("OpenAI-compatible models config must be an object");
  const models = runtimeConfigObject(config.models, "OpenAI-compatible models");
  const entries = Object.entries(models).map(([key, value]) => {
    const model = runtimeConfigString(value, `OpenAI-compatible models.${key}`);
    if (model === undefined) throw new Error(`OpenAI-compatible models.${key} must be a string`);
    return [key, model] as const;
  });
  if (entries.length === 0) throw new Error("OpenAI-compatible models must declare at least one capability mapping");
  return Object.fromEntries(entries);
}

function routeMap(config: Record<string, CanonicalValue>) {
  if (config.routes === undefined) return undefined;
  const routes = runtimeConfigObject(config.routes, "OpenAI-compatible routes");
  runtimeConfigExact(routes, ["image", "imageEdits", "speech", "videoSubmit", "videoStatus"], "OpenAI-compatible routes");
  const image = runtimeConfigString(routes.image, "OpenAI-compatible routes.image");
  const imageEdits = runtimeConfigString(routes.imageEdits, "OpenAI-compatible routes.imageEdits");
  const speech = runtimeConfigString(routes.speech, "OpenAI-compatible routes.speech");
  const videoSubmit = runtimeConfigString(routes.videoSubmit, "OpenAI-compatible routes.videoSubmit");
  const videoStatus = runtimeConfigString(routes.videoStatus, "OpenAI-compatible routes.videoStatus");
  return {
    ...(image === undefined ? {} : { image }),
    ...(imageEdits === undefined ? {} : { imageEdits }),
    ...(speech === undefined ? {} : { speech }),
    ...(videoSubmit === undefined ? {} : { videoSubmit }),
    ...(videoStatus === undefined ? {} : { videoStatus }),
  };
}

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-openai-compatible",
  activate(context) {
    if (context.pool === undefined) throw new Error("OpenAI-compatible Provider pool is required");
    const config = runtimeConfigObject(context.config, "OpenAI-compatible");
    runtimeConfigExact(config, [
      "baseUrl",
      "apiKey",
      "models",
      "routes",
      "videoAdapter",
      "defaultConcurrency",
      "pollIntervalMs",
      "operationTimeoutMs",
      "requestTimeoutMs",
      // Read by the authoring workflow (Analysis chat/TTS), not by this Provider's requests.
      "chatModel",
      "ttsModel",
      "ttsVoice",
      "referenceUpload",
    ], "OpenAI-compatible");
    const baseUrl = resolveRuntimeText(config.baseUrl, "OpenAI-compatible baseUrl");
    runtimeConfigString(config.chatModel, "OpenAI-compatible chatModel");
    runtimeConfigString(config.ttsModel, "OpenAI-compatible ttsModel");
    runtimeConfigString(config.ttsVoice, "OpenAI-compatible ttsVoice");
    const referenceUploadMode = runtimeConfigString(config.referenceUpload, "OpenAI-compatible referenceUpload") ?? "gateway";
    if (referenceUploadMode !== "gateway" && referenceUploadMode !== "s3") {
      throw new Error("OpenAI-compatible referenceUpload must be gateway or s3");
    }
    const referenceUpload = referenceUploadMode === "s3" ? s3PublicUploadConfigFromEnv() : undefined;
    if (referenceUploadMode === "s3" && referenceUpload === undefined) {
      throw new Error("OpenAI-compatible referenceUpload s3 needs S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_BUCKET_NAME, S3_REGION, S3_CDN");
    }
    if (baseUrl === undefined) throw new Error("OpenAI-compatible baseUrl is required");
    normalizeBaseUrl(baseUrl);
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "OpenAI-compatible apiKey");
    if (apiKey === undefined) throw new Error("OpenAI-compatible apiKey CredentialRef is required");
    const models = modelMap(config);
    for (const key of Object.keys(models)) {
      if (!key.includes("#")) throw new Error(`OpenAI-compatible model key ${key} must be a full capability name`);
    }
    const videoAdapter = parseVideoAdapter(runtimeConfigString(config.videoAdapter, "OpenAI-compatible videoAdapter"));
    const routes = applyVideoAdapterRoutes(
      videoAdapter,
      { ...defaultOpenAiCompatibleRoutes, ...routeMap(config) },
    );
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "OpenAI-compatible defaultConcurrency");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "OpenAI-compatible pollIntervalMs");
    const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "OpenAI-compatible operationTimeoutMs");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "OpenAI-compatible requestTimeoutMs");
    return {
      endpoint: createOpenAiCompatibleProvider({
        instance: context.instance,
        pool: context.pool,
        baseUrl,
        apiKey,
        models,
        routes,
        videoAdapter,
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(referenceUpload === undefined ? {} : { referenceUpload }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  hostFacets: [adapter],
};

export default hypitPackage;
