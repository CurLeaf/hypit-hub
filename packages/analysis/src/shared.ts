export type MediaProbeView = {
  readonly duration: number;
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  readonly hasAudio: boolean;
};

export type TranscriptWordView = {
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
};

export type TranscriptPassageView = {
  readonly text: string;
  readonly start?: number;
  readonly end?: number;
  readonly words: readonly TranscriptWordView[];
};

export type VisualBoundaryView = {
  readonly at: number;
  readonly score: number;
};

export type SpeechSegmentView = {
  readonly id: string;
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly wordCount: number;
};

export type StructureEventView = {
  readonly id: string;
  readonly kind: "hook" | "segment" | "visual-cut" | "moment";
  readonly at: number;
  readonly end?: number;
  readonly title: string;
  readonly detail: string;
};

export type FormatSuggestionView = {
  readonly id: string;
  readonly title: string;
  readonly confidence: "high" | "medium" | "low";
  readonly reason: string;
  readonly example: string;
};

export type AnalysisJobStatus = "idle" | "running" | "complete" | "error";

export type AnalysisJobView = {
  readonly id: string;
  readonly status: AnalysisJobStatus;
  readonly phase?: string;
  readonly error?: string;
};

export type ViralInsightView = {
  readonly summary: string;
  readonly whyViral: readonly { readonly title: string; readonly detail: string }[];
  readonly howItWorks: readonly { readonly title: string; readonly detail: string }[];
  readonly hookAnalysis: string;
  readonly replicationTips: readonly string[];
  readonly path?: string;
};

export type BriefView = {
  readonly markdown: string;
  readonly path?: string;
};

export type TreatmentView = {
  readonly markdown: string;
  readonly path?: string;
};

export type ScaffoldView = {
  readonly productionDir: string;
  readonly runPath: string;
  readonly authorPath: string;
  readonly formatId: string;
  readonly runName?: string;
  readonly checkOk?: boolean;
  readonly checkSummary?: string;
};

export type DirectorReviewStatus = "pending" | "approved";

export type DirectorAgentStatus = "idle" | "running" | "complete" | "error";

export type DirectorAgentView = {
  readonly provider: "cursor";
  readonly status: DirectorAgentStatus;
  readonly phase?: string;
  readonly error?: string;
  readonly runId?: string;
  readonly agentId?: string;
  readonly finishedAt?: number;
};

export type DirectorReviewView = {
  readonly status: DirectorReviewStatus;
  readonly phase?: string;
  readonly dir: string;
  readonly requestPath: string;
  readonly briefPath: string;
  readonly treatmentPath: string;
  readonly scenesPath: string;
  readonly checklistPath: string;
  readonly approvedAt?: number;
  /** 审查通过时绑定的改编说明，用于判断 goal 变更是否需要失效配音产物 */
  readonly adaptationGoal?: string;
  readonly agent?: DirectorAgentView;
};

export type AdaptationView = {
  readonly status: "idle" | "running" | "complete" | "error";
  readonly phase?: string;
  readonly error?: string;
  readonly dir?: string;
  readonly generatedSpeechPath?: string;
  readonly voiceReferencePath?: string;
  readonly productReferencePath?: string;
  readonly productReferenceSource?: string;
  readonly briefPath?: string;
  readonly treatmentPath?: string;
  readonly adaptedScenesPath?: string;
};

export type BuildJobView = {
  readonly id?: string;
  readonly status: "idle" | "planning" | "building" | "complete" | "error";
  readonly phase?: string;
  readonly error?: string;
  readonly outputVideoPath?: string;
};

export type ReferenceArchiveView = {
  readonly referenceDir: string;
  readonly analysisMarkdownPath: string;
  readonly timelineMarkdownPath: string;
  readonly progressMarkdownPath: string;
  readonly evidenceDir: string;
  readonly evidencePaths: readonly string[];
};

export type AnalysisSessionView = {
  readonly workspaceRoot: string;
  readonly runtimeProfile?: string;
  readonly videoPath?: string;
  readonly videoName?: string;
  readonly videoUrl?: string;
  readonly productReferencePath?: string;
  readonly productReferenceName?: string;
  readonly videoAroll?: boolean;
  readonly probe?: MediaProbeView;
  readonly transcript?: {
    readonly language: string;
    readonly passages: readonly TranscriptPassageView[];
    readonly words: readonly TranscriptWordView[];
    readonly path?: string;
  };
  readonly boundaries?: readonly VisualBoundaryView[];
  readonly segments?: readonly SpeechSegmentView[];
  readonly events?: readonly StructureEventView[];
  readonly formats?: readonly FormatSuggestionView[];
  readonly tilePath?: string;
  readonly referenceArchive?: ReferenceArchiveView;
  readonly analysisPath?: string;
  readonly job?: AnalysisJobView;
  readonly workflowJob?: AnalysisJobView;
  readonly insight?: ViralInsightView;
  readonly brief?: BriefView;
  readonly treatment?: TreatmentView;
  readonly scaffold?: ScaffoldView;
  readonly build?: BuildJobView;
  readonly adaptation?: AdaptationView;
  readonly adaptationGoal?: string;
  readonly directorReview?: DirectorReviewView;
};

export type OfficialPathCheckView = {
  readonly id: string;
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type OfficialPathReportView = {
  readonly ok: boolean;
  readonly checks: readonly OfficialPathCheckView[];
};

export type DirectorAgentConfigView = {
  readonly provider: "cursor" | "manual";
  readonly auto: boolean;
  readonly available: boolean;
  readonly model: string;
  readonly missing?: string;
};

export type AnalysisConfigView = {
  readonly workspaceRoot: string;
  readonly runtimeProfile?: string;
  readonly defaultLanguage: "zh" | "en" | "es";
  readonly chatModel?: string;
  readonly ttsModel?: string;
  readonly ttsVoice?: string;
  readonly hasChatApiKey?: boolean;
  readonly hasH3ApiKey?: boolean;
  readonly defaultVideoUrl?: string;
  readonly defaultVideoName?: string;
  readonly directorAgent?: DirectorAgentConfigView;
};

export function formatTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const minutes = Math.floor(clamped / 60);
  const rest = clamped - minutes * 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}:${String(mins).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
  }
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}
