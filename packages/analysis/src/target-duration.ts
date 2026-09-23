import { H3_MIN_SECONDS, planShotDurations, SHOT_MAX_SECONDS } from "./shot-plan.js";
import type { AdaptationView, AnalysisSessionView } from "./shared.js";

export const MIN_TARGET_DURATION_SECONDS = H3_MIN_SECONDS;
export const MAX_TARGET_DURATION_SECONDS = 180;

export function clampTargetDurationSeconds(value: number, fallback: number): number {
  const resolved = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(MAX_TARGET_DURATION_SECONDS, Math.max(MIN_TARGET_DURATION_SECONDS, resolved));
}

export function defaultTargetDurationSeconds(session: AnalysisSessionView): number {
  const probeDuration = session.probe?.duration;
  if (probeDuration !== undefined && probeDuration > 0) {
    return clampTargetDurationSeconds(Math.ceil(probeDuration), MIN_TARGET_DURATION_SECONDS);
  }
  return SHOT_MAX_SECONDS;
}

export function resolveTargetDurationSeconds(session: AnalysisSessionView): number {
  if (session.targetDurationSeconds !== undefined && session.targetDurationSeconds > 0) {
    return clampTargetDurationSeconds(
      session.targetDurationSeconds,
      defaultTargetDurationSeconds(session),
    );
  }
  return defaultTargetDurationSeconds(session);
}

/** Prefer measured TTS duration, then user target, then reference probe. */
export function resolveH3ReferenceDuration(input: {
  readonly session: AnalysisSessionView;
  readonly adaptation?: AdaptationView;
}): number {
  const fromAudio = input.adaptation?.generatedSpeechDurationSeconds;
  if (fromAudio !== undefined && fromAudio > 0) return Math.ceil(fromAudio);
  return resolveTargetDurationSeconds(input.session);
}

export function planH3TakeDurations(totalSeconds: number): readonly number[] {
  return planShotDurations(totalSeconds);
}

export function formatH3TakePlan(durations: readonly number[]): string {
  if (durations.length === 0) return "";
  const total = durations.reduce((sum, seconds) => sum + seconds, 0);
  return `${durations.map((seconds) => `${seconds}s`).join(" + ")}（共 ${durations.length} 镜，合计 ${total}s）`;
}
