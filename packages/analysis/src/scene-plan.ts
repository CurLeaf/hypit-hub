import type { AnalysisSessionView, TreatmentView, ViralInsightView } from "./shared.js";
import { chatCompletion, loadChatGateway } from "./llm.js";

export type ScenePlan = {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly momentId: string;
  readonly prompt: string;
};

export function wordsInRange(session: AnalysisSessionView, start: number, end: number): string {
  const words = session.transcript?.words ?? [];
  return words
    .filter((word) => {
      const wordStart = word.start ?? 0;
      const wordEnd = word.end ?? wordStart;
      return wordStart < end && wordEnd > start;
    })
    .map((word) => word.text)
    .join("");
}

export function buildScenes(
  session: AnalysisSessionView,
  insight: ViralInsightView,
  promptByScene?: ReadonlyMap<string, string>,
): readonly ScenePlan[] {
  const duration = session.probe?.duration ?? 15;
  const cuts = [...(session.boundaries ?? [])].sort((left, right) => left.at - right.at).map((item) => item.at);
  const edges = [0, ...cuts, duration];
  const scenes: ScenePlan[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const text = wordsInRange(session, start, end);
    const momentId = `scene-${index + 1}`;
    const defaultPrompt = [
      "Vertical 9:16 short-form social video frame, cinematic lighting, clean composition.",
      "Chinese product promo scene " + (index + 1) + ".",
      "Theme: " + (text.slice(0, 120) || insight.summary),
      insight.hookAnalysis,
      "No readable text in image.",
    ].join(" ");
    scenes.push({
      id: momentId,
      start,
      end,
      text,
      momentId,
      prompt: promptByScene?.get(momentId) ?? defaultPrompt,
    });
  }
  return scenes;
}

export function scriptDialogue(scenes: readonly ScenePlan[]): string {
  const parts: string[] = [];
  for (const [index, scene] of scenes.entries()) {
    const words = scene.text.replace(/\s+/gu, "");
    if (words.length === 0) continue;
    const chunks: string[] = [];
    for (let offset = 0; offset < words.length; offset += 6) {
      chunks.push(words.slice(offset, offset + 6));
    }
    let body = chunks.join(" || ");
    if (index > 0) {
      body = "@" + scene.momentId + " " + body + " @/" + scene.momentId;
    }
    parts.push(body);
  }
  return parts.join(" || ").trim();
}

export async function buildScenePrompts(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly formatId: string;
  readonly runtimePath?: string;
  readonly scenes: readonly ScenePlan[];
  readonly requireSuccess?: boolean;
}): Promise<Map<string, string>> {
  const gateway = await loadChatGateway(input.runtimePath, input.session.workspaceRoot);
  const result = new Map<string, string>();
  if (gateway === undefined) {
    if (input.requireSuccess === true) {
      throw new Error("缺少对话模型配置，无法生成官方 gpt-image 场景 prompt");
    }
    return result;
  }
  const sceneIds = input.scenes.map((scene) => scene.momentId);
  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "你是视频美术指导。根据参考片分析与导演 Treatment，为每个场景写 gpt-image 英文 prompt。",
        "输出严格 JSON 对象：键必须与输入 scenes 的 id 完全一致（" + sceneIds.join("、") + "），值为 prompt 字符串。",
        "要求：竖屏 9:16、无可读文字、具体视觉锚点、符合 " + input.formatId + " 格式气质。",
      ].join("\n"),
      user: JSON.stringify({
        formatId: input.formatId,
        insight: input.insight.summary,
        hook: input.insight.hookAnalysis,
        treatment: input.treatment?.markdown?.slice(0, 2000),
        scenes: input.scenes.map((scene) => ({
          id: scene.momentId,
          time: scene.start + "s-" + scene.end + "s",
          dialogue: scene.text.slice(0, 80),
        })),
      }, null, 2),
    });
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) {
      if (input.requireSuccess === true) throw new Error("场景 prompt 模型未返回有效 JSON");
      return result;
    }
    const parsed = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
    for (const scene of input.scenes) {
      const value = parsed[scene.momentId];
      if (typeof value === "string" && value.trim().length > 0) {
        result.set(scene.momentId, value.trim());
      }
    }
    if (input.requireSuccess === true) {
      const missing = input.scenes.filter((scene) => !result.has(scene.momentId));
      if (missing.length > 0) {
        throw new Error("场景 prompt 生成不完整：缺少 " + missing.map((scene) => scene.momentId).join("、"));
      }
      for (const scene of input.scenes) {
        const prompt = result.get(scene.momentId);
        if (prompt !== undefined && isDefaultScenePrompt(prompt)) {
          throw new Error(`场景 ${scene.momentId} 仍使用默认 prompt，请检查对话模型输出`);
        }
      }
    }
  } catch (error) {
    if (input.requireSuccess === true) throw error;
  }
  return result;
}

function isDefaultScenePrompt(prompt: string): boolean {
  return prompt.includes("Chinese product promo scene")
    || prompt.startsWith("Vertical 9:16 short-form social video frame, cinematic lighting, clean composition.");
}
