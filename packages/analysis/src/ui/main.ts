import type {
  AnalysisConfigView,
  AnalysisSessionView,
  OfficialPathCheckView,
} from "../shared.js";
import { formatTime } from "../shared.js";
import { isCliCheckInvocationError } from "../scaffold-check.js";

type TabId = "insight" | "plan" | "assets" | "build";

const app = document.querySelector<HTMLElement>("#app")!;
let config: AnalysisConfigView | undefined;
let session: AnalysisSessionView = { workspaceRoot: "." };
let activeTab: TabId = "insight";
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

function basename(path: string): string {
  return path.split(/[/\\]/u).pop() ?? path;
}

function workPanel(title: string, body: HTMLElement, hint?: string): HTMLElement {
  const panel = el("section", "work-panel");
  const head = el("header", "work-panel-head");
  head.append(el("h3", undefined, title));
  if (hint !== undefined && hint.length > 0) head.append(el("p", undefined, hint));
  body.classList.add("work-panel-body");
  panel.append(head, body);
  return panel;
}

function fileCaption(path: string): HTMLElement {
  const block = el("div", "file-caption");
  block.append(el("strong", undefined, basename(path)));
  const dir = path.replace(/[/\\][^/\\]+$/u, "");
  const sub = el("p", undefined, dir);
  sub.title = path;
  block.append(sub);
  return block;
}

function pathLine(path: string, className = "path-line"): HTMLElement {
  const line = el("p", className, path);
  line.title = path;
  return line;
}

function bindPlayerAspect(shell: HTMLElement, video: HTMLVideoElement): void {
  const apply = (): void => {
    if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
    shell.style.setProperty("--player-ar", `${video.videoWidth} / ${video.videoHeight}`);
    shell.style.setProperty("--arw", String(video.videoWidth));
    shell.style.setProperty("--arh", String(video.videoHeight));
  };
  video.addEventListener("loadedmetadata", apply);
  if (video.readyState >= 1) apply();
}

function filePick(options: {
  readonly accept: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onFile: (file: File) => void;
}): HTMLElement {
  const wrap = el("label", "file-pick");
  const input = document.createElement("input");
  input.type = "file";
  input.accept = options.accept;
  input.disabled = options.disabled === true;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file !== undefined) options.onFile(file);
  });
  wrap.append(el("span", "btn file-pick-btn", options.label), input);
  return wrap;
}

