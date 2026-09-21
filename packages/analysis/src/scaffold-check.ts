/** `hypit check` rejects `--runtime`; Analysis used to pass it and treat the CLI error as a failed project. */
export function isCliCheckInvocationError(summary: string | undefined): boolean {
  return (summary ?? "").includes("--runtime does not apply to check");
}

export function shouldBlockBuildOnScaffoldCheck(
  checkOk: boolean | undefined,
  checkSummary: string | undefined,
): boolean {
  if (checkOk !== false) return false;
  return !isCliCheckInvocationError(checkSummary);
}
