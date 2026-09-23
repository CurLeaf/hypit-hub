import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import { resolveGatewayText } from "./runtime-text.js";

export type ChatGatewayConfig = {
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly model: string;
  readonly ttsModel: string;
  readonly ttsVoice: string;
  readonly requestTimeoutMs: number;
};

export function chatGatewayFromConfig(
  gateway: Record<string, unknown>,
  env: NodeJS.Dict<string> = process.env,
): ChatGatewayConfig | undefined {
  const baseUrl = resolveGatewayText(gateway.baseUrl, env);
  const apiKey = gateway.apiKey as { key?: string } | undefined;
  const apiKeyEnv = apiKey?.key?.trim() || "OPENAI_API_KEY";
  if (baseUrl === undefined) return undefined;
  const model = env.HYPIT_CHAT_MODEL?.trim()
    || (typeof gateway.chatModel === "string" ? gateway.chatModel : undefined)
    || "deepseek-v4-flash";
  const ttsModel = env.HYPIT_TTS_MODEL?.trim()
    || (typeof gateway.ttsModel === "string" ? gateway.ttsModel : undefined)
    || "FunAudioLLM/CosyVoice2-0.5B";
  const ttsVoice = env.HYPIT_TTS_VOICE?.trim()
    || (typeof gateway.ttsVoice === "string" ? gateway.ttsVoice : undefined)
    || "FunAudioLLM/CosyVoice2-0.5B:alex";
  const requestTimeoutMs = typeof gateway.requestTimeoutMs === "number" ? gateway.requestTimeoutMs : 120_000;
  return { baseUrl, apiKeyEnv, model, ttsModel, ttsVoice, requestTimeoutMs };
}

export async function loadChatGateway(
  runtimePath: string | undefined,
  workspaceRoot: string,
  env: NodeJS.Dict<string> = process.env,
): Promise<ChatGatewayConfig | undefined> {
  if (runtimePath === undefined) return undefined;
  try {
    const raw = JSON.parse(await readFile(resolve(runtimePath), "utf8")) as {
      endpoints?: Record<string, { config?: Record<string, unknown> }>;
    };
    const gateway = raw.endpoints?.["gateway.default"]?.config;
    if (gateway === undefined) return undefined;
    return chatGatewayFromConfig(gateway, env);
  } catch {
    return undefined;
  }
}

function imageMediaType(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".avif") return "image/avif";
  return "image/jpeg";
}

async function imageDataUrl(path: string): Promise<string> {
  const bytes = await readFile(path);
  return `data:${imageMediaType(path)};base64,${bytes.toString("base64")}`;
}

export async function chatCompletion(input: {
  readonly gateway: ChatGatewayConfig;
  readonly system: string;
  readonly user: string;
  readonly imagePath?: string;
  readonly imagePaths?: readonly string[];
}): Promise<string> {
  const secret = process.env[input.gateway.apiKeyEnv]?.trim();
  if (secret === undefined || secret.length === 0) {
    throw new Error(`缺少 ${input.gateway.apiKeyEnv}，无法调用对话模型`);
  }
  const base = input.gateway.baseUrl.replace(/\/+$/u, "");
  const imagePaths = input.imagePaths ?? (input.imagePath === undefined ? [] : [input.imagePath]);
  const userContent = imagePaths.length === 0
    ? input.user
    : [
      { type: "text", text: input.user },
      ...await Promise.all(imagePaths.map(async (path) => ({
        type: "image_url" as const,
        image_url: { url: await imageDataUrl(path) },
      }))),
    ];
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: input.gateway.model,
      temperature: 0.4,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: userContent },
      ],
    }),
    signal: AbortSignal.timeout(input.gateway.requestTimeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text.length === 0 ? "" : text.slice(0, 400);
    if (/model_not_found|No available channel for model/iu.test(detail)) {
      detail = `模型「${input.gateway.model}」在网关中不可用。请在 .env 设置 HYPIT_CHAT_MODEL 为网关支持的模型 ID（如 deepseek-v4-flash），或在 hypit.runtime.json 的 gateway.default.chatModel 中配置。原始响应：${detail}`;
    }
    throw new Error(`对话模型返回 HTTP ${response.status}${detail.length === 0 ? "" : `: ${detail}`}`);
  }
  const parsed = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  const content = parsed.choices?.[0]?.message?.content?.trim();
  if (content === undefined || content.length === 0) throw new Error("对话模型返回空内容");
  return content;
}

function repairJsonText(text: string): string {
  return text
    .replace(/,\s*([}\]])/gu, "$1")
    .replace(/\u201c|\u201d/gu, "\"")
    .replace(/\u2018|\u2019/gu, "'");
}

export function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("模型未返回有效 JSON");
  const jsonText = repairJsonText(candidate.slice(start, end + 1));
  try {
    const parsed: unknown = JSON.parse(jsonText);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型 JSON 格式无效");
    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`模型返回的 JSON 无法解析（常见于口播/卖点里含未转义引号）：${detail}`);
  }
}
