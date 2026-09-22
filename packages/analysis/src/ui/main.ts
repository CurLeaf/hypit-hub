import {
  type CreateActionPending,
  isBuildActionBusy,
  isReplicateActionBusy,
  officialPathCheckHint,
  resolveCreateActionStatus,
} from "../create-action-status.js";
import type {
  AnalysisConfigView,
  AnalysisSessionView,
  OfficialPathCheckView,
} from "../shared.js";
import { formatTime } from "../shared.js";
import { isCliCheckInvocationError } from "../scaffold-check.js";

type TabId = "overview" | "timeline" | "insight" | "brief" | "transcript" | "create" | "result";

const app = document.querySelector<HTMLElement>("#app")!;
let config: AnalysisConfigView | undefined;
let session: AnalysisSessionView = { workspaceRoot: "." };
let activeTab: TabId = "overview";
let currentTime = 0;
let pollTimer: number | undefined;
let completionNotice: string | undefined;
let completionNoticeDetail: string | undefined;
let completionNoticeIsError = false;
let previewMode: "reference" | "output" = "reference";
// 可选：仅当用户明确要求改编时才填写
let replicateNotes = "";
const speechMode: "tts" = "tts";
let videoAroll = true;
let formatOverride = "";
let defaultVideoLoading = false;
let referenceUploading = false;
let referenceUploadError: string | undefined;
let officialPathChecks: readonly OfficialPathCheckView[] | undefined;
let officialPathReady: boolean | undefined;
let readinessRefreshToken = 0;
let lastReadinessKey = "";
let createActionPending: CreateActionPending | undefined;
let createTabFocus = false;
const adaptedScriptCache = new Map<string, string | undefined>();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload;
}

function mediaUrl(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  return `/__analysis/media?path=${encodeURIComponent(path)}`;
}

function mediaFileName(path: string): string {
  return path.split(/[/\\]/u).pop() ?? "download";
}

function mediaDownloadUrl(path: string): string {
  const params = new URLSearchParams({ path, download: "1" });
  return `/__analysis/media?${params}`;
}