function render(): void {
  app.replaceChildren();
  const root = el("div", "app");
  root.append(renderTopbar());
  if (completionNotice !== undefined) root.append(renderCompletionBanner());
  root.append(renderLayout());
  app.append(root);
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
    view.addEventListener("click", () => { activeTab = "build"; render(); });
    actions.append(view);
  } else {
    const hasOutput = session.build?.outputVideoPath !== undefined;
    const view = el("button", "btn", hasOutput ? "查看成片" : "查看配音");
    view.addEventListener("click", () => {
      if (hasOutput) previewMode = "output";
      else activeTab = "assets";
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
  activeTab = "build";
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
    completionNotice = "改编配音已就绪。可在「素材」里试听口播，确认后再到「生成」一键复刻。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    activeTab = "assets";
  }
  const wasReplicating = session.workflowJob?.status === "running";
  const replicateDone = next.workflowJob?.status === "complete" && next.build?.status === "complete";
  if (wasReplicating && replicateDone) {
    completionNotice = "复刻完成。成片已切到中央播放器，可与参考片对比。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
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
    completionNotice = "复刻完成。成片已切到中央播放器，可与参考片对比。";
    completionNoticeDetail = undefined;
    completionNoticeIsError = false;
    previewMode = "output";
  }
  session = next;
  const forBuild = Boolean(next.scaffold);
  const nextReadinessKey = readinessKey(session, forBuild);
  if ((activeTab === "build" || next.productReferencePath !== undefined) && nextReadinessKey !== prevReadinessKey) {
    invalidateOfficialPathChecks();
    void refreshOfficialPathChecks(forBuild);
  }
  return sessionFingerprint(session) !== before || activeTab !== prevTab || completionNotice !== prevNotice;
}

function renderTopbar(): HTMLElement {
  const bar = el("header", "topbar");
  const lead = el("div", "topbar-lead");
  const brand = el("div", "brand");
  brand.innerHTML = "hypit <span>爆款复刻</span>";
  const meta = el("div", "topbar-meta");
  if (config === undefined) {
    meta.textContent = "加载中…";
  } else {
    const runtime = config.runtimeProfile?.split(/[/\\]/).pop() ?? "未选择 Runtime";
    meta.textContent = `${config.workspaceRoot.split(/[/\\]/).pop() ?? config.workspaceRoot} · ${runtime}`;
    meta.title = `${config.workspaceRoot} · ${config.runtimeProfile ?? ""}`;
  }
  lead.append(brand, meta);
  const actions = el("div", "topbar-actions");
  const analyzeBtn = el("button", "btn", "开始分析") as HTMLButtonElement;
  analyzeBtn.disabled = session.videoPath === undefined || session.job?.status === "running";
  analyzeBtn.addEventListener("click", () => void startAnalysis());
  const replicateBtn = el("button", "btn btn-primary", "一键复刻") as HTMLButtonElement;
  replicateBtn.disabled = session.analysisPath === undefined || session.workflowJob?.status === "running" || session.job?.status === "running";
  replicateBtn.addEventListener("click", () => void startReplication());
  const restoreBtn = el("button", "btn", "恢复上次");
  restoreBtn.addEventListener("click", () => void restoreSaved());
  actions.append(analyzeBtn, replicateBtn, restoreBtn);
  bar.append(lead, actions);
  return bar;
}

function renderLayout(): HTMLElement {
  const layout = el("main", "layout");
  layout.append(renderSidebar(), renderCenter(), renderInspector());
  return layout;
}

function renderSidebar(): HTMLElement {
  const sidebar = el("aside", "sidebar");
  sidebar.append(el("div", "panel-title", "完整工作流"));

  const analysisComplete = session.analysisPath !== undefined;
  const stepData = [
    { title: "参考片", detail: "导入并分析", done: analysisComplete },
    { title: "参考图与配音", detail: "产品图、改编说明、口播", done: session.productReferencePath !== undefined && session.adaptation?.status === "complete" },
    { title: "复刻工程", detail: "一键生成方案与脚手架", done: session.scaffold !== undefined },
    { title: "生成成片", detail: "提交生成并预览", done: session.build?.outputVideoPath !== undefined },
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
    const urlLine = el("p", "default-video-url", defaultVideoUrl);
    urlLine.title = defaultVideoUrl;
    defaultField.append(urlLine);
  } else {
    defaultField.append(el("p", "uploaded-name", "未配置。请先运行 pnpm upload:origin"));
  }
  sidebar.append(defaultField);

  const uploadField = el("div", "field");
  uploadField.append(
    el("label", undefined, "上传文件"),
    filePick({
      accept: "video/*,audio/*",
      label: session.videoName === undefined ? "选择视频文件" : "更换视频",
      disabled: session.job?.status === "running",
      onFile: (file) => { void uploadFile(file); },
    }),
  );
  if (session.videoName !== undefined) {
    uploadField.append(el("p", "uploaded-name", `已导入：${session.videoName}`));
  }
  sidebar.append(uploadField);

  const controls = el("div", "sidebar-controls");
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

  const formatField = el("div", "field");
  const formatSelect = document.createElement("select");
  const primaryFormat = session.formats?.[0]?.id ?? "ugc";
  for (const option of [
    { value: "", label: "自动（" + primaryFormat + "）" },
    { value: "ugc", label: "竖屏 UGC" },
    { value: "ranking", label: "榜单 Ranking" },
  ]) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    formatSelect.append(node);
  }
  formatSelect.value = formatOverride;
  formatSelect.addEventListener("change", () => { formatOverride = formatSelect.value; });
  formatField.append(el("label", undefined, "格式模板"), formatSelect);
  controls.append(langField, formatField);
  sidebar.append(controls);

  const statusHost = el("div", "sidebar-status");
  if (session.job?.status === "running") {
    statusHost.append(el("div", "status running", session.job.phase ?? "分析中…"));
  } else if (session.workflowJob?.status === "running") {
    statusHost.append(el("div", "status running", session.workflowJob.phase ?? "复刻中…"));
  } else if (session.job?.status === "error" && session.job.error) {
    statusHost.append(el("div", "status error", session.job.error));
  } else if (session.build?.status === "error") {
    const detail = sessionBuildFailureDetail(session);
    if (detail !== undefined) {
      statusHost.append(el("div", "status error", summarizeBuildFailure(detail)));
    }
  } else if (session.workflowJob?.status === "error" && session.workflowJob.error) {
    statusHost.append(el("div", "status error", summarizeBuildFailure(session.workflowJob.error)));
  } else if (session.build?.outputVideoPath) {
    statusHost.append(el("div", "status success", "复刻完成，可预览成片"));
  } else if (analysisComplete) {
    statusHost.append(el("div", "status success", `分析完成 · ${analysisSummary(session)}`));
  }
  if (statusHost.childElementCount > 0) sidebar.append(statusHost);

  if (config?.hasChatApiKey === false) {
    sidebar.append(el("div", "status", "提示：未检测到 OPENAI_API_KEY，爆款解读将基于转写与切镜数据自动生成。配置后可启用 LLM 深度润色。"));
  }

  return sidebar;
}

