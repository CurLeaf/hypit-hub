import { estimateSpeechDuration, sealSpeechEstimatePolicy } from "@hypit/estimate";
import type { SpeechEstimateLanguage } from "@hypit/estimate";

/** MiniMax H3 `duration` is a whole number of seconds in this inclusive range. */
export const H3_MIN_DURATION_SEC = 4;
export const H3_MAX_DURATION_SEC = 15;

export function resolveMeasureLanguage(language: string): SpeechEstimateLanguage {
  if (language === "en" || language === "es" || language === "ja" || language === "zh" || language === "auto") {
    return language;
  }
  if (language.startsWith("zh") || language.startsWith("cmn") || language === "yue") return "zh";
  if (language.startsWith("en")) return "en";
  if (language.startsWith("ja")) return "ja";
  if (language.startsWith("es")) return "es";
  return "zh";
}

/** Unclamped speech length used to decide whether a take must be split for H3. */
export function estimateSegmentSeconds(
  text: string,
  language: SpeechEstimateLanguage | string = "zh",
): number {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return H3_MIN_DURATION_SEC;
  try {
    const policy = sealSpeechEstimatePolicy({
      language: resolveMeasureLanguage(language),
      pace: "fast",
      rounding: "ceil",
      paddingSec: 0.35,
    });
    return Math.ceil(estimateSpeechDuration({ value: trimmed }, policy));
  } catch {
    return H3_MIN_DURATION_SEC;
  }
}

export function fitsH3Duration(
  text: string,
  language: SpeechEstimateLanguage | string = "zh",
): boolean {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return true;
  return estimateSegmentSeconds(trimmed, language) <= H3_MAX_DURATION_SEC;
}

export function measureSegmentSeconds(
  text: string,
  language: SpeechEstimateLanguage | string = "zh",
): number {
  return Math.min(
    H3_MAX_DURATION_SEC,
    Math.max(H3_MIN_DURATION_SEC, estimateSegmentSeconds(text, language)),
  );
}