function triggerMediaDownload(path: string): void {
  const link = document.createElement("a");
  link.href = mediaDownloadUrl(path);
  link.download = mediaFileName(path);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render(): void {
  app.replaceChildren();
  const root = el("div", "app");
  root.append(renderTopbar());
  if (completionNotice !== undefined) root.append(renderCompletionBanner());
  root.append(renderLayout());
  app.append(root);
  queueMicrotask(() => focusCreateActionIfNeeded());
}

function setCreateActionPending(kind: CreateActionPending["kind"], phase: string): void {
  createActionPending = { kind, phase };
}

function clearCreateActionPending(): void {
  createActionPending = undefined;
}

function focusCreateActionIfNeeded(): void {
  if (activeTab !== "create") return;
  const anchor = document.querySelector<HTMLElement>(".create-action-bar");
  if (anchor === null) return;
  const shouldFocus = createTabFocus
    || createActionPending !== undefined
    || session.build?.status === "error"
    || session.workflowJob?.status === "error";
  if (!shouldFocus) return;
  anchor.scrollIntoView({ behavior: createTabFocus ? "smooth" : "auto", block: "nearest" });
  if (createTabFocus) {
    anchor.classList.add("create-action-bar-focus");
    window.setTimeout(() => anchor.classList.remove("create-action-bar-focus"), 1200);
    createTabFocus = false;
  }
}

function renderCompletionBanner(): HTMLElement {
  const banner = el("div", completionNoticeIsError ? "completion-banner completion-banner-error" : "completion-banner");
  banner.append(el("p", undefined, completionNotice));
  if (completionNoticeDetail !== undefined && completionNoticeDetail.length > 0) {
    const detail = el("pre", "doc-preview completion-banner-detail", completionNoticeDetail);
    banner.append(detail);
  }
  const actions = el("div", "completion-banner-actions");
  if (completionNoticeIsError) {
    const view = el("button", "btn", "查看详情");
    view.addEventListener("click", () => { activeTab = "create"; render(); });
    actions.append(view);
  } else {
    const hasOutput = session.build?.outputVideoPath !== undefined;
    const view = el("button", "btn", hasOutput ? "查看成片" : "查看配音");
    view.addEventListener("click", () => {
      activeTab = hasOutput ? "result" : "create";
      if (hasOutput) previewMode = "output";
      render();
    });
    actions.append(view);
  }
  const dismiss = el("button", "btn", "知道了");
  dismiss.addEventListener("click", () => {
    completionNotice = undefined;
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    render();
  });
  actions.append(dismiss);
  banner.append(actions);
  return banner;
}

function sessionBuildFailureDetail(session: AnalysisSessionView): string | undefined {
  if (session.build?.error !== undefined && session.build.error.length > 0) return session.build.error;
  if (session.workflowJob?.error !== undefined && session.workflowJob.error.length > 0) return session.workflowJob.error;
  return undefined;
}

function summarizeBuildFailure(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return "未知错误，请查看完整错误信息。";
  const sceneMatch = /component::(scene-\d+)/u.exec(text);
  const sceneHint = sceneMatch === null ? "" : `（场景 ${sceneMatch[1]}）`;
  if (/429|rate limit|RateLimitReached|call rate limit/iu.test(text)) {
    return `图片生成 API 调用频率超限${sceneHint}。请等待约 1 分钟后重试，或将 hypit.runtime.json 中 defaultConcurrency 设为 1。`;
  }
  if (/HTTP 500|unexpected EOF|read_response_body_failed/iu.test(text)) {
    return `图片生成 API 网关异常${sceneHint}。通常是中转服务不稳定或模型不可用，请稍后重试或检查 gateway 配置。`;
  }
  if (/\/videos returned HTTP 404|path":"\/api\/minimax\/videos"/iu.test(text)) {
    return "视频接口 404：请求打到了网关不存在的 POST /videos。MiniMax H3 应走 V2 `/v2/video_generation`。这不是图片模型映射问题。";
  }
  if (/\/files\b.*404|\/api\/minimax\/files/iu.test(text)) {
    return `MiniMax 网关不支持文件上传（/files 404）${sceneHint}。参考素材应走 S3 公有 OSS（gateway.minimax.referenceUpload=s3）。`;
  }
  if (/HTTP 404|not found for API|NOT_FOUND/iu.test(text)) {
    return `图片模型未找到或网关不支持该模型${sceneHint}。请检查 hypit.runtime.json 的 models 映射与 baseUrl。`;
  }
  if (/401|403|invalid.*api.*key|authentication/iu.test(text)) {
    return `API 密钥无效或未配置${sceneHint}。请检查 .env 中的 OPENAI_API_KEY 是否已加载。`;
  }
  if (/RUNTIME_CREDENTIAL_MISSING|未配置 OPENAI_API_KEY|credential.*missing/iu.test(text)) {
    return `未加载 API 密钥${sceneHint}。请在项目目录配置 .env 后重启 hypit analysis，或先运行 load-env.ps1。`;
  }
  if (/未返回 build id/iu.test(text)) {
    return `Build 未能提交${sceneHint}。通常是 Runtime 未启动或未加载 .env，请运行 runtime up 并重启 analysis。`;
  }
  if (/ECONNREFUSED|fetch failed|无法连接/iu.test(text)) {
    return `无法连接 Runtime 或网关${sceneHint}。请先运行 hypit runtime up。`;
  }
  if (/cannot resolve product-reference/iu.test(text)) {
    return "参考图引用无法解析。本地 asset:Image 发布的是 product-reference，不是 product-reference.image。";
  }
  if (/场景 prompt 生成不完整/u.test(text)) {
    return "场景画面提示词生成不完整。通常是模型把段落键写成 scene-1，而工程需要 segment-1。请再试一次一键复刻。";
  }
  if (sceneMatch !== null) return `生成场景图 ${sceneMatch[1]} 失败，请查看下方完整错误。`;
  return "视频生成失败，请查看下方完整错误信息。";
}

function renderFailureCard(summary: string, detail: string): HTMLElement {
  const card = el("div", "card failure-card");
  card.append(el("h4", undefined, "生成失败"));
  card.append(el("p", "failure-summary", summary));
  card.append(el("pre", "doc-preview failure-detail", detail));
  return card;
}

function clearCompletionNotice(): void {
  completionNotice = undefined;
  completionNoticeDetail = undefined;
  completionNoticeIsError = false;
}

function showBuildFailure(detail: string): void {
  completionNotice = summarizeBuildFailure(detail);
  completionNoticeDetail = detail;
  completionNoticeIsError = true;
  activeTab = "create";
}

function analysisSummary(session: AnalysisSessionView): string {
  const words = session.transcript?.words?.length ?? 0;
  const events = session.events?.length ?? 0;
  const cuts = session.boundaries?.length ?? 0;
  return [words > 0 ? `${words} 个词` : undefined, events > 0 ? `${events} 个结构事件` : undefined, cuts > 0 ? `${cuts} 处画面变化` : undefined]
    .filter(Boolean).join("、") || "报告已导出";
}

function sessionFingerprint(value: AnalysisSessionView): string {
  return JSON.stringify(value);
}

function isSessionBusy(value: AnalysisSessionView): boolean {
  return value.job?.status === "running"
    || value.workflowJob?.status === "running"
    || value.build?.status === "building"
    || value.build?.status === "planning"
    || value.adaptation?.status === "running";
}

function readinessKey(value: AnalysisSessionView, forBuild: boolean): string {
  return JSON.stringify({
    forBuild,
    analysisPath: value.analysisPath,
    productReferencePath: value.productReferencePath,
    adaptation: value.adaptation,
    scaffold: value.scaffold,
    videoAroll: value.videoAroll,
  });
}

function invalidateOfficialPathChecks(): void {
  officialPathChecks = undefined;
  officialPathReady = undefined;
  lastReadinessKey = "";
}

function applySessionUpdate(next: AnalysisSessionView): boolean {
  const before = sessionFingerprint(session);
  const prevReadinessKey = readinessKey(session, Boolean(session.scaffold));
  const prevTab = activeTab;
  const prevNotice = completionNotice;
  const wasAnalyzing = session.job?.status === "running";
  const analysisDone = next.job?.status === "complete" && next.analysisPath !== undefined;
  if (wasAnalyzing && analysisDone) {
    completionNotice = `媒体分析完成：${analysisSummary(next)}。请确认参考图与改编配音就绪后，再点击「一键复刻」。`;
    activeTab = "insight";
  }
  const wasAdapting = session.adaptation?.status === "running";
  const adaptDone = wasAdapting && next.adaptation?.status === "complete" && next.adaptation.generatedSpeechPath !== undefined;
  if (adaptDone) {
    completionNotice = "改编配音已就绪！请在下方试听并确认口播内容，无误后再点击「一键复刻」。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    activeTab = "create";
  }
  const wasReplicating = session.workflowJob?.status === "running";
  const replicateDone = next.workflowJob?.status === "complete" && next.build?.status === "complete";
  if (wasReplicating && replicateDone) {
    completionNotice = "复刻完成！可在「成片」标签预览生成的视频。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    activeTab = "result";
    previewMode = "output";
  }
  const buildNowActive = next.build?.status === "building" || next.build?.status === "planning";
  if (buildNowActive) {
    clearCompletionNotice();
  }
  const wasBuildActive = session.build?.status === "building"
    || session.build?.status === "planning"
    || (wasReplicating && session.build?.status !== "complete");
  const buildFailed = wasBuildActive
    && (next.build?.status === "error" || (next.workflowJob?.status === "error" && next.scaffold !== undefined));
  if (buildFailed) {
    const detail = sessionBuildFailureDetail(next) ?? "未知错误";
    showBuildFailure(detail);
  }
  if (next.build?.status === "complete" && next.build.outputVideoPath !== undefined) {
    completionNotice = "复刻完成！可在「成片」标签预览生成的视频。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    activeTab = "result";
    previewMode = "output";
  }
  if (isSessionBusy(next)) {
    clearCreateActionPending();
  }
  session = next;
  const forBuild = Boolean(next.scaffold);
  const nextReadinessKey = readinessKey(session, forBuild);
  if ((activeTab === "create" || next.productReferencePath !== undefined) && nextReadinessKey !== prevReadinessKey) {
    invalidateOfficialPathChecks();
    void refreshOfficialPathChecks(forBuild);
  }
  return sessionFingerprint(session) !== before || activeTab !== prevTab || completionNotice !== prevNotice;
}

function renderTopbar(): HTMLElement {
  const bar = el("header", "topbar");
  const brand = el("div", "brand");
  brand.innerHTML = "hypit <span>官方复刻</span>";
  const meta = el("div", "topbar-meta");
  if (config === undefined) {
    meta.textContent = "加载中…";
  } else {
    const runtime = config.runtimeProfile?.split(/[/\\]/).pop() ?? "未选择 Runtime";
    meta.textContent = `${config.workspaceRoot.split(/[/\\]/).pop() ?? config.workspaceRoot} · ${runtime}`;
  }
  const actions = el("div", "topbar-actions");
  const analyzeBtn = el("button", "btn btn-primary", "开始分析") as HTMLButtonElement;
  analyzeBtn.disabled = session.videoPath === undefined || session.job?.status === "running";
  analyzeBtn.addEventListener("click", () => void startAnalysis());
  actions.append(analyzeBtn);
  bar.append(brand, meta, actions);
  return bar;
}

function renderLayout(): HTMLElement {
  const layout = el("main", "layout");
  layout.append(renderSidebar(), renderCenter(), renderInspector());
  return layout;
}

function renderSidebar(): HTMLElement {
  const sidebar = el("aside", "sidebar");
  sidebar.append(el("div", "panel-title", "官方复刻流程"));

  const analysisComplete = session.analysisPath !== undefined;
  const stepData = [
    { title: "1. 参考片分析", detail: "转写、切镜检测、深读归档", done: analysisComplete },
    { title: "2. 爆款解读", detail: "Insight（分析时自动生成）", done: session.insight !== undefined },
    { title: "3. 导演审查", detail: "在 Cursor 中让 Agent 审 BRIEF / 口播 / 切点", done: session.directorReview?.status === "approved" },
    { title: "4. 参考图与改编配音", detail: "产品图 + TTS 试听/音色样本（成片口播由 H3 生成）", done: session.productReferencePath !== undefined && session.adaptation?.status === "complete" },
    { title: "5. Brief / Treatment", detail: "导演稿或改编时生成", done: session.brief !== undefined && session.treatment !== undefined },
    { title: "6. 生成工程", detail: "一键复刻 → SVML + hypit check", done: session.scaffold !== undefined },
    { title: "7. Plan / Pricing", detail: "确认费用范围", done: session.build?.planSummary !== undefined },
    { title: "8. 生成视频", detail: "hypit build", done: session.build?.status === "complete" },
    { title: "9. 预览成片", detail: "对比参考片与输出", done: session.build?.outputVideoPath !== undefined },
  ];
  const steps = el("div", "step-list");
  const currentIndex = stepData.findIndex((s) => !s.done);
  for (const [index, step] of stepData.entries()) {
    const state = step.done ? "done" : index === currentIndex ? "current" : "";
    const card = el("article", `step${state ? ` ${state}` : ""}`);
    const body = el("div", "step-body");
    body.append(el("strong", undefined, step.title.replace(/^\d+\.\s*/, "")), el("p", undefined, step.detail));
    card.append(el("span", "step-num", String(index + 1)), body);
    steps.append(card);
  }
  sidebar.append(steps);

  sidebar.append(el("div", "panel-title", "导入视频"));
  const defaultField = el("div", "field");
  const defaultBtn = el("button", "btn", defaultVideoLoading ? "正在载入默认视频…" : "使用默认视频") as HTMLButtonElement;
  const defaultVideoUrl = config?.defaultVideoUrl;
  defaultBtn.disabled = defaultVideoUrl === undefined || defaultVideoLoading || session.job?.status === "running";
  defaultBtn.addEventListener("click", () => void useDefaultVideo());
  defaultField.append(el("label", undefined, "默认 origin 视频"), defaultBtn);
  if (defaultVideoUrl !== undefined) {
    defaultField.append(el("p", "uploaded-name", config?.defaultVideoName ?? "origin.mp4"));
    defaultField.append(el("p", "default-video-url", defaultVideoUrl));
  } else {
    defaultField.append(el("p", "uploaded-name", "未配置。请先运行 pnpm upload:origin"));
  }
  sidebar.append(defaultField);

  const uploadField = el("div", "field");
  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "video/*,audio/*";
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file !== undefined) void uploadFile(file);
  });
  uploadField.append(el("label", undefined, "上传文件"), fileInput);
  if (session.videoName !== undefined) {
    uploadField.append(el("p", "uploaded-name", `已导入：${session.videoName}`));
  }
  if (session.videoUrl !== undefined) {
    uploadField.append(el("p", "default-video-url", session.videoUrl));
  }
  sidebar.append(uploadField);

  const langField = el("div", "field");
  const langSelect = document.createElement("select");
  for (const option of [{ value: "zh", label: "中文" }, { value: "en", label: "English" }, { value: "es", label: "Español" }]) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    langSelect.append(node);
  }
  langSelect.value = config?.defaultLanguage ?? "zh";
  langField.append(el("label", undefined, "对白语言"), langSelect);
  sidebar.append(langField);

  if (session.job?.status === "running") {
    sidebar.append(el("div", "status running", session.job.phase ?? "分析中…"));
  } else if (session.workflowJob?.status === "running") {
    sidebar.append(el("div", "status running", session.workflowJob.phase ?? "复刻中…"));
  } else if (session.job?.status === "error" && session.job.error) {
    sidebar.append(el("div", "status error", session.job.error));
  } else if (session.build?.status === "error") {
    const detail = sessionBuildFailureDetail(session);
    if (detail !== undefined) {
      sidebar.append(el("div", "status error", summarizeBuildFailure(detail)));
    }
  } else if (session.workflowJob?.status === "error" && session.workflowJob.error) {
    sidebar.append(el("div", "status error", summarizeBuildFailure(session.workflowJob.error)));
  } else if (session.build?.outputVideoPath) {
    sidebar.append(el("div", "status success", "复刻完成，可预览成片"));
  } else if (analysisComplete) {
    sidebar.append(el("div", "status success", `分析完成 · ${analysisSummary(session)}`));
  }

  if (config?.hasChatApiKey === false) {
    sidebar.append(el("div", "status error", "未配置 OPENAI_API_KEY：官方路径需要 LLM 撰写 Insight / Brief / Treatment / 口播改写。"));
  }
  if (config?.hasH3ApiKey === false) {
    sidebar.append(el("div", "status error", "未配置 H3_VIDEO_API_KEY：官方路径需要 MiniMax H3 生成 A-roll 口播。"));
  }

  return sidebar;
}