function renderCenter(): HTMLElement {
  const center = el("section", "center");
  const playerWrap = el("div", "player-wrap");
  const stage = el("div", "player-stage");
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
    bindPlayerAspect(shell, video);
    shell.append(video);
  }
  stage.append(shell);
  playerWrap.append(stage);
  center.append(playerWrap);

  if (session.probe !== undefined && !showingOutput) {
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

  return center;
}

function renderInspector(): HTMLElement {
  const inspector = el("aside", "inspector");
  const tabs = el("div", "tabs");
  const tabItems: { id: TabId; label: string }[] = [
    { id: "insight", label: "解读" },
    { id: "plan", label: "方案" },
    { id: "assets", label: "素材" },
    { id: "build", label: "生成" },
  ];
  for (const tab of tabItems) {
    const button = el("button", `tab${activeTab === tab.id ? " active" : ""}`, tab.label);
    button.addEventListener("click", () => { activeTab = tab.id; render(); });
    tabs.append(button);
  }
  inspector.append(tabs);
  const panel = el("div", "tab-panel");
  const renders: Record<TabId, () => HTMLElement> = {
    insight: renderInsight,
    plan: renderPlan,
    assets: renderAssets,
    build: renderBuild,
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
  const wrap = el("div", "tab-stack");
  const archive = session.referenceArchive;
  if (!session.analysisPath) {
    wrap.append(el("div", "card", "先分析参考片，才能抽出画面对照。"));
    return wrap;
  }
  if (archive === undefined) {
    const card = el("div", "card");
    card.append(el("p", undefined, "这里会放出参考片的关键画面，以及每一段在讲什么。看方案时用来对照。"));
    const btn = el("button", "btn btn-primary", "生成画面对照");
    btn.addEventListener("click", () => void (async () => {
      applySessionUpdate(await api<AnalysisSessionView>("/__analysis/reference-archive", { method: "POST" }));
      activeTab = "plan";
      render();
    })());
    card.append(btn);
    wrap.append(moduleBlock("对照参考片", card));
    return wrap;
  }
  const evidence = el("div", "card");
  const grid = el("div", "evidence-grid");
  for (const path of archive.evidencePaths.slice(0, 12)) {
    const img = document.createElement("img");
    img.src = mediaUrl(path) ?? "";
    img.alt = path.split(/[/\\]/u).pop() ?? "evidence";
    img.loading = "lazy";
    grid.append(img);
  }
  evidence.append(grid);
  wrap.append(moduleBlock("参考画面", evidence));
  void loadMarkdown(archive.timelineMarkdownPath).then((markdown) => {
    if (markdown === undefined || !wrap.isConnected) return;
    const doc = el("div", "card");
    doc.append(el("pre", "doc-preview doc-scroll", markdown));
    wrap.append(moduleBlock("每一段在讲什么", doc));
  });
  return wrap;
}

function moduleBlock(title: string, ...nodes: HTMLElement[]): HTMLElement {
  const block = el("section", "module");
  block.append(el("h3", "module-title", title));
  const body = el("div", "module-body");
  body.append(...nodes);
  block.append(body);
  return block;
}

function insightGrid(items: readonly { readonly title: string; readonly detail: string }[]): HTMLElement {
  const grid = el("div", "insight-grid");
  for (const item of items) {
    const card = el("article", "card");
    const detail = el("p", "insight-detail", item.detail);
    detail.title = item.detail;
    card.append(el("h4", undefined, item.title), detail);
    grid.append(card);
  }
  return grid;
}

function renderInsight(): HTMLElement {
  const wrap = el("div", "tab-stack");
  if (!session.insight) {
    const card = el("div", "card");
    if (!session.analysisPath) {
      card.append(el("p", undefined, "请先完成媒体分析。"));
    } else if (session.job?.status === "running") {
      card.append(el("div", "status running", session.job.phase ?? "正在生成爆款解读…"));
      card.append(el("p", undefined, "请稍候，完成后内容会自动显示。"));
    } else {
      card.append(el("p", undefined, "分析已完成，但爆款解读尚未生成。点击下方按钮生成（通常需 10–30 秒）。"));
      const btn = el("button", "btn btn-primary", "生成爆款解读") as HTMLButtonElement;
      btn.addEventListener("click", () => {
        btn.disabled = true;
        btn.textContent = "生成中…";
        void runStep("/__analysis/interpret").finally(() => {
          btn.disabled = false;
          btn.textContent = "生成爆款解读";
        });
      });
      card.append(btn);
    }
    wrap.append(card);
    return wrap;
  }
  const insight = session.insight;
  wrap.append(el("div", "card card-highlight insight-lead", insight.summary));
  wrap.append(moduleBlock("为什么会火", insightGrid(insight.whyViral)));
  wrap.append(moduleBlock("片子怎么讲", insightGrid(insight.howItWorks)));
  const hook = el("div", "card");
  hook.append(el("p", "insight-detail", insight.hookAnalysis));
  wrap.append(moduleBlock("开头三秒", hook));
  const tips = el("div", "card");
  const list = document.createElement("ul");
  for (const tip of insight.replicationTips) {
    const li = document.createElement("li");
    li.textContent = tip;
    list.append(li);
  }
  tips.append(list);
  wrap.append(moduleBlock("复刻时要守住", tips));
  return wrap;
}

function renderPlan(): HTMLElement {
  const wrap = el("div", "tab-stack");
  if (!session.brief) {
    const card = el("div", "card");
    card.append(el("p", undefined, "这里写清这次要拍什么、每一段怎么拍。一键复刻时会自动写好，也可以现在先生成。"));
    const btn = el("button", "btn btn-primary", "生成方案");
    btn.addEventListener("click", () => void runStep("/__analysis/brief", replicateNotes ? { goal: replicateNotes } : {}));
    card.append(btn);
    wrap.append(card);
  } else {
    const briefCard = el("div", "card");
    briefCard.append(el("pre", "doc-preview doc-scroll", session.brief.markdown));
    wrap.append(moduleBlock("这次要拍什么", briefCard));
    if (session.treatment) {
      const treatmentCard = el("div", "card");
      treatmentCard.append(el("pre", "doc-preview doc-scroll", session.treatment.markdown));
      wrap.append(moduleBlock("每一段怎么拍", treatmentCard));
    }
  }
  if (session.scaffold) {
    const dirCard = el("div", "card");
    dirCard.append(el("p", undefined, "工程已经生成，视频会写进这个目录。"), pathLine(session.scaffold.productionDir));
    wrap.append(moduleBlock("成片目录", dirCard));
  }
  wrap.append(renderTimelineDoc());
  return wrap;
}

function renderReferenceField(): HTMLElement {
  const row = el("div", "asset-row");
  const frame = el("div", "media-frame");
  if (session.productReferencePath !== undefined) {
    const previewUrl = mediaUrl(session.productReferencePath);
    if (previewUrl !== undefined) {
      const preview = document.createElement("img");
      preview.src = previewUrl;
      preview.alt = session.productReferenceName ?? "产品图";
      frame.append(preview);
    }
  } else {
    frame.append(el("span", "media-frame-empty", "未上传"));
  }
  const copy = el("div", "asset-copy");
  if (referenceUploading) {
    copy.append(el("div", "status running", "上传中…"));
  } else if (referenceUploadError !== undefined) {
    copy.append(el("div", "status error", referenceUploadError));
  }
  if (session.productReferencePath !== undefined) {
    const name = el("strong", undefined, session.productReferenceName ?? "产品图");
    name.title = session.productReferenceName ?? "";
    copy.append(name);
    copy.append(el("p", undefined, "jpg、png、webp、gif、avif"));
  } else {
    copy.append(el("strong", undefined, "还没有产品图"));
    copy.append(el("p", undefined, "口播画面需要一张产品或人物图。"));
  }
  copy.append(filePick({
    accept: ".jpg,.jpeg,.png,.webp,.gif,.avif,image/jpeg,image/png,image/webp,image/gif,image/avif",
    label: referenceUploading ? "上传中…" : session.productReferencePath === undefined ? "选择图片" : "更换图片",
    disabled: referenceUploading,
    onFile: (file) => { void uploadReferenceFile(file); },
  }));
  row.append(frame, copy);
  return row;
}

function renderAdaptationField(): HTMLElement {
  const adaptField = el("div", "field");
  if (session.productReferencePath === undefined) {
    adaptField.append(el("p", undefined, "请先上传参考图；分析完成后将自动制作配音。"));
  } else {
    const adapt = session.adaptation;
    if (adapt?.status === "running") {
      adaptField.append(el("div", "status running", adapt.phase ?? "制作配音中…"));
    } else if (adapt?.status === "complete" && adapt.generatedSpeechPath !== undefined) {
      const audioUrl = mediaUrl(adapt.generatedSpeechPath);
      const audioPreview = renderMediaPreview(audioUrl, "audio");
      if (audioPreview !== undefined) {
        const well = el("div", "audio-well");
        well.append(audioPreview);
        adaptField.append(well);
      }
      const scriptCard = el("div", "script-well");
      scriptCard.append(el("strong", undefined, "口播文案"));
      const scenesPath = adapt.adaptedScenesPath;
      if (scenesPath === undefined) {
        scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
      } else if (adaptedScriptCache.has(scenesPath)) {
        const script = adaptedScriptCache.get(scenesPath);
        if (script === undefined) {
          scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
        } else {
          scriptCard.append(el("pre", "script-text", script));
        }
      } else {
        scriptCard.append(el("p", "adapted-script-loading", "加载口播文案…"));
        void loadAdaptedScript(scenesPath).then((script) => {
          if (!scriptCard.isConnected) return;
          scriptCard.replaceChildren(el("strong", undefined, "口播文案"));
          if (script === undefined) {
            scriptCard.append(el("p", undefined, "口播文案暂不可用。"));
          } else {
            scriptCard.append(el("pre", "script-text", script));
          }
        });
      }
      adaptField.append(scriptCard);
      const actions = el("div", "panel-actions");
      const preview = el("button", "btn", "新窗口试听");
      preview.addEventListener("click", () => {
        window.open(audioUrl, "_blank");
      });
      const retry = el("button", "btn", "重新制作");
      retry.addEventListener("click", () => void prepareAdaptation());
      actions.append(preview, retry);
      adaptField.append(actions);
    } else if (adapt?.status === "error") {
      adaptField.append(el("div", "status error", adapt.error ?? "配音制作失败"));
      const retry = el("button", "btn", "重试制作配音");
      retry.addEventListener("click", () => void prepareAdaptation());
      adaptField.append(retry);
    } else if (session.analysisPath !== undefined) {
      adaptField.append(el("p", undefined, "等待自动制作配音…"));
      const retry = el("button", "btn", "开始制作配音");
      retry.addEventListener("click", () => void prepareAdaptation());
      adaptField.append(retry);
    } else {
      adaptField.append(el("p", undefined, "完成参考视频分析后自动制作配音。"));
    }
  }
  return adaptField;
}

function renderOfficialPathChecklist(): HTMLElement {
  const body = el("div");
  if (officialPathChecks === undefined) {
    body.append(el("p", undefined, "正在核对出片条件…"));
    void refreshOfficialPathChecks(Boolean(session.scaffold));
    return body;
  }
  const list = document.createElement("ul");
  list.className = "check-list";
  for (const check of officialPathChecks) {
    const item = document.createElement("li");
    item.className = check.ok ? "ok" : "pending";
    const mark = el("span", "check-mark", check.ok ? "✓" : "");
    const text = el("div", "check-copy");
    text.append(el("strong", undefined, check.label), el("p", undefined, check.detail));
    item.append(mark, text);
    item.title = `${check.label} — ${check.detail}`;
    list.append(item);
  }
  body.append(list);
  body.append(el(
    "p",
    "check-foot",
    officialPathReady === true ? "条件已齐，可以出片。" : "还有未完成项，补齐后再出片。",
  ));
  return body;
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
    if (activeTab === "build" && before !== after) render();
  } catch {
    if (token !== readinessRefreshToken) return;
    invalidateOfficialPathChecks();
  }
}

