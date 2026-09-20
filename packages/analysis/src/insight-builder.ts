import type { AnalysisSessionView, FormatSuggestionView, ViralInsightView } from "./shared.js";
import { formatTime } from "./shared.js";
import { joinTranscriptText, normalizeTranscriptText, transcriptSnippetAt, wordsInRange } from "./transcript-text.js";

type ContentProfile = {
  readonly label: string;
  readonly audience: string;
  readonly tone: string;
};

function primaryFormat(session: AnalysisSessionView): FormatSuggestionView | undefined {
  const formats = session.formats ?? [];
  const rank = { high: 0, medium: 1, low: 2 } as const;
  return [...formats].sort((left, right) => rank[left.confidence] - rank[right.confidence])[0];
}

function fullScript(session: AnalysisSessionView): string {
  const words = session.transcript?.words ?? [];
  if (words.length > 0) return joinTranscriptText(words);
  const passage = session.transcript?.passages?.[0]?.text ?? "";
  return normalizeTranscriptText(passage);
}

function hookScript(session: AnalysisSessionView): string {
  const words = session.transcript?.words ?? [];
  const hookEnd = Math.min(5, session.probe?.duration ?? 5);
  const hookWords = wordsInRange(words, 0, hookEnd);
  if (hookWords.length > 0) return joinTranscriptText(hookWords);
  const event = session.events?.find((item) => item.kind === "hook");
  return event === undefined ? "" : normalizeTranscriptText(event.detail);
}

function hasPainPointRelief(script: string): boolean {
  return /不满意|改到满意|一直改|反复改|免费试用|先试/u.test(script);
}

function isProductLaunch(script: string): boolean {
  return /重磅|发布|新品|升级版?|v\d|(?:\d+\.?\d*)(?:版|代)?/iu.test(script);
}

function inferContentProfile(script: string, format: FormatSuggestionView | undefined): ContentProfile {
  if (isProductLaunch(script)) {
    return {
      label: "产品发布 / 功能宣传片",
      audience: "需要快速了解新工具或新功能的商家、运营和创作者",
      tone: "事件感开场 + 口语化卖点 + 品牌收束",
    };
  }
  if (/排行|榜单|第.{0,2}名|级别|tier|rank/iu.test(script)) {
    return {
      label: "榜单 / 排名类内容",
      audience: "爱看对比、排名和结论的信息流用户",
      tone: "悬念开场 + 逐级揭晓 + 记忆点排名",
    };
  }
  if (/采访|你觉得|为什么|问答/u.test(script)) {
    return {
      label: "采访 / 街访类",
      audience: "偏好真实反应和对话感的用户",
      tone: "提问 Hook + 多段回答 + 观点碰撞",
    };
  }
  if (format?.id === "explainer") {
    return {
      label: format.title,
      audience: "有明确问题待解决、希望快速搞懂的用户",
      tone: "问题 Hook + 分步论证 + 行动号召",
    };
  }
  return {
    label: format?.title ?? "竖屏口播短片",
    audience: "信息流里快速刷视频的泛用户",
    tone: "强开场 + 密集信息 + 短时长收束",
  };
}

function pacingNote(duration: number, wordCount: number): string {
  if (wordCount === 0) return "本片以画面变化为主驱动注意力。";
  const wordsPerSecond = wordCount / Math.max(duration, 0.1);
  if (wordsPerSecond >= 4.5) return "口播偏快、信息点密集，适合强刺激的信息流投放。";
  if (wordsPerSecond >= 3) return "口播节奏紧凑但不拥挤，能在短时间内交代清楚核心卖点。";
  return "口播留白较多，更依赖画面和字幕承载信息。";
}

function openingStrength(hook: string): string {
  if (hook.length === 0) return "开场依赖画面冲击或悬念标题，需在 3 秒内建立视觉锚点。";
  const signals: string[] = [];
  if (/重磅|首发|发布|新品|升级/u.test(hook)) signals.push("用「发布/重磅」制造事件感");
  if (/动动口|张口|一键|直接|秒/u.test(hook)) signals.push("用口语化动词降低理解成本");
  if (/视频|商品|图|AI|工具/u.test(hook)) signals.push("早早点明内容形态或使用场景");
  if (hook.length <= 28) signals.push("开场句短，适合竖屏快速阅读");
  if (signals.length === 0) signals.push("开场直接切入主题，减少铺垫");
  return signals.join("；") + "。";
}

function momentNarrative(session: AnalysisSessionView, at: number, index: number): string {
  const words = session.transcript?.words ?? [];
  const snippet = transcriptSnippetAt(words, at);
  const time = formatTime(at);
  const lines = [`第 ${index + 1} 个高潮点在 ${time}：`];
  if (snippet.length > 0) {
    lines.push(`此时口播落在「${snippet.slice(0, 36)}${snippet.length > 36 ? "…" : ""}」，画面切换用于强化这句信息。`);
  } else {
    lines.push("此处画面变化最强，适合放揭晓、转场、产品特写或情绪转折。");
  }
  return lines.join("\n");
}