function renderCenter(): HTMLElement {
  const center = el("section", "center");
  const playerWrap = el("div", "player-wrap");
  const shell = el("div", "player-shell");

  const hasOutput = session.build?.outputVideoPath !== undefined;
  const showingOutput = previewMode === "output" && hasOutput;
  const url = showingOutput
    ? mediaUrl(session.build?.outputVideoPath)
    : (session.videoUrl ?? mediaUrl(session.videoPath));

  if (hasOutput) {
    const toggle = el("div", "preview-toggle");
    for (const mode of [{ id: "reference" as const, label: "参考片" }, { id: "output" as const, label: "成片" }]) {
      const btn = el("button", `btn${previewMode === mode.id ? " active" : ""}`, mode.label);
      btn.addEventListener("click", () => { previewMode = mode.id; render(); });
      toggle.append(btn);
    }
    playerWrap.append(toggle);
  }

  if (url === undefined) {
    shell.append(el("div", "player-empty", "导入参考视频后开始"));
  } else {
    const video = document.createElement("video");
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    if (!showingOutput && session.videoUrl !== undefined) {
      video.addEventListener("error", () => {
        const fallback = mediaUrl(session.videoPath);
        if (fallback === undefined || video.dataset.localFallback === "1") return;
        video.dataset.localFallback = "1";
        video.src = fallback;
      });
    }
    video.addEventListener("timeupdate", () => { currentTime = video.currentTime; highlightActiveWord(); });
    shell.append(video);
  }
  playerWrap.append(shell);
  center.append(playerWrap);

  if (session.probe !== undefined) {
    const meta = el("div", "center-meta");
    for (const item of [
      { label: "时长", value: `${session.probe.duration}s` },
      { label: "画幅", value: `${session.probe.width}×${session.probe.height}` },
      { label: "帧率", value: session.probe.frameRate > 0 ? `${session.probe.frameRate} fps` : "静态" },
      { label: "音频", value: session.probe.hasAudio ? "有" : "无" },
    ]) {
      const chip = el("span", "center-meta-item");
      chip.append(el("strong", undefined, item.value), document.createTextNode(item.label));
      meta.append(chip);
    }
    center.append(meta);
  }

  const timeline = renderCompactTimeline(session.probe?.duration ?? 0);
  if (timeline !== undefined) center.append(timeline);

  const duration = session.probe?.duration ?? 0;
  const transport = el("div", "transport");
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(Math.max(duration, 0.001));
  slider.step = "0.01";
  slider.value = String(currentTime);
  slider.addEventListener("input", () => {
    currentTime = Number(slider.value);
    const video = shell.querySelector("video");
    if (video !== null) video.currentTime = currentTime;
    highlightActiveWord();
  });
  transport.append(el("span", "timecode", `${formatTime(currentTime)} / ${formatTime(duration)}`), slider);
  center.append(transport);
  return center;
}

function renderCompactTimeline(duration: number): HTMLElement | undefined {
  if (duration <= 0) return undefined;
  const hasSegments = (session.segments?.length ?? 0) > 0;
  const hasCuts = (session.boundaries?.length ?? 0) > 0;
  if (!hasSegments && !hasCuts) return undefined;
  return renderTimeline(duration);
}

