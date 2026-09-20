import type { ScenePlan } from "./scene-plan.js";
import { buildScenes } from "./scene-plan.js";
import type { AnalysisSessionView, ViralInsightView } from "./shared.js";

/**
 * Official adaptation prefers narrative speech segments over raw visual cut boundaries.
 * Fall back to boundary-based scenes when segments are unavailable.
 */
export function buildAdaptationScenes(
  session: AnalysisSessionView,
  insight: ViralInsightView,
): readonly ScenePlan[] {
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