function renderNotesField(): HTMLElement {
  const notesInput = document.createElement("textarea");
  notesInput.rows = 3;
  notesInput.placeholder = "产品名称、核心卖点、目标人群";
  notesInput.value = replicateNotes;
  notesInput.addEventListener("input", () => {
    replicateNotes = notesInput.value;
    void persistAdaptationGoal(replicateNotes);
  });
  return notesInput;
}

function renderVideoArollField(): HTMLElement {
  const row = el("label", "switch-row");
  const copy = el("span", "switch-copy");
  copy.append(el("strong", undefined, "用产品图和音色生成口播画面"));
  copy.append(el("small", undefined, session.productReferencePath === undefined ? "先上传产品图" : "关闭后只保留配音，不生成口播画面"));
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "switch";
  toggle.checked = videoAroll;
  toggle.disabled = session.productReferencePath === undefined;
  toggle.addEventListener("change", () => {
    videoAroll = toggle.checked;
    session = { ...session, videoAroll };
  });
  row.append(copy, toggle);
  return row;
}

function renderAssets(): HTMLElement {
  const wrap = el("div", "tab-stack");
  if (!session.analysisPath) {
    wrap.append(el("div", "card", "请先完成媒体分析，再上传产品图和制作配音。"));
    return wrap;
  }
  const image = el("div");
  image.append(renderReferenceField());
  wrap.append(workPanel("产品图", image));
  const voice = el("div");
  voice.append(renderAdaptationField());
  const voiceHint = session.adaptation?.status === "complete" ? "已就绪" : undefined;
  wrap.append(workPanel("口播", voice, voiceHint));
  const notes = el("div");
  notes.append(renderNotesField(), renderVideoArollField());
  wrap.append(workPanel("你的产品", notes, "用来改写口播"));
  return wrap;
}