function narrativeStructure(session: AnalysisSessionView, script: string): string {
  const segments = session.segments ?? [];
  if (segments.length === 0) {
    return script.length > 0
      ? `全片一条口播线贯穿：${script.slice(0, 80)}${script.length > 80 ? "…" : ""}`
      : "全片以画面递进为主，需结合时间线证据理解各段功能。";
  }
  return segments.map((segment) => {
    const text = normalizeTranscriptText(segment.text);
    const cuts = (session.boundaries ?? []).filter((boundary) => boundary.at >= segment.start && boundary.at <= segment.end);
    const cutNote = cuts.length > 0
      ? `（${formatTime(segment.start)}–${formatTime(segment.end)} 内有 ${cuts.length} 处画面变化）`
      : `（${formatTime(segment.start)}–${formatTime(segment.end)}）`;
    return `${segment.label}${cutNote}：${text.slice(0, 72)}${text.length > 72 ? "…" : ""}`;
  }).join("\n");
}

function buildSummary(session: AnalysisSessionView, profile: ContentProfile): string {
  const vertical = (session.probe?.height ?? 0) > (session.probe?.width ?? 0);
  const orientation = vertical ? "竖屏" : "横屏";
  const duration = session.probe?.duration ?? 0;
  const hook = hookScript(session);
  const hookLead = hook.length > 0 ? `开场以「${hook.slice(0, 24)}${hook.length > 24 ? "…" : ""}」抓住注意力，` : "";
  return [
    `这是一条 ${orientation} ${duration.toFixed(1)} 秒的${profile.label}。`,
    `${hookLead}通过口播与 ${session.boundaries?.length ?? 0} 次画面变化配合，在信息流场景里快速讲清价值。`,
    `目标受众：${profile.audience}。`,
  ].join("");
}

function buildWhyViral(session: AnalysisSessionView, script: string, profile: ContentProfile): ViralInsightView["whyViral"] {
  const hook = hookScript(session);
  const duration = session.probe?.duration ?? 0;
  const wordCount = session.transcript?.words?.length ?? 0;
  const core: { title: string; detail: string }[] = [
    {
      title: "开场 Hook 有效",
      detail: hook.length > 0
        ? `前 5 秒口播：「${hook}」。${openingStrength(hook)}`
        : openingStrength(""),
    },
    {
      title: "卖点表达清晰",
      detail: script.length > 0
        ? `全片围绕「${script.slice(0, 28)}${script.length > 28 ? "…" : ""}」展开，信息递进明确，观众不用看完全片就能感知这条片在讲什么。`
        : "画面与字幕承担了主要信息传递，适合静音刷视频的场景。",
    },
    {
      title: "节奏适合信息流",
      detail: `${pacingNote(duration, wordCount)} 全片约 ${duration.toFixed(1)} 秒，符合短视频「刷到即懂」的消费习惯。`,
    },
  ];
  const optional: { title: string; detail: string }[] = [];
  if (hasPainPointRelief(script)) {
    optional.push({
      title: "提前化解使用顾虑",
      detail: "片中出现「不满意可继续改」类表达，能降低观众对工具/产品试错成本的担心，有利于转化。",
    });
  }
  if ((session.boundaries?.length ?? 0) >= 2) {
    optional.push({
      title: "画面切换推动信息递进",
      detail: `全片 ${session.boundaries!.length} 处画面变化并非随机切镜，而是配合口播段落推进，帮助观众分段吸收信息。`,
    });
  }
  if (profile.label.includes("产品")) {
    optional.push({
      title: "品牌记忆点明确",
      detail: `${profile.tone}。结尾 Slogan 与开场产品名呼应，有利于观众记住品牌与核心能力。`,
    });
  }
  return [...core, ...optional].slice(0, 4);
}

function buildHowItWorks(session: AnalysisSessionView, format: FormatSuggestionView | undefined): ViralInsightView["howItWorks"] {
  const script = fullScript(session);
  const moments = [...(session.events ?? []).filter((event) => event.kind === "moment")]
    .sort((left, right) => left.at - right.at);
  const formatLine = format === undefined
    ? "竖屏口播 / 产品讲解"
    : `${format.title}（${format.confidence}）— ${format.reason}`;
  return [
    {
      title: "叙事结构",
      detail: narrativeStructure(session, script),
    },
    {
      title: "高潮点与切镜",
      detail: moments.length > 0
        ? moments.map((moment, index) => momentNarrative(session, moment.at, index)).join("\n")
        : "未检测到强切镜点；建议在全片 1/3 与 2/3 处安排一次画面变化以维持注意力。",
    },
    {
      title: "推荐复刻格式",
      detail: formatLine,
    },
  ];
}

