import { hasProductReference } from "./product-reference.js";
import type { AnalysisSessionView } from "./shared.js";

export function hasCommittedProductAdaptation(session: AnalysisSessionView): boolean {
  return session.directorReview?.status === "approved"
    || session.adaptation?.status === "complete"
    || session.adaptation?.status === "error";
}

export function shouldInvalidateForGoalChange(
  session: AnalysisSessionView,
  previousGoal: string,
  nextGoal: string,
): boolean {
  if (previousGoal === nextGoal || !hasProductReference(session)) return false;
  if (!hasCommittedProductAdaptation(session)) return false;
  const baselineGoal = session.directorReview?.adaptationGoal?.trim() ?? previousGoal;
  return baselineGoal !== nextGoal;
}

export function shouldInvalidateForDurationChange(
  session: AnalysisSessionView,
  previousDuration: number | undefined,
  nextDuration: number | undefined,
): boolean {
  if (previousDuration === nextDuration || !hasProductReference(session)) return false;
  if (!hasCommittedProductAdaptation(session)) return false;
  return true;
}