function renderBuild(): HTMLElement {
  const wrap = el("div", "tab-stack");
  if (!session.analysisPath) {
    const card = el("div", "card");
    card.append(el("p", undefined, "请先完成媒体分析。"));
    wrap.append(card);
    return wrap;
  }

  if (session.build?.outputVideoPath !== undefined) {
    const done = el("div");
    done.append(
      el("p", undefined, "正在中间播放器里播放，可切回参考片对比。"),
      fileCaption(session.build.outputVideoPath),
    );
    wrap.append(workPanel("成片", done));
  }
  const checks = renderOfficialPathChecklist();
  const readyCount = officialPathChecks?.filter((check) => check.ok).length;
  const checkHint = officialPathChecks === undefined || readyCount === undefined
    ? undefined
    : `${readyCount}/${officialPathChecks.length}`;
  wrap.append(workPanel(officialPathReady === true ? "已经齐了" : "还缺什么", checks, checkHint));

  const card = el("div");
  const extras: HTMLElement[] = [];
  if (!session.scaffold) {
    card.append(el("p", undefined, "产品图和口播在「素材」里准备好之后，先生成工程，再开始出片。"));
    if (session.productReferencePath === undefined) {
      card.append(el("p", undefined, "还缺产品图。"));
    } else {
      const adapt = session.adaptation;
      if (adapt?.status === "complete") {
        card.append(el("p", undefined, "产品图和口播已就绪。"));
      } else if (adapt?.status === "running") {
        card.append(el("div", "status running", adapt.phase ?? "配音制作中，请稍候…"));
      } else {
        card.append(el("p", undefined, "请先到「素材」里听完口播。"));
      }
    }
    const btn = el("button", "btn btn-primary btn-block", "一键复刻") as HTMLButtonElement;
    btn.disabled = officialPathReady === false || session.workflowJob?.status === "running";
    btn.addEventListener("click", () => void startReplication());
    card.append(btn);
    wrap.append(workPanel("出片", card));
    return wrap;
  }
  card.append(fileCaption(session.scaffold.productionDir));
  if (session.scaffold.runPath.length > 0) card.append(fileCaption(session.scaffold.runPath));
  if (session.scaffold.checkOk === false && !isCliCheckInvocationError(session.scaffold.checkSummary)) {
    card.append(el("div", "status error", `工程校验：${session.scaffold.checkSummary ?? "未通过"}`));
  } else if (
    session.scaffold.checkSummary !== undefined
    && session.scaffold.checkSummary.length > 0
    && !isCliCheckInvocationError(session.scaffold.checkSummary)
  ) {
    card.append(el("p", "build-meta", `校验：${session.scaffold.checkSummary.split("\n")[0]}`));
  }
  if (session.build?.status === "planning" || session.build?.status === "building") {
    extras.push(el("div", "status running", session.build.phase ?? "生成中…"));
    if (session.build.id !== undefined) {
      extras.push(el("p", "build-meta", `Build ID：${session.build.id}`));
    }
  }
  const failureDetail = session.build?.status === "error" ? sessionBuildFailureDetail(session) : undefined;
  if (failureDetail !== undefined) {
    extras.push(renderFailureCard(summarizeBuildFailure(failureDetail), failureDetail));
  }
  const buildBusy = session.build?.status === "planning" || session.build?.status === "building";
  if (!buildBusy && session.build?.status !== "complete") {
    const btn = el("button", "btn btn-primary btn-block", failureDetail === undefined ? "开始生成视频" : "重试生成视频");
    btn.disabled = session.workflowJob?.status === "running";
    btn.addEventListener("click", () => void runBuild());
    card.append(btn);
  }
  card.append(...extras);
  wrap.append(workPanel("工程", card));
  return wrap;
}