function buildHookAnalysis(session: AnalysisSessionView): string {
  const hook = hookScript(session);
  if (hook.length === 0) {
    return "开场需在 3 秒内同时给出「主题 + 收益 + 视觉锚点」。可用大字标题、强对比画面或悬念问句降低划走率。";
  }
  const parts: string[] = [`开场口播：「${hook}」。`];
  if (/发布|重磅|新品/u.test(hook)) parts.push("用发布感建立「值得停下来看」的事件预期。");
  if (/动动口|张口|说/u.test(hook)) parts.push("把复杂能力翻译成「动嘴就能完成」的具体动作，降低认知门槛。");
  if (/视频|商品|图/u.test(hook)) parts.push("同时点出「视频 + 商品图」等高频场景，扩大受众覆盖面。");
  const cuts = (session.boundaries ?? []).filter((boundary) => boundary.at <= 5);
  if (cuts.length > 0) {
    parts.push(`前 5 秒内有 ${cuts.length} 次画面变化（${cuts.map((cut) => formatTime(cut.at)).join("、")}），与口播同步强化记忆。`);
  }
  return parts.join("");
}

function buildReplicationTips(session: AnalysisSessionView, profile: ContentProfile): string[] {
  const vertical = (session.probe?.height ?? 0) > (session.probe?.width ?? 0);
  const moments = (session.events ?? []).filter((event) => event.kind === "moment");
  const tips = [
    `保留「${profile.tone}」的骨架，替换人物/IP、产品与具体台词即可复用。`,
    moments.length > 0
      ? `在 ${moments.map((moment) => formatTime(moment.at)).join("、")} 等画面变化最强处放置核心卖点或 CTA。`
      : "把每次切镜绑在一个新信息点上，避免同一句口播内频繁闪切。",
    vertical
      ? "竖屏大字标题 + 底部字幕双轨呈现，适配静音观看。"
      : "横屏片需在画面上独立呈现关键信息，避免只靠口播。",
  ];
  const script = fullScript(session);
  if (hasPainPointRelief(script)) {
    tips.push("保留一句「消除顾虑」的表达（如可反复修改、免费试用），比单纯炫功能更能促转化。");
  } else {
    tips.push(`时长控制在 ${Math.max(12, Math.round((session.probe?.duration ?? 15) - 2))}–${Math.round((session.probe?.duration ?? 15) + 3)} 秒附近，与参考片节奏对齐。`);
  }
  return tips;
}

export function buildInsightMarkdown(insight: ViralInsightView, videoName?: string): string {
  const header = videoName === undefined ? "# 爆款解读" : `# 爆款解读 · ${videoName}`;
  return [
    header,
    "",
    insight.summary,
    "",
    "## 为什么火",
    "",
    ...insight.whyViral.map((item) => `### ${item.title}\n\n${item.detail}`),
    "",
    "## 怎么火的",
    "",
    ...insight.howItWorks.map((item) => `### ${item.title}\n\n${item.detail}`),
    "",
    "## Hook 分析",
    "",
    insight.hookAnalysis,
    "",
    "## 复刻建议",
    "",
    ...insight.replicationTips.map((tip) => `- ${tip}`),
    "",
  ].join("\n");
}

export function buildInsightFromSession(session: AnalysisSessionView): ViralInsightView {
  const script = fullScript(session);
  const format = primaryFormat(session);
  const profile = inferContentProfile(script, format);
  return {
    summary: buildSummary(session, profile),
    whyViral: buildWhyViral(session, script, profile),
    howItWorks: buildHowItWorks(session, format),
    hookAnalysis: buildHookAnalysis(session),
    replicationTips: buildReplicationTips(session, profile),
  };
}

export function analysisContextForLlm(session: AnalysisSessionView): string {
  const script = fullScript(session);
  const hook = hookScript(session);
  const moments = (session.events ?? []).filter((event) => event.kind === "moment").map((event) => ({
    at: formatTime(event.at),
    narration: transcriptSnippetAt(session.transcript?.words ?? [], event.at),
    detail: event.detail,
  }));
  return JSON.stringify({
    video: session.videoName,
    probe: session.probe,
    fullScript: script,
    hookScript: hook,
    segments: (session.segments ?? []).map((segment) => ({
      label: segment.label,
      start: formatTime(segment.start),
      end: formatTime(segment.end),
      text: normalizeTranscriptText(segment.text),
    })),
    visualCuts: (session.boundaries ?? []).map((boundary) => ({
      at: formatTime(boundary.at),
      score: boundary.score,
      narration: transcriptSnippetAt(session.transcript?.words ?? [], boundary.at),
    })),
    moments,
    formats: session.formats,
  }, null, 2);
}