function renderTimeline(duration: number): HTMLElement {
  const timeline = el("section", "timeline");
  timeline.append(el("h3", undefined, "语义与画面时间轴"));
  const body = el("div", "timeline-body");
  if (duration <= 0) {
    body.append(el("p", undefined, "导入视频后显示时间轴"));
    timeline.append(body);
    return timeline;
  }
  const segmentLane = el("div", "lane");
  segmentLane.append(el("span", "lane-label", "口播文案"));
  for (const segment of session.segments ?? []) {
    const marker = el("button", "marker segment", segment.label);
    marker.style.left = `${(segment.start / duration) * 100}%`;
    marker.style.width = `${Math.max(2, ((segment.end - segment.start) / duration) * 100)}%`;
    marker.title = segment.text;
    marker.addEventListener("click", () => seekTo(segment.start));
    segmentLane.append(marker);
  }
  body.append(segmentLane);
  const cutLane = el("div", "lane");
  cutLane.append(el("span", "lane-label", "画面变化"));
  for (const boundary of session.boundaries ?? []) {
    const marker = el("button", "marker cut");
    marker.style.left = `${(boundary.at / duration) * 100}%`;
    marker.title = `${formatTime(boundary.at)} · ${boundary.score}`;
    marker.addEventListener("click", () => seekTo(boundary.at));
    cutLane.append(marker);
  }
  body.append(cutLane);
  timeline.append(body);
  return timeline;
}

function renderInspector(): HTMLElement {
  const inspector = el("aside", "inspector");
  const tabs = el("div", "tabs");
  const tabItems: { id: TabId; label: string }[] = [
    { id: "overview", label: "概览" },
    { id: "timeline", label: "深读归档" },
    { id: "insight", label: "爆款解读" },
    { id: "brief", label: "Brief / Treatment" },
    { id: "transcript", label: "转写" },
    { id: "create", label: "复刻" },
    { id: "result", label: "成片" },
  ];
  for (const tab of tabItems) {
    const button = el("button", `tab${activeTab === tab.id ? " active" : ""}`, tab.label);
    button.addEventListener("click", () => {
      if (tab.id === "create") createTabFocus = true;
      activeTab = tab.id;
      render();
    });
    tabs.append(button);
  }
  inspector.append(tabs);
  const panel = el("div", "tab-panel");
  const renders: Record<TabId, () => HTMLElement> = {
    overview: renderOverview,
    timeline: renderTimelineDoc,
    insight: renderInsight,
    brief: renderBrief,
    transcript: renderTranscript,
    create: renderCreate,
    result: renderResult,
  };
  panel.append(renders[activeTab]());
  inspector.append(panel);
  return inspector;
}

async function loadMarkdown(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  try {
    const payload = await api<{ markdown: string }>("/__analysis/document?path=" + encodeURIComponent(path));
    return payload.markdown;
  } catch {
    return undefined;
  }
}

async function loadAdaptedScript(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  if (adaptedScriptCache.has(path)) return adaptedScriptCache.get(path);
  try {
    const payload = await api<{ markdown: string }>("/__analysis/document?path=" + encodeURIComponent(path));
    const scenes = JSON.parse(payload.markdown) as readonly { readonly id?: string; readonly text?: string }[];
    const lines = scenes
      .map((scene) => scene.text?.trim())
      .filter((text): text is string => text !== undefined && text.length > 0);
    const script = lines.length > 0 ? lines.join("\n\n") : undefined;
    adaptedScriptCache.set(path, script);
    return script;
  } catch {
    adaptedScriptCache.set(path, undefined);
    return undefined;
  }
}

function renderMediaPreview(url: string | undefined, kind: "audio" | "video"): HTMLElement | undefined {
  if (url === undefined) return undefined;
  const media = document.createElement(kind);
  media.className = kind === "audio" ? "media-preview audio-preview" : "media-preview result-video";
  media.controls = true;
  if (media instanceof HTMLVideoElement) media.playsInline = true;
  media.src = url;
  return media;
}

function renderTimelineDoc(): HTMLElement {
  const wrap = el("div");
  const archive = session.referenceArchive;
  if (!session.analysisPath) {
    wrap.append(el("div", "card", "请先完成参考片分析，将自动生成 references/ 深读归档。"));
    return wrap;
  }
  if (archive === undefined) {
    wrap.append(el("div", "card", "深读归档生成中或尚未就绪，请稍后刷新或重新分析。"));
    return wrap;
  }
  const card = el("div", "card");
  card.append(
    el("h4", undefined, "官方参考片归档"),
    el("p", undefined, archive.referenceDir),
    el("p", undefined, "INSIGHT.md · TIMELINE.md · PROGRESS.md · evidence/"),
  );
  wrap.append(card);
  const evidence = el("div", "card");
  evidence.append(el("h4", undefined, "证据网格"));
  const grid = el("div", "evidence-grid");
  for (const path of archive.evidencePaths.slice(0, 12)) {
    const img = document.createElement("img");
    img.src = mediaUrl(path) ?? "";
    img.alt = path.split(/[/\\]/u).pop() ?? "evidence";
    img.loading = "lazy";
    grid.append(img);
  }
  evidence.append(grid);
  wrap.append(evidence);
  void loadMarkdown(archive.timelineMarkdownPath).then((markdown) => {
    if (markdown === undefined) return;
    const doc = el("div", "card");
    doc.append(el("h4", undefined, "TIMELINE.md"), el("pre", "doc-preview", markdown));
    wrap.append(doc);
  });
  return wrap;
}

function renderOverview(): HTMLElement {
  const wrap = el("div");
  if (!session.probe) { wrap.append(el("div", "card", "尚未导入视频。")); return wrap; }
  if (session.analysisPath) {
    const card = el("div", "card card-highlight");
    card.append(el("h4", undefined, "参考片分析已完成"), el("p", undefined, analysisSummary(session)));
    const actions = el("div", "result-actions");
    const insightBtn = el("button", "btn", "查看爆款解读");
    insightBtn.addEventListener("click", () => { activeTab = "insight"; render(); });
    const createBtn = el("button", "btn btn-primary", "前往复刻");
    createBtn.addEventListener("click", () => { activeTab = "create"; render(); });
    actions.append(insightBtn, createBtn);
    card.append(actions);
    wrap.append(card);
  }
  const grid = el("div", "meta-grid");
  for (const item of [
    { label: "时长", value: `${session.probe.duration}s` },
    { label: "画幅", value: `${session.probe.width}×${session.probe.height}` },
    { label: "帧率", value: session.probe.frameRate > 0 ? `${session.probe.frameRate} fps` : "静态" },
    { label: "音频", value: session.probe.hasAudio ? "有" : "无" },
  ]) {
    const card = el("div", "meta-item");
    card.append(el("strong", undefined, item.value), el("span", undefined, item.label));
    grid.append(card);
  }
  wrap.append(grid);
  if (session.tilePath) {
    const img = document.createElement("img");
    img.className = "tile-preview";
    img.src = mediaUrl(session.tilePath) ?? "";
    wrap.append(el("div", "panel-title", "画面抽样"), img);
  }
  return wrap;
}

