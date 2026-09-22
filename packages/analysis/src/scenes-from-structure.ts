import type { ScenePlan } from "./scene-plan.js";
import { buildScenes, wordsInRange } from "./scene-plan.js";
import type { AnalysisSessionView, ViralInsightView } from "./shared.js";

const MAX_ADAPTATION_CUTS = 7;
const MIN_CUT_GAP_SECONDS = 1.4;

/** Keep high-impact cuts only; ignore frame-level flicker clusters. */
export function selectAdaptationBoundaries(
  boundaries: readonly { readonly at: number; readonly score: number }[],
): readonly number[] {
  const ranked = [...boundaries].sort((left, right) => right.score - left.score);
  const selected: number[] = [];
  for (const boundary of ranked) {
    if (selected.length >= MAX_ADAPTATION_CUTS) break;
    if (selected.every((at) => Math.abs(at - boundary.at) >= MIN_CUT_GAP_SECONDS)) {
      selected.push(boundary.at);
    }
  }
  return selected.sort((left, right) => left - right);
}

function buildScenesFromEdges(
  session: AnalysisSessionView,
  insight: ViralInsightView,
  edges: readonly number[],
): readonly ScenePlan[] {
  const scenes: ScenePlan[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const start = edges[index]!;
    const end = edges[index + 1]!;
    const text = wordsInRange(session, start, end);
    const momentId = `scene-${index + 1}`;
    scenes.push({
      id: momentId,
      start,
      end,
      text,
      momentId,
      prompt: [
        "Vertical 9:16 short-form social video frame, cinematic lighting, clean composition.",
        `Chinese product promo scene ${index + 1}.`,
        "Theme: " + (text.slice(0, 120) || insight.summary),
        insight.hookAnalysis,
        "No readable text in image.",
      ].join(" "),
    });
  }
  return scenes;
}

/**
 * Official adaptation uses a handful of high-impact visual cuts (not every frame
 * change) so replica scaffolds get multiple Takes aligned to reference pacing.
 */
export function buildAdaptationScenes(
  session: AnalysisSessionView,
  insight: ViralInsightView,
): readonly ScenePlan[] {
  const duration = session.probe?.duration ?? 0;
  const boundaries = session.boundaries ?? [];
  if (boundaries.length > 0 && duration > 0) {
    const keyCuts = selectAdaptationBoundaries(boundaries);
    if (keyCuts.length > 0) {
      return buildScenesFromEdges(session, insight, [0, ...keyCuts, duration]);
    }
    return buildScenes(session, insight);
  }
  const segments = session.segments ?? [];
  if (segments.length > 0) {
    return segments.map((segment, index) => {
      const defaultPrompt = [
        "Vertical 9:16 short-form social video frame, cinematic lighting, clean composition.",
        `Chinese product promo passage ${index + 1}: ${segment.label}.`,
        "Theme: " + (segment.text.slice(0, 120) || insight.summary),
        insight.hookAnalysis,
        "No readable text in image.",
      ].join(" ");
      return {
        id: segment.id,
        start: segment.start,
        end: segment.end,
        text: segment.text,
        momentId: segment.id,
        prompt: defaultPrompt,
      };
    });
  }
  return buildScenes(session, insight);
}
