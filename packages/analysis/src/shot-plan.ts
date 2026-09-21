import type { ScenePlan } from "./scene-plan.js";

export const SHOT_MAX_SECONDS = 15;
export const H3_MIN_SECONDS = 4;
export const DURATION_TOLERANCE_SECONDS = 5;

export type ShotPlan = {
  readonly id: string;
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly durationSeconds: number;
  readonly text: string;
  readonly scenePromptHint: string;
  readonly scenes: readonly ScenePlan[];
};

/**
 * Split a reference timeline into H3-sized shots (4–15s each) whose total
 * length stays within ±5s of the reference duration.
 */
export function planShotDurations(referenceDuration: number): readonly number[] {
  const target = Math.max(H3_MIN_SECONDS, Math.ceil(referenceDuration));
  if (target <= SHOT_MAX_SECONDS) {
    return [Math.min(SHOT_MAX_SECONDS, Math.max(H3_MIN_SECONDS, target))];
  }

  const shots: number[] = [];
  let remaining = target;
  while (remaining > 0) {
    if (remaining <= SHOT_MAX_SECONDS) {
      if (remaining >= H3_MIN_SECONDS) {
        shots.push(remaining);
      } else if (shots.length > 0) {
        const prev = shots[shots.length - 1]!;
        const combined = prev + remaining;
        shots[shots.length - 1] = combined <= SHOT_MAX_SECONDS ? combined : prev;
        if (combined > SHOT_MAX_SECONDS) shots.push(H3_MIN_SECONDS);
      } else {
        shots.push(H3_MIN_SECONDS);
      }
      remaining = 0;
    } else if (remaining <= SHOT_MAX_SECONDS + H3_MIN_SECONDS) {
      const tail = remaining - SHOT_MAX_SECONDS;
      shots.push(tail >= H3_MIN_SECONDS ? SHOT_MAX_SECONDS : SHOT_MAX_SECONDS);
      if (tail >= H3_MIN_SECONDS) shots.push(tail);
      remaining = 0;
    } else {
      shots.push(SHOT_MAX_SECONDS);
      remaining -= SHOT_MAX_SECONDS;
    }
  }

  const total = shots.reduce((sum, seconds) => sum + seconds, 0);
  const drift = target - total;
  if (Math.abs(drift) > DURATION_TOLERANCE_SECONDS && shots.length > 0) {
    const lastIndex = shots.length - 1;
    const last = shots[lastIndex]!;
    shots[lastIndex] = Math.min(SHOT_MAX_SECONDS, Math.max(H3_MIN_SECONDS, last + drift));
  }
  return shots;
}

function referenceWindowForShot(
  referenceDuration: number,
  outputStart: number,
  outputEnd: number,
  totalOutputSeconds: number,
): { readonly start: number; readonly end: number } {
  if (totalOutputSeconds <= 0) {
    return { start: 0, end: referenceDuration };
  }
  return {
    start: referenceDuration * (outputStart / totalOutputSeconds),
    end: referenceDuration * (outputEnd / totalOutputSeconds),
  };
}

function dedupeScenes(scenes: readonly ScenePlan[]): readonly ScenePlan[] {
  const seen = new Set<string>();
  const result: ScenePlan[] = [];
  for (const scene of scenes) {
    if (seen.has(scene.momentId)) continue;
    seen.add(scene.momentId);
    result.push(scene);
  }
  return result;
}

function mergeScenePromptHints(prompts: readonly string[]): string {
  const unique = [...new Set(prompts.map((prompt) => prompt.trim()).filter((prompt) => prompt.length > 0))];
  if (unique.length === 0) {
    return "Vertical 9:16 short-form social product video, natural UGC pacing, no on-screen text.";
  }
  if (unique.length === 1) return unique[0]!;
  return unique.slice(0, 3).join(" Alternate beat: ");
}

export function groupScenesIntoShots(
  scenes: readonly ScenePlan[],
  referenceDuration: number,
): readonly ShotPlan[] {
  const speaking = scenes.filter((scene) => scene.text.replace(/\s+/gu, "").length > 0);
  const durations = planShotDurations(referenceDuration);
  const totalOutputSeconds = durations.reduce((sum, seconds) => sum + seconds, 0);
  const refDuration = Math.max(referenceDuration, H3_MIN_SECONDS);
  const baseShots: ShotPlan[] = [];
  let outputCursor = 0;
  const assignedSceneIds = new Set<string>();

  for (const [index, durationSeconds] of durations.entries()) {
    const outputStart = outputCursor;
    const outputEnd = outputCursor + durationSeconds;
    const refWindow = referenceWindowForShot(refDuration, outputStart, outputEnd, totalOutputSeconds);
    const overlapping = speaking.filter((scene) => scene.start < refWindow.end && scene.end > refWindow.start);
    const isLast = index === durations.length - 1;
    const scenesForShot = dedupeScenes(isLast
      ? [...overlapping, ...speaking.filter((scene) => !assignedSceneIds.has(scene.momentId))]
      : overlapping);
    for (const scene of scenesForShot) assignedSceneIds.add(scene.momentId);

    const text = scenesForShot.map((scene) => scene.text.replace(/\s+/gu, "")).filter(Boolean).join("");
    const scenePromptHint = mergeScenePromptHints(scenesForShot.map((scene) => scene.prompt));
    baseShots.push({
      id: `shot_${index + 1}`,
      index,
      start: outputStart,
      end: outputEnd,
      durationSeconds,
      text,
      scenePromptHint,
      scenes: scenesForShot,
    });
    outputCursor = outputEnd;
  }

  return baseShots.filter((shot) => shot.text.length > 0);
}