function renderInsightNextSteps(): HTMLElement {
  const card = el("div", "card");
  card.append(el("h4", undefined, "下一步"));
  const steps = document.createElement("ol");
  for (const text of [
    "到「复刻」页上传参考图（产品/人物）",
    "在 Cursor 中让 Agent 完成导演审查（编辑 .hypit/analysis/director/）",
    "Analysis 点击「导演审查通过」后试听配音并确认口播",
    "通过官方路径检查后点击「一键复刻」",
    "确认 Plan/Pricing 后点击「开始生成视频」",
  ]) {
    const li = document.createElement("li");
    li.textContent = text;
    steps.append(li);
  }
  card.append(steps);
  return card;
}

function renderInsight(): HTMLElement {
  const wrap = el("div");
  if (!session.insight) {
    const card = el("div", "card");
    if (!session.analysisPath) {
      card.append(el("p", undefined, "请先完成参考片分析。"));
    } else if (session.job?.status === "running") {
      card.append(el("div", "status running", session.job.phase ?? "正在生成爆款解读…"));
      card.append(el("p", undefined, "官方流程会在分析阶段自动生成 Insight。"));
    } else {
      card.append(el("p", undefined, "爆款解读尚未生成。请重新运行「开始分析」（需配置 OPENAI_API_KEY）。"));
    }
    wrap.append(card);
    return wrap;
  }
  const insight = session.insight;
  wrap.append(el("div", "card card-highlight", insight.summary));
  wrap.append(el("div", "panel-title", "为什么火"));
  for (const item of insight.whyViral) {
    const card = el("article", "card");
    card.append(el("h4", undefined, item.title), el("p", "insight-detail", item.detail));
    wrap.append(card);
  }
  wrap.append(el("div", "panel-title", "怎么火的"));
  for (const item of insight.howItWorks) {
    const card = el("article", "card");
    card.append(el("h4", undefined, item.title), el("p", "insight-detail", item.detail));
    wrap.append(card);
  }
  const hook = el("div", "card");
  hook.append(el("h4", undefined, "Hook 分析"), el("p", "insight-detail", insight.hookAnalysis));
  wrap.append(hook);
  const tips = el("div", "card");
  tips.append(el("h4", undefined, "复刻建议"));
  const list = document.createElement("ul");
  for (const tip of insight.replicationTips) {
    const li = document.createElement("li");
    li.textContent = tip;
    list.append(li);
  }
  tips.append(list);
  wrap.append(tips);
  wrap.append(renderInsightNextSteps());
  return wrap;
}

function renderBrief(): HTMLElement {
  const wrap = el("div");
  if (!session.brief) {
    const card = el("div", "card");
    card.append(el("p", undefined, "官方流程会在「改编配音」阶段自动生成 Brief 与 Treatment。请先在「复刻」页上传参考图并完成配音制作。"));
    wrap.append(card);
    return wrap;
  }
  const briefCard = el("div", "card");
  briefCard.append(el("h4", undefined, "BRIEF.md"), el("pre", "doc-preview", session.brief.markdown));
  wrap.append(briefCard);
  if (session.treatment) {
    const treatmentCard = el("div", "card");
    treatmentCard.append(el("h4", undefined, "TREATMENT.md"), el("pre", "doc-preview", session.treatment.markdown));
    wrap.append(treatmentCard);
  }
  if (session.scaffold) {
    wrap.append(el("div", "card", `工程目录：${session.scaffold.productionDir}`));
  }
  return wrap;
}

function renderTranscript(): HTMLElement {
  const wrap = el("div");
  const words = session.transcript?.words ?? [];
  if (words.length === 0) {
    wrap.append(el("div", "card", session.probe?.hasAudio === false ? "该视频没有音频轨。" : "请先运行媒体分析。"));
    return wrap;
  }
  const transcript = el("div", "transcript");
  for (const word of words) {
    const span = el("span", "word", word.text);
    span.dataset.start = String(word.start ?? "");
    span.dataset.end = String(word.end ?? "");
    span.addEventListener("click", () => { if (word.start !== undefined) seekTo(word.start); });
    transcript.append(span, document.createTextNode(" "));
  }
  wrap.append(transcript);
  return wrap;
}

function renderReferenceField(): HTMLElement {
  const referenceField = el("div", "field");
  const referenceInput = document.createElement("input");
  referenceInput.type = "file";
  referenceInput.accept = ".jpg,.jpeg,.png,.webp,.gif,.avif,image/jpeg,image/png,image/webp,image/gif,image/avif";
  referenceInput.disabled = referenceUploading;
  referenceInput.addEventListener("change", () => {
    const file = referenceInput.files?.[0];
    if (file !== undefined) void uploadReferenceFile(file, referenceInput);
  });
  referenceField.append(el("label", undefined, "参考图（产品/人物，必填）"), referenceInput);
  if (referenceUploading) {
    referenceField.append(el("div", "status running", "上传中…"));
  } else if (referenceUploadError !== undefined) {
    referenceField.append(el("div", "status error", referenceUploadError));
  }
  if (session.productReferencePath !== undefined) {
    const previewUrl = mediaUrl(session.productReferencePath);
    if (previewUrl !== undefined) {
      const preview = document.createElement("img");
      preview.className = "reference-preview";
      preview.src = previewUrl;
      preview.alt = session.productReferenceName ?? "参考图";
      referenceField.append(preview);
    }
    referenceField.append(el("p", "uploaded-name", `已上传：${session.productReferenceName ?? "参考图"}`));
  } else {
    referenceField.append(el("p", undefined, "生成视频必须提供参考图与改编配音音频给模型。支持 jpg、png、webp、gif、avif。"));
  }
  if (session.productReferencePath !== undefined && session.analysisPath === undefined) {
    referenceField.append(el("p", undefined, "完成参考视频分析后，将创建导演审查任务（不再自动制作配音）。"));
  }
  return referenceField;
}

function renderDirectorReviewField(): HTMLElement {
  const field = el("div", "field");
  field.append(el("label", undefined, "导演审查（Cursor 对话，必填）"));
  if (session.productReferencePath === undefined || session.analysisPath === undefined) {
    field.append(el("p", undefined, "上传参考图并完成分析后，将生成 .hypit/analysis/director/ 审查稿。"));
    return field;
  }
  const review = session.directorReview;
  if (review?.status === "approved") {
    field.append(el("div", "status success", review.phase ?? "导演审查已通过"));
    field.append(el("p", undefined, `审查目录：${review.dir}`));
    const refresh = el("button", "btn", "刷新审查稿");
    refresh.addEventListener("click", () => void refreshDirectorReview());
    field.append(refresh);
    return field;
  }
  field.append(el("div", "status running", review?.phase ?? "等待导演审查"));
  field.append(el("p", undefined, "在 Cursor 对话中让 Agent 编辑 .hypit/analysis/director/ 下的 BRIEF.md、TREATMENT.md、scenes.json，确认口播无误后点击下方按钮。"));
  if (review?.dir !== undefined) {
    field.append(el("p", "uploaded-name", review.dir));
  }
  const actions = el("div", "result-actions");
  const approve = el("button", "btn btn-primary", "导演审查通过，开始制作配音");
  approve.addEventListener("click", () => void approveDirectorReview());
  const refresh = el("button", "btn", "重新生成审查稿");
  refresh.addEventListener("click", () => void refreshDirectorReview());
  actions.append(approve, refresh);
  field.append(actions);
  return field;
}

