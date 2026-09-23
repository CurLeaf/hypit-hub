import { chatCompletion, extractJsonObject, loadChatGateway } from "./llm.js";
import {
  buildTierListSpokenScriptGuide,
  resolveTierListMode,
  validateSpokenScriptTierLabels,
} from "./tier-list-mode.js";
import { normalizeProductReferences } from "./product-reference.js";
import type { ScenePlan } from "./scene-plan.js";
import type { AnalysisSessionView, BriefView, TreatmentView, ViralInsightView } from "./shared.js";

export async function adaptScenesForProduct(input: {
  readonly session: AnalysisSessionView;
  readonly insight: ViralInsightView;
  readonly treatment?: TreatmentView;
  readonly brief?: BriefView;
  readonly scenes: readonly ScenePlan[];
  readonly goal?: string;
  readonly targetDurationSeconds?: number;
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
  const targetDurationSeconds = input.targetDurationSeconds;
  const referenceDurationSeconds = input.session.probe?.duration;

  const { paths: productReferencePaths, names: productReferenceNames } = normalizeProductReferences(input.session);
  const useTierListRanking = resolveTierListMode({
    insight: input.insight,
    ...(input.treatment === undefined ? {} : { treatment: input.treatment }),
    ...(input.brief === undefined ? {} : { brief: input.brief }),
    adaptationGoal: input.goal ?? input.session.adaptationGoal,
    scenes: input.scenes.map((scene) => ({ text: scene.text, scenePromptHint: scene.prompt })),
  });
  const tierListRankingGuide = useTierListRanking
    ? buildTierListSpokenScriptGuide(productReferenceNames)
    : undefined;

  try {
    const content = await chatCompletion({
      gateway,
      imagePaths: productReferencePaths,
      system: [
        "你是短视频口播编剧，遵循 Hypit 官方 transformations.md / brief.md 的「忠实改编」原则。",
        "用户要用自己的参考图复刻爆款参考片的结构与传播逻辑，需要改写各段口播文案。",
        "",
        "必须做到：",
        "- 保留参考片的叙事段落、Hook 时机、节奏与每段的语义功能（开场钩子、痛点、演示、收束等）",
        "- 结合用户上传的产品参考图（若有）识别品类与可见卖点，口播内容改为新产品/新主体",
        "- 不要照搬原片品牌名、产品名与具体话术；不要机械换词，卖点须可被镜头验证",
        "- 参照 Treatment 与 insight（whyViral / replicationTips）保留传播手法（悬念、对比、情绪递进等）",
        ...(tierListRankingGuide === undefined
          ? []
          : [
            "- 当输入包含 tierListRankingGuide 时，这是排行榜类复刻：口播必须为每款产品明确念出等级词，并与左侧排行榜 UI 同步",
            "- tierListRankingGuide 中的等级词必须原样写入口播正文，不要只用「推荐/不推荐」替代",
          ]),
        "- originalScenes.text 来自参考片语音识别，可能有繁体、错字或截断，仅供理解段落职能，禁止照搬",
        "- 每段 text 为简体中文口播正文，适合竖屏短视频口播",
        "- 键名必须与输入 originalScenes 的 id 完全一致",
        ...(targetDurationSeconds === undefined
          ? []
          : [
            "",
            `目标成片口播总时长约 ${targetDurationSeconds} 秒：各段 text 合计朗读时长应接近该目标（可浮动 ±10%）。`,
            "若目标时长与参考片不同，按目标时长扩写或压缩口播，仍保留参考片的叙事结构与节奏手法。",
            "生成后会被拆分为多个 ≤15 秒的 H3 分镜，最后一段可为不足 15 秒的剩余时长。",
          ]),
        "",
        "输出严格 JSON 对象：键为各段落 id，值为该段完整口播正文（字符串）。",
      ].join("\n"),
      user: JSON.stringify({
        adaptationGoal: productHint,
        ...(targetDurationSeconds === undefined ? {} : { targetDurationSeconds }),
        ...(referenceDurationSeconds === undefined ? {} : { referenceDurationSeconds }),
        productReference: productReferenceNames.length > 0
          ? productReferenceNames.join("、")
          : "用户上传的参考图",
        insight: {
          summary: input.insight.summary,
          hookAnalysis: input.insight.hookAnalysis,
          whyViral: input.insight.whyViral,
          howItWorks: input.insight.howItWorks,
          replicationTips: input.insight.replicationTips,
        },
        brief: input.brief?.markdown?.slice(0, 2500),
        treatment: input.treatment?.markdown?.slice(0, 2000),
        ...(tierListRankingGuide === undefined ? {} : { tierListRankingGuide }),
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
    if (input.requireSuccess === true && useTierListRanking) {
      const tierIssues = validateSpokenScriptTierLabels(...adapted.map((scene) => scene.text));
      if (tierIssues.length > 0) {
        throw new Error(tierIssues[0]!);
      }
    }
    return adapted;
  } catch (error) {
    if (input.requireSuccess === true) throw error;
    return input.scenes;
  }
}
