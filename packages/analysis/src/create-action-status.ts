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
  },
): CreateActionStatus {
  const failureDetail = sessionFailureDetail(session);
  if (session.build?.status === "error" && failureDetail !== undefined) {
    return { tone: "error", headline: "视频生成失败", detail: failureDetail };
  }
  if (session.workflowJob?.status === "error" && failureDetail !== undefined) {
    const headline = session.scaffold === undefined ? "复刻失败" : "生成失败";
    return { tone: "error", headline, detail: failureDetail };
  }

  const pending = options?.pending;
  if (pending !== undefined) {
    return { tone: "running", headline: pending.phase };
  }

  if (session.workflowJob?.status === "running") {
    return { tone: "running", headline: session.workflowJob.phase ?? "复刻进行中…" };
  }
  if (session.build?.status === "planning" || session.build?.status === "building") {
    return { tone: "running", headline: session.build.phase ?? "视频生成中…" };
  }

  if (session.build?.status === "complete" && session.build.outputVideoPath !== undefined) {
    return { tone: "success", headline: "成片已生成，可在中间播放器预览，或点上方「参考片 / 成片」切换。" };
  }

  if (session.scaffold !== undefined) {
    return { tone: "hint", headline: "制作项目已就绪，点击下方「开始生成视频」。" };
  }

  return { tone: "hint", headline: "完成参考图与改编配音后，点击下方「一键复刻」。" };
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