function renderAdaptationField(): HTMLElement {
  const adaptField = el("div", "field");
  adaptField.append(el("label", undefined, "改编配音（必填）"));
  if (session.productReferencePath === undefined) {
    adaptField.append(el("p", undefined, "请先上传参考图并完成导演审查。"));
  } else {
    const adapt = session.adaptation;
    if (adapt?.status === "running") {
      adaptField.append(el("div", "status running", adapt.phase ?? "制作配音中…"));
    } else if (adapt?.status === "complete" && adapt.generatedSpeechPath !== undefined) {
      adaptField.append(el("div", "status success", adapt.phase ?? "配音已就绪"));
      const audioUrl = mediaUrl(adapt.generatedSpeechPath);
      const audioPreview = renderMediaPreview(audioUrl, "audio");
      if (audioPreview !== undefined) adaptField.append(audioPreview);
      const audioActions = el("div", "result-actions");
      const preview = el("button", "btn", "新窗口试听");
      preview.addEventListener("click", () => {
        window.open(audioUrl, "_blank");
      });
      const download = el("button", "btn", "下载音频");
      download.addEventListener("click", () => {
        triggerMediaDownload(adapt.generatedSpeechPath!);
      });
      const retry = el("button", "btn", "重新制作");
      retry.addEventListener("click", () => void prepareAdaptation());
      audioActions.append(preview, download, retry);
      adaptField.append(audioActions);
      const scriptCard = el("div", "adapted-script");
      scriptCard.append(el("strong", undefined, "改编口播"));
      const scenesPath = adapt.adaptedScenesPath;
      if (scenesPath === undefined) {
        scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
      } else if (adaptedScriptCache.has(scenesPath)) {
        const script = adaptedScriptCache.get(scenesPath);
        if (script === undefined) {
          scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
        } else {
          scriptCard.append(el("pre", "doc-preview adapted-script-text", script));
        }
      } else {
        scriptCard.append(el("p", "adapted-script-loading", "加载口播文案…"));
        void loadAdaptedScript(scenesPath).then((script) => {
          if (!scriptCard.isConnected) return;
          scriptCard.replaceChildren(el("strong", undefined, "改编口播"));
          if (script === undefined) {
            scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
          } else {
            scriptCard.append(el("pre", "doc-preview adapted-script-text", script));
          }
        });
      }
      adaptField.append(scriptCard);
    } else if (adapt?.status === "error") {
      adaptField.append(el("div", "status error", adapt.error ?? "配音制作失败"));
      const retry = el("button", "btn", "重试制作配音");
      retry.addEventListener("click", () => void prepareAdaptation());
      adaptField.append(retry);
    } else if (session.analysisPath !== undefined) {
      if (session.directorReview?.status === "approved") {
        adaptField.append(el("p", undefined, "导演审查已通过，可开始制作配音。"));
        const retry = el("button", "btn", "开始制作配音");
        retry.addEventListener("click", () => void prepareAdaptation());
        adaptField.append(retry);
      } else {
        adaptField.append(el("p", undefined, "请先完成导演审查，再制作配音。"));
      }
    } else {
      adaptField.append(el("p", undefined, "完成参考视频分析后，先进行导演审查。"));
    }
  }
  return adaptField;
}

function renderOfficialPathChecklist(): HTMLElement {
  const card = el("div", "card");
  card.append(el("h4", undefined, "官方复刻路径检查"));
  if (officialPathChecks === undefined) {
    card.append(el("p", undefined, "加载检查项…"));
    void refreshOfficialPathChecks(Boolean(session.scaffold));
    return card;
  }
  const list = document.createElement("ul");
  list.className = "official-checklist";
  for (const check of officialPathChecks) {
    const item = document.createElement("li");
    item.className = check.ok ? "ok" : "pending";
    item.append(el("strong", undefined, check.ok ? "✓ " : "○ "), document.createTextNode(check.label));
    item.append(el("p", undefined, check.detail));
    list.append(item);
  }
  card.append(list);
  const checkHint = officialPathCheckHint(session, officialPathReady);
  if (officialPathReady === true) {
    card.append(el("div", "status success", checkHint));
  } else {
    card.append(el("div", "status", checkHint));
  }
  if (config !== undefined) {
    const meta = el("p", "build-meta");
    meta.textContent = [
      config.hasChatApiKey ? "LLM ✓" : "LLM ✗",
      config.hasH3ApiKey ? "H3 ✓" : "H3 ✗",
      config.ttsModel ?? "",
    ].filter(Boolean).join(" · ");
    card.append(meta);
  }
  return card;
}

async function refreshOfficialPathChecks(forBuild = false): Promise<void> {
  const key = readinessKey(session, forBuild);
  if (key === lastReadinessKey && officialPathChecks !== undefined && officialPathReady !== undefined) return;
  const token = ++readinessRefreshToken;
  try {
    const readiness = await api<{ ok: boolean; checks: OfficialPathCheckView[] }>(
      `/__analysis/readiness${forBuild ? "?forBuild=1" : ""}`,
    );
    if (token !== readinessRefreshToken) return;
    const before = JSON.stringify({ checks: officialPathChecks, ready: officialPathReady });
    officialPathChecks = readiness.checks;
    officialPathReady = readiness.ok;
    lastReadinessKey = key;
    const after = JSON.stringify({ checks: officialPathChecks, ready: officialPathReady });
    if (activeTab === "create" && before !== after) render();
  } catch {
    if (token !== readinessRefreshToken) return;
    invalidateOfficialPathChecks();
  }
}

function renderGenerationInputs(): HTMLElement {
  const section = el("div", "card");
  section.append(el("h4", undefined, "参考图、导演审查与改编配音"));
  section.append(renderReferenceField(), renderDirectorReviewField(), renderAdaptationField());

  const notesField = el("div", "field");
  const notesInput = document.createElement("textarea");
  notesInput.rows = 2;
  notesInput.placeholder = "改编说明：你的产品名称、核心卖点、目标人群（将按爆款结构改写口播）";
  notesInput.value = replicateNotes;
  notesInput.addEventListener("input", () => {
    replicateNotes = notesInput.value;
  });
  notesInput.addEventListener("blur", () => {
    void persistAdaptationGoal(replicateNotes);
  });
  notesField.append(el("label", undefined, "改编说明"), notesInput);
  section.append(notesField);

  const stackField = el("div", "field");
  stackField.append(
    el("label", undefined, "官方模型栈"),
    el("p", undefined, "TTS 试听/音色样本 → H3 A-roll 口播成片（h3-ugc-replica-v1 多 Take）→ gpt:Image B-roll"),
  );
  section.append(stackField);
  return section;
}

function renderCreateActionBar(): HTMLElement {
  const status = resolveCreateActionStatus(session, {
    pending: createActionPending,
    officialPathReady,
  });
  const bar = el("div", `create-action-bar create-action-bar-${status.tone}`);
  const row = el("div", "create-action-row");
  if (status.tone === "running") {
    row.append(el("span", "create-action-spinner", ""));
  }
  row.append(el("strong", "create-action-headline", status.headline));
  bar.append(row);
  if (status.detail !== undefined) {
    bar.append(el("pre", "create-action-detail", status.detail));
  }
  return bar;
}

