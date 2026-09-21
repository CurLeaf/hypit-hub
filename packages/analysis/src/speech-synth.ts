import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { loadChatGateway } from "./llm.js";

export type SpeechMode = "reference" | "tts";

export async function resolveSpeechAudio(input: {
  readonly mode: SpeechMode;
  readonly session: { readonly videoPath?: string; readonly transcript?: { readonly passages?: readonly { readonly text: string }[] }; readonly workspaceRoot: string };
  readonly destination: string;
  readonly runtimePath?: string;
  readonly scriptText?: string;
  readonly extractReferenceAudio: (videoPath: string, destination: string) => Promise<void>;
}): Promise<{ readonly path: string; readonly mode: SpeechMode }> {
  await mkdir(dirname(input.destination), { recursive: true });
  if (input.mode === "reference") {
    if (input.session.videoPath === undefined) throw new Error("缺少参考视频，无法提取口播");
    await input.extractReferenceAudio(input.session.videoPath, input.destination);
    return { path: input.destination, mode: "reference" };
  }
  const text = input.scriptText?.replace(/\s+/gu, " ").trim()
    ?? input.session.transcript?.passages?.map((passage) => passage.text).join(" ").replace(/\s+/gu, " ").trim();
  if (text === undefined || text.length === 0) throw new Error("缺少口播文本，无法 TTS 合成");
  await synthesizeOpenAiSpeech({
    text,
    destination: input.destination,
    ...(input.runtimePath === undefined ? {} : { runtimePath: input.runtimePath }),
    workspaceRoot: input.session.workspaceRoot,
  });
  return { path: input.destination, mode: "tts" };
}

async function synthesizeOpenAiSpeech(input: {
  readonly text: string;
  readonly destination: string;
  readonly runtimePath?: string;
  readonly workspaceRoot: string;
}): Promise<void> {
  const gateway = await loadChatGateway(input.runtimePath, input.workspaceRoot);
  if (gateway === undefined) throw new Error("缺少 Runtime 网关配置，无法 TTS");
  const secret = process.env[gateway.apiKeyEnv]?.trim();
  if (secret === undefined || secret.length === 0) throw new Error("缺少 " + gateway.apiKeyEnv + "，无法 TTS");
  const base = gateway.baseUrl.replace(/\/+$/u, "");
  const model = gateway.ttsModel;
  const voice = gateway.ttsVoice;
  const response = await fetch(base + "/audio/speech", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      voice,
      input: input.text.slice(0, 4096),
      response_format: "wav",
    }),
    signal: AbortSignal.timeout(gateway.requestTimeoutMs),
  });
  if (!response.ok) {
    let detail = await response.text();
    if (/model_not_found|No available channel for model/iu.test(detail)) {
      detail = `TTS 模型「${model}」在网关中不可用。请在 .env 设置 HYPIT_TTS_MODEL / HYPIT_TTS_VOICE（如 CosyVoice2），或在 hypit.runtime.json 的 gateway.default.ttsModel 中配置。原始响应：${detail.slice(0, 300)}`;
    } else if (detail.length > 300) {
      detail = detail.slice(0, 300);
    }
    throw new Error("TTS 返回 HTTP " + response.status + (detail.length > 0 ? ": " + detail : ""));
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(input.destination, bytes);
}