function seekTo(time: number): void {
  currentTime = time;
  const video = document.querySelector<HTMLVideoElement>(".player-shell video");
  if (video !== null) video.currentTime = time;
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
  } else if (session.build?.status === "error") {
    const detail = sessionBuildFailureDetail(session);
    if (detail !== undefined) showBuildFailure(detail);
    activeTab = "build";
  }
  if (session.videoAroll !== undefined) {
    videoAroll = session.videoAroll;
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
  const readiness = await api<{ ok: boolean; issues: string[] }>(
    `/__analysis/readiness${forBuild ? "?forBuild=1" : ""}`,
  );
  if (!readiness.ok) {
    showBuildFailure(readiness.issues.join("\n"));
    render();
    return false;
  }
  return true;
}

async function uploadReferenceFile(file: File): Promise<void> {
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
  }
  render();
}

async function runBuild(): Promise<void> {
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
  try {
    if (applySessionUpdate(await api<AnalysisSessionView>("/__analysis/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }))) render();
    startPolling();
  } catch (error) {
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
  clearCompletionNotice();
  activeTab = "build";
  if (!(await ensureReplicationReady(false))) return;
  try {
    applySessionUpdate(await api<AnalysisSessionView>("/__analysis/replicate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(replicateNotes ? { goal: replicateNotes } : {}),
        ...(formatOverride ? { formatId: formatOverride } : {}),
        speechMode,
        videoAroll,
        autoBuild: false,
      }),
    }));
    activeTab = "build";
    render();
    startPolling();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    session = { ...session, workflowJob: { id: "replicate", status: "error", error: detail } };
    showBuildFailure(detail);
    render();
  }
}

async function runStep(path: string, body: Record<string, unknown> = {}): Promise<void> {
  try {
    if (applySessionUpdate(await api<AnalysisSessionView>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }))) render();
    startPolling();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    session = { ...session, workflowJob: { id: "step", status: "error", error: detail } };
    if (path === "/__analysis/build") showBuildFailure(detail);
    render();
  }
}

async function restoreSaved(): Promise<void> {
  session = await api<AnalysisSessionView>("/__analysis/restore");
  if (session.build?.outputVideoPath) previewMode = "output";
  render();
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