function renderCreateActionFooter(): HTMLElement | undefined {
  if (!session.analysisPath) return undefined;
  const footer = el("div", "create-action-footer");

  if (session.scaffold === undefined) {
    const replicateBusy = isReplicateActionBusy(session, createActionPending);
    const btn = el("button", "btn btn-primary create-replicate-btn", replicateBusy ? "复刻中…" : "一键复刻") as HTMLButtonElement;
    btn.disabled = replicateBusy || officialPathReady === false;
    btn.addEventListener("click", () => void startReplication());
    footer.append(btn);
    return footer;
  }

  if (session.build?.status === "complete") return undefined;

  const buildBusy = isBuildActionBusy(session, createActionPending);
  if (session.build?.status === "planning" || session.build?.status === "building") {
    footer.append(el("div", "status running", session.build.phase ?? "生成中…"));
    return footer;
  }

  const failureDetail = session.build?.status === "error" ? sessionBuildFailureDetail(session) : undefined;
  const btn = el(
    "button",
    "btn btn-primary create-build-btn",
    buildBusy ? "提交中…" : (failureDetail === undefined ? "开始生成视频" : "重试生成视频"),
  ) as HTMLButtonElement;
  btn.disabled = buildBusy;
  btn.addEventListener("click", () => void runBuild());
  footer.append(btn);
  return footer;
}

function renderCreate(): HTMLElement {
  const wrap = el("div", "create-panel");
  if (!session.analysisPath) {
    const card = el("div", "card");
    card.append(el("p", undefined, "请先完成媒体分析。"));
    wrap.append(card);
    return wrap;
  }

  wrap.append(renderCreateActionBar());
  wrap.append(renderGenerationInputs());
  wrap.append(renderOfficialPathChecklist());

  const card = el("div", "card");
  if (!session.scaffold) {
    card.append(el("p", undefined, "参考图与改编配音就绪后，点击「一键复刻」生成工程与 Plan/Pricing，确认费用后再点「开始生成视频」。"));
    if (session.productReferencePath === undefined) {
      card.append(el("p", undefined, "请先上传「参考图（产品/人物）」。"));
    } else {
      const adapt = session.adaptation;
      if (adapt?.status === "complete") {
        card.append(el("p", undefined, "参考图与改编配音已就绪。成片口播由 H3 按改写文案生成（TTS 仅作审查试听与音色样本）。"));
      } else if (adapt?.status === "running") {
        card.append(el("div", "status running", adapt.phase ?? "配音制作中，请稍候…"));
      } else {
        card.append(el("p", undefined, "请先完成「改编配音」，再点击一键复刻。"));
      }
    }
    wrap.append(card);
    const footer = renderCreateActionFooter();
    if (footer !== undefined) wrap.append(footer);
    return wrap;
  }
  card.append(
    el("h4", undefined, "工程已生成"),
    el("p", undefined, `目录：${session.scaffold.productionDir}`),
    el("p", undefined, `Run：${session.scaffold.runPath}`),
  );
  if (session.scaffold.checkOk === false && !isCliCheckInvocationError(session.scaffold.checkSummary)) {
    card.append(el("div", "status error", `工程校验：${session.scaffold.checkSummary ?? "未通过"}`));
  } else if (
    session.scaffold.checkSummary !== undefined
    && session.scaffold.checkSummary.length > 0
    && !isCliCheckInvocationError(session.scaffold.checkSummary)
  ) {
    card.append(el("p", "build-meta", `校验：${session.scaffold.checkSummary.split("\n")[0]}`));
  }
  wrap.append(card);
  if (session.build?.planSummary) {
    const plan = el("div", "card");
    plan.append(el("h4", undefined, "执行计划"), el("pre", "doc-preview", session.build.planSummary));
    wrap.append(plan);
  }
  if (session.build?.pricingSummary) {
    const pricing = el("div", "card");
    pricing.append(el("h4", undefined, "费用估算"), el("pre", "doc-preview", session.build.pricingSummary));
    wrap.append(pricing);
  }
  if (session.build?.status === "planning" || session.build?.status === "building") {
    wrap.append(el("div", "status running", session.build.phase ?? "生成中…"));
    if (session.build.id !== undefined) {
      wrap.append(el("p", "build-meta", `Build ID：${session.build.id}`));
    }
  }
  const failureDetail = session.build?.status === "error" ? sessionBuildFailureDetail(session) : undefined;
  if (failureDetail !== undefined) {
    wrap.append(renderFailureCard(summarizeBuildFailure(failureDetail), failureDetail));
  }
  const footer = renderCreateActionFooter();
  if (footer !== undefined) wrap.append(footer);
  return wrap;
}

function renderResult(): HTMLElement {
  const wrap = el("div");
  if (!session.build?.outputVideoPath) {
    const card = el("div", "card");
    const phase = session.build?.status === "planning" || session.build?.status === "building"
      ? (session.build.phase ?? "视频生成中，请稍候…")
      : "完成复刻后在此预览成片。";
    card.append(el("p", undefined, phase));
    wrap.append(card);
    if (session.build?.status === "planning" || session.build?.status === "building") {
      wrap.append(el("div", "status running", session.workflowJob?.phase ?? session.build.phase ?? "生成中…"));
    }
    const failureDetail = session.build?.status === "error" ? sessionBuildFailureDetail(session) : undefined;
    if (failureDetail !== undefined) {
      wrap.append(renderFailureCard(summarizeBuildFailure(failureDetail), failureDetail));
      const retry = el("button", "btn btn-primary", "重试生成视频");
      retry.addEventListener("click", () => void runBuild());
      wrap.append(retry);
    }
    return wrap;
  }
  const card = el("div", "card card-highlight");
  card.append(el("h4", undefined, "成片已生成"), el("p", undefined, session.build.outputVideoPath));
  const videoUrl = mediaUrl(session.build.outputVideoPath);
  const videoPreview = renderMediaPreview(videoUrl, "video");
  if (videoPreview !== undefined) card.append(videoPreview);
  const actions = el("div", "result-actions");
  const preview = el("button", "btn btn-primary", "中央播放器预览");
  preview.addEventListener("click", () => { previewMode = "output"; render(); });
  const reference = el("button", "btn", "对比参考片");
  reference.addEventListener("click", () => { previewMode = "reference"; render(); });
  const open = el("button", "btn", "新窗口打开");
  open.addEventListener("click", () => { window.open(videoUrl, "_blank"); });
  actions.append(preview, reference, open);
  card.append(actions);
  wrap.append(card);
  if (session.scaffold) {
    const studioCard = el("div", "card");
    const runRel = session.scaffold.runPath.replace(/\\/gu, "/");
    const studioCmd = "hypit studio --run " + runRel;
    studioCard.append(
      el("h4", undefined, "Studio 精修"),
      el("p", undefined, "项目：" + session.scaffold.productionDir),
      el("pre", "doc-preview", studioCmd),
    );
    const copyBtn = el("button", "btn", "复制 Studio 命令");
    copyBtn.addEventListener("click", () => void navigator.clipboard.writeText(studioCmd));
    studioCard.append(copyBtn);
    wrap.append(studioCard);
  }
  return wrap;
}

function seekTo(time: number): void {
  currentTime = time;
  const video = document.querySelector<HTMLVideoElement>(".player-shell video");
  if (video !== null) video.currentTime = time;
  const slider = document.querySelector<HTMLInputElement>(".transport input[type='range']");
  if (slider) slider.value = String(time);
  highlightActiveWord();
}

function highlightActiveWord(): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>(".word"))) {
    const start = Number(node.dataset.start);
    const end = Number(node.dataset.end);
    node.classList.toggle("active", Number.isFinite(start) && Number.isFinite(end) && currentTime >= start && currentTime < end);
  }
}

