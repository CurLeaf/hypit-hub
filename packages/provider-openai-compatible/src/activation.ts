import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";

import { defaultOpenAiCompatibleRoutes, normalizeBaseUrl } from "./client.js";
import { createOpenAiCompatibleProvider } from "./provider.js";

function modelMap(config: Record<string, unknown>): Readonly<Record<string, string>> {
  const models = runtimeConfigObject(config.models, "OpenAI-compatible models");
  const entries = Object.entries(models).map(([key, value]) => {
    const model = runtimeConfigString(value, `OpenAI-compatible models.${key}`);
    if (model === undefined) throw new Error(`OpenAI-compatible models.${key} must be a string`);
    return [key, model] as const;
  });
  if (entries.length === 0) throw new Error("OpenAI-compatible models must declare at least one capability mapping");
  return Object.fromEntries(entries);
}

function routeMap(config: Record<string, unknown>) {
  if (config.routes === undefined) return undefined;
  const routes = runtimeConfigObject(config.routes, "OpenAI-compatible routes");
  runtimeConfigExact(routes, ["image", "imageEdits", "speech", "fileUpload", "videoSubmit", "videoStatus"], "OpenAI-compatible routes");
  const image = runtimeConfigString(routes.image, "OpenAI-compatible routes.image");
  const imageEdits = runtimeConfigString(routes.imageEdits, "OpenAI-compatible routes.imageEdits");
  const speech = runtimeConfigString(routes.speech, "OpenAI-compatible routes.speech");
  const fileUpload = runtimeConfigString(routes.fileUpload, "OpenAI-compatible routes.fileUpload");
  const videoSubmit = runtimeConfigString(routes.videoSubmit, "OpenAI-compatible routes.videoSubmit");
  const videoStatus = runtimeConfigString(routes.videoStatus, "OpenAI-compatible routes.videoStatus");
  return {
    ...(image === undefined ? {} : { image }),
    ...(imageEdits === undefined ? {} : { imageEdits }),
    ...(speech === undefined ? {} : { speech }),
    ...(fileUpload === undefined ? {} : { fileUpload }),
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
      "uploadMode",
      "videoAdapter",
      "defaultConcurrency",
      "pollIntervalMs",
      "operationTimeoutMs",
      "requestTimeoutMs",
      // Analysis UI reads these for Brief/Treatment/TTS; the Provider ignores them at runtime.
      "chatModel",
      "ttsModel",
      "ttsVoice",
    ], "OpenAI-compatible");
    const baseUrl = runtimeConfigString(config.baseUrl, "OpenAI-compatible baseUrl");
    if (baseUrl === undefined) throw new Error("OpenAI-compatible baseUrl is required");
    normalizeBaseUrl(baseUrl);
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "OpenAI-compatible apiKey");
    if (apiKey === undefined) throw new Error("OpenAI-compatible apiKey CredentialRef is required");
    const models = modelMap(config);
    for (const key of Object.keys(models)) {
      if (!key.includes("#")) throw new Error(`OpenAI-compatible model key ${key} must be a full capability name`);
    }
    const routes = { ...defaultOpenAiCompatibleRoutes, ...routeMap(config) };
    const uploadMode = runtimeConfigString(config.uploadMode, "OpenAI-compatible uploadMode");
    if (uploadMode !== undefined && uploadMode !== "openai-json" && uploadMode !== "minimax-multipart") {
      throw new Error("OpenAI-compatible uploadMode must be openai-json or minimax-multipart");
    }
    const videoAdapter = runtimeConfigString(config.videoAdapter, "OpenAI-compatible videoAdapter");
    if (videoAdapter !== undefined && videoAdapter !== "openai-videos" && videoAdapter !== "async-tasks" && videoAdapter !== "minimax-v2") {
      throw new Error("OpenAI-compatible videoAdapter must be openai-videos, async-tasks, or minimax-v2");
    }
    return {
      endpoint: createOpenAiCompatibleProvider({
        instance: context.instance,
        pool: context.pool,
        baseUrl,
        apiKey,
        models,
        routes,
        ...(uploadMode === undefined ? {} : { uploadMode }),
        ...(videoAdapter === undefined ? {} : { videoAdapter }),
        defaultConcurrency: runtimeConfigPositiveInteger(config.defaultConcurrency, "OpenAI-compatible defaultConcurrency"),
        pollIntervalMs: runtimeConfigPositiveInteger(config.pollIntervalMs, "OpenAI-compatible pollIntervalMs"),
        operationTimeoutMs: runtimeConfigPositiveInteger(config.operationTimeoutMs, "OpenAI-compatible operationTimeoutMs"),
        requestTimeoutMs: runtimeConfigPositiveInteger(config.requestTimeoutMs, "OpenAI-compatible requestTimeoutMs"),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.node-package@1" as const,
  hostFacets: [adapter],
};

export default hypitPackage;
