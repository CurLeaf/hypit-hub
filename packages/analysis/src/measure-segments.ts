import { estimateSpeechDuration, sealSpeechEstimatePolicy } from "@hypit/estimate";
import type { SpeechEstimateLanguage } from "@hypit/estimate";

export function measureSegmentSeconds(
  text: string,
  language: SpeechEstimateLanguage | "auto" = "zh",
): number {
  const trimmed = text.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return 4;
  const policy = sealSpeechEstimatePolicy({
    language,
    pace: "fast",
    rounding: "ceil",
    paddingSec: 0.35,
  });
  const seconds = estimateSpeechDuration({ value: trimmed }, policy);
  return Math.min(15, Math.max(4, Math.ceil(seconds)));
}
