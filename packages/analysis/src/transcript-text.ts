import type { TranscriptWordView } from "./shared.js";

/** WhisperX 中文转写常在字间插空格；英文词级 token 需保留空格。 */
export function joinTranscriptText(words: readonly Pick<TranscriptWordView, "text">[]): string {
  if (words.length === 0) return "";
  const compact = words.map((word) => word.text).join("");
  const cjkCount = (compact.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  if (cjkCount >= Math.max(2, Math.floor(compact.length * 0.4))) return compact;
  return words.map((word) => word.text).join(" ");
}

export function normalizeTranscriptText(text: string): string {
  const compact = text.replace(/\s+/gu, "");
  return compact.length > 0 ? compact : text.trim();
}

export function wordsInRange(
  words: readonly TranscriptWordView[],
  start: number,
  end: number,
): readonly TranscriptWordView[] {
  return words.filter((word) => {
    const at = word.start ?? word.end ?? 0;
    return at >= start && at <= end;
  });
}

export function transcriptSnippetAt(
  words: readonly TranscriptWordView[],
  at: number,
  windowSeconds = 1.2,
): string {
  const inWindow = wordsInRange(words, at - windowSeconds, at + windowSeconds);
  return joinTranscriptText(inWindow);
}
