import { chatCompletion, extractJsonObject, loadChatGateway } from "./llm.js";
import type { ScenePlan } from "./scene-plan.js";
import type { AnalysisSessionView, BriefView, TreatmentView, ViralInsightView } from "./shared.js";

export async function adaptScenesForProduct(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly brief?: BriefView;
  readonly scenes: readonly ScenePlan[];
  readonly goal?: string;
  readonly runtimePath?: string;
  readonly requireSuccess?: boolean;
}): Promise<readonly ScenePlan[]> {
  if (input.scenes.length === 0) return input.scenes;
  const gateway = await loadChatGateway(input.runtimePath, input.session.workspaceRoot);
  if (gateway === undefined) {
    if (input.requireSuccess === true) {
      throw new Error("缺少对话模型配置（OPENAI_API_KEY / HYPIT_CHAT_MODEL），无法按 Brief 改写口播");
    }
    return input.scenes;
  }

  const productHint = input.goal?.trim()
    || input.brief?.markdown?.match(/## 目标[\s\S]*?(?=\n## |\n*$)/u)?.[0]?.trim()
    || "用户已上传新产品/人物参考图，请为该产品撰写口播，具体卖点可从 Brief 与洞察推断。";

  try {
    const content = await chatCompletion({
      gateway,
      system: [
        "你是短视频口播编剧，遵循 Hypit 官方 transformations.md / brief.md 的「忠实改编」原则。",
        "用户要用自己的参考图复刻爆款参考片的结构与传播逻辑，需要改写各段口播文案。",
        "",
        "必须做到：",
        "- 保留参考片的叙事段落、Hook 时机、节奏与每段的语义功能（开场钩子、痛点、演示、收束等）",
        "- 口播内容改为用户 Brief 中的新产品/新主体，不要照搬原片品牌名、产品名与具体话术",
        "- 参照 Treatment 与洞察保留传播手法（悬念、对比、情绪递进等）",
        "- 每段 text 为中文口播正文，长度与原段相近，适合竖屏短视频口播",
        "- 键名必须与输入 originalScenes 的 id 完全一致",
        "",
        "输出严格 JSON 对象：键为各段落 id，值为该段完整口播正文（字符串）。",
      ].join("\n"),
      user: JSON.stringify({
        adaptationGoal: productHint,
        productReference: input.session.productReferenceName ?? "用户上传的参考图",
        insight: {
          summary: input.insight.summary,
          hookAnalysis: input.insight.hookAnalysis,
          whyViral: input.insight.whyViral,
        },
        brief: input.brief?.markdown?.slice(0, 2500),
        treatment: input.treatment?.markdown?.slice(0, 2000),
        speechSegments: input.session.segments?.map((segment) => ({
          id: segment.id,
          label: segment.label,
          time: `${segment.start}s-${segment.end}s`,
          text: segment.text.slice(0, 200),
        })),
        originalScenes: input.scenes.map((scene) => ({
          id: scene.momentId,
          time: `${scene.start}s-${scene.end}s`,
          text: scene.text,
        })),
      }, null, 2),
    });
    const parsed = extractJsonObject(content);
    const adapted = input.scenes.map((scene) => {
      const value = parsed[scene.momentId];
      if (typeof value === "string" && value.trim().length > 0) {
        return { ...scene, text: value.trim() };
      }
      return scene;
    });
    const changed = adapted.some((scene, index) => scene.text !== input.scenes[index]?.text);
    if (input.requireSuccess === true && !changed) {
      throw new Error("口播改写未生效：请在「改编说明」中填写产品名称与核心卖点后重试");
    }
    return adapted;
  } catch (error) {
    if (input.requireSuccess === true) throw error;
    return input.scenes;
  }
}