async function bootstrap(): Promise<void> {
  config = await api<AnalysisConfigView>("/__analysis/config");
  session = await api<AnalysisSessionView>("/__analysis/session");
  if (session.adaptationGoal !== undefined && session.adaptationGoal.length > 0) {
    replicateNotes = session.adaptationGoal;
  }
  if (session.build?.outputVideoPath) {
    previewMode = "output";
    activeTab = "result";
  } else if (session.build?.status === "error") {
    const detail = sessionBuildFailureDetail(session);
    if (detail !== undefined) showBuildFailure(detail);
    activeTab = "create";
  }
  render();
  void refreshOfficialPathChecks(Boolean(session.scaffold));
  if (isSessionBusy(session)) startPolling();
}

async function uploadFile(file: File): Promise<void> {
  try {
    const body = new FormData();
    body.append("file", file, file.name);
    session = await api<AnalysisSessionView>("/__analysis/upload", { method: "POST", body });
    session = { ...session, job: { id: "upload", status: "complete" } };
  } catch (error) {
    session = { ...session, job: { id: "upload", status: "error", error: error instanceof Error ? error.message : String(error) } };
  }
  render();
}

async function useDefaultVideo(): Promise<void> {
  defaultVideoLoading = true;
  render();
  try {
    session = await api<AnalysisSessionView>("/__analysis/use-default-video", { method: "POST" });
    session = { ...session, job: { id: "upload", status: "complete" } };
    previewMode = "reference";
  } catch (error) {
    session = { ...session, job: { id: "upload", status: "error", error: error instanceof Error ? error.message : String(error) } };
  } finally {
    defaultVideoLoading = false;
  }
  render();
}

async function persistAdaptationGoal(goal: string): Promise<void> {
  try {
    session = await api<AnalysisSessionView>("/__analysis/adaptation-goal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal }),
    });
  } catch {
    // non-blocking
  }
}

async function approveDirectorReview(): Promise<void> {
  invalidateOfficialPathChecks();
  try {
    session = await api<AnalysisSessionView>("/__analysis/director/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    completionNotice = "导演审查已通过，正在制作改编配音…";
    completionNoticeIsError = false;
    startPolling();
  } catch (error) {
    completionNotice = error instanceof Error ? error.message : String(error);
    completionNoticeIsError = true;
  }
  render();
}

async function refreshDirectorReview(): Promise<void> {
  try {
    session = await api<AnalysisSessionView>("/__analysis/director/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch (error) {
    completionNotice = error instanceof Error ? error.message : String(error);
    completionNoticeIsError = true;
  }
  render();
}

async function prepareAdaptation(): Promise<void> {
  adaptedScriptCache.clear();
  invalidateOfficialPathChecks();
  try {
    session = await api<AnalysisSessionView>("/__analysis/prepare-adaptation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(replicateNotes ? { goal: replicateNotes } : {}),
    });
    startPolling();
    render();
  } catch (error) {
    session = {
      ...session,
      adaptation: {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      },
    };
    render();
  }
}

async function ensureReplicationReady(forBuild = false): Promise<boolean> {
  setCreateActionPending("readiness", forBuild ? "正在检查工程与素材…" : "正在检查复刻就绪状态…");
  render();
  try {
    const readiness = await api<{ ok: boolean; issues: string[] }>(
      `/__analysis/readiness${forBuild ? "?forBuild=1" : ""}`,
    );
    if (!readiness.ok) {
      clearCreateActionPending();
      showBuildFailure(readiness.issues.join("\n"));
      activeTab = "create";
      render();
      return false;
    }
    clearCreateActionPending();
    return true;
  } catch (error) {
    clearCreateActionPending();
    const detail = error instanceof Error ? error.message : String(error);
    showBuildFailure(detail);
    activeTab = "create";
    render();
    return false;
  }
}

async function uploadReferenceFile(file: File, input?: HTMLInputElement): Promise<void> {
  referenceUploading = true;
  referenceUploadError = undefined;
  render();
  try {
    const body = new FormData();
    body.append("file", file, file.name);
    session = await api<AnalysisSessionView>("/__analysis/upload-reference", { method: "POST", body });
    referenceUploadError = undefined;
    startPolling();
  } catch (error) {
    referenceUploadError = error instanceof Error ? error.message : String(error);
  } finally {
    referenceUploading = false;
    if (input !== undefined) input.value = "";
  }
  render();
}

async function runBuild(): Promise<void> {
  activeTab = "create";
  clearCompletionNotice();
  const previousBuild = session.build;
  const previousJob = session.workflowJob;
  session = {
    ...session,
    build: { status: "planning", phase: "检查生成条件…" },
    workflowJob: { id: "build", status: "running", phase: "检查生成条件…" },
  };
  render();
  if (!(await ensureReplicationReady(true))) {
    session = { ...session, build: previousBuild, workflowJob: previousJob };
    render();
    return;
  }
  setCreateActionPending("build", "正在发送视频生成请求…");
  render();
  try {
    applySessionUpdate(await api<AnalysisSessionView>("/__analysis/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    setCreateActionPending("build", "请求已提交，正在启动 Build…");
    render();
    startPolling();
  } catch (error) {
    clearCreateActionPending();
    const detail = error instanceof Error ? error.message : String(error);
    session = {
      ...session,
      build: { status: "error", error: detail },
      workflowJob: { id: "build", status: "error", error: detail, phase: "生成失败" },
    };
    showBuildFailure(detail);
    render();
  }
}

async function startAnalysis(): Promise<void> {
  const language = document.querySelector<HTMLSelectElement>(".sidebar select")?.value ?? config?.defaultLanguage ?? "zh";
  clearCompletionNotice();
  try {
    if (applySessionUpdate(await api<AnalysisSessionView>("/__analysis/analyze", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language }),
    }))) render();
    startPolling();
  } catch (error) {
    session = { ...session, job: { id: "analyze", status: "error", error: error instanceof Error ? error.message : String(error) } };
    render();
  }
}

async function startReplication(): Promise<void> {
  activeTab = "create";
  clearCompletionNotice();
  if (!(await ensureReplicationReady(false))) return;
  setCreateActionPending("replicate", "正在发送一键复刻请求…");
  render();
  try {
    applySessionUpdate(await api<AnalysisSessionView>("/__analysis/replicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(replicateNotes ? { goal: replicateNotes } : {}),
        speechMode,
        videoAroll,
        formatId: "ugc",
        autoBuild: false,
      }),
    }));
    setCreateActionPending("replicate", "请求已提交，正在生成工程…");
    render();
    startPolling();
  } catch (error) {
    clearCreateActionPending();
    const detail = error instanceof Error ? error.message : String(error);
    session = { ...session, workflowJob: { id: "replicate", status: "error", error: detail } };
    showBuildFailure(detail);
    render();
  }
}

function stopPolling(): void {
  if (pollTimer === undefined) return;
  window.clearInterval(pollTimer);
  pollTimer = undefined;
}

function startPolling(): void {
  if (pollTimer !== undefined) return;
  pollTimer = window.setInterval(() => {
    void api<AnalysisSessionView>("/__analysis/session").then((next) => {
      const changed = applySessionUpdate(next);
      if (changed) render();
      if (!isSessionBusy(next)) stopPolling();
    }).catch(() => undefined);
  }, 2000);
}

void bootstrap();
