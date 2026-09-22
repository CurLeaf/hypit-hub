import type { AnalysisSessionView } from "./shared.js";

export type CreateActionPending = {
  readonly kind: "replicate" | "build" | "readiness";
  readonly phase: string;
};

export type CreateActionTone = "hint" | "running" | "error" | "success";

export type CreateActionStatus = {
  readonly tone: CreateActionTone;
  readonly headline: string;
  readonly detail?: string;
};

function sessionFailureDetail(session: AnalysisSessionView): string | undefined {
  if (session.build?.error !== undefined && session.build.error.length > 0) return session.build.error;
  if (session.workflowJob?.error !== undefined && session.workflowJob.error.length > 0) return session.workflowJob.error;
  return undefined;
}

export function resolveCreateActionStatus(
  session: AnalysisSessionView,
  options?: {
    readonly pending?: CreateActionPending;
    readonly officialPathReady?: boolean;
  },
): CreateActionStatus {
  const pending = options?.pending;
  if (pending !== undefined) {
    return { tone: "running", headline: pending.phase };
  }

  const failureDetail = sessionFailureDetail(session);
  if (session.build?.status === "error" && failureDetail !== undefined) {
    return { tone: "error", headline: "视频生成失败", detail: failureDetail };
  }
  if (session.workflowJob?.status === "error" && failureDetail !== undefined) {
    const headline = session.scaffold === undefined ? "复刻失败" : "生成失败";
    return { tone: "error", headline, detail: failureDetail };
  }

  if (session.workflowJob?.status === "running") {
    return { tone: "running", headline: session.workflowJob.phase ?? "复刻进行中…" };
  }
  if (session.build?.status === "planning" || session.build?.status === "building") {
    return { tone: "running", headline: session.build.phase ?? "视频生成中…" };
  }

  if (session.build?.status === "complete" && session.build.outputVideoPath !== undefined) {
    return { tone: "success", headline: "成片已生成，请切换到「成片」标签预览。" };
  }

  if (session.scaffold !== undefined) {
    return { tone: "hint", headline: "工程已生成，点击下方「开始生成视频」提交 Build。" };
  }

  if (options?.officialPathReady === true) {
    return { tone: "hint", headline: "检查已通过，点击下方「一键复刻」生成工程。" };
  }

  if (options?.officialPathReady === false) {
    return { tone: "hint", headline: "请先补齐上方检查项，再执行复刻。" };
  }

  return { tone: "hint", headline: "正在加载复刻状态…" };
}

export function officialPathCheckHint(
  session: AnalysisSessionView,
  officialPathReady: boolean | undefined,
): string {
  if (officialPathReady !== true) {
    return "请补齐上述未完成项。官方路径需要：LLM 解读/改写 + TTS 试听/音色样本 + H3 口播成片 + 参考图 edits。";
  }
  if (session.scaffold !== undefined) {
    return "检查已通过。工程已生成，请点击下方「开始生成视频」。";
  }
  return "已通过官方路径检查，可点击「一键复刻」。";
}

export function isReplicateActionBusy(
  session: AnalysisSessionView,
  pending?: CreateActionPending,
): boolean {
  if (pending !== undefined && pending.kind !== "build") return true;
  return session.workflowJob?.status === "running" && session.scaffold === undefined;
}

export function isBuildActionBusy(
  session: AnalysisSessionView,
  pending?: CreateActionPending,
): boolean {
  if (pending?.kind === "build") return true;
  if (pending?.kind === "readiness" && session.scaffold !== undefined) return true;
  if (session.build?.status === "planning" || session.build?.status === "building") return true;
  return session.workflowJob?.status === "running" && session.scaffold !== undefined;
}
