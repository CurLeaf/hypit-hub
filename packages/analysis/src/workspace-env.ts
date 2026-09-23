import { access } from "node:fs/promises";
import { join } from "node:path";

import { loadWorkspaceEnv } from "@hypit/credential-store-env";

async function isDistributionCheckout(root: string): Promise<boolean> {
  try {
    await access(join(root, "pnpm-workspace.yaml"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Load credentials for Analysis / build subprocesses.
 * In a Hypit source checkout, `.env` belongs at the repository root only —
 * `examples/` and `projects/` are redirected fixtures and must not host secrets.
 */
export async function loadHypitAnalysisEnv(
  distributionRoot: string,
  projectRoot: string,
): Promise<void> {
  await loadWorkspaceEnv(distributionRoot);
  if (await isDistributionCheckout(distributionRoot)) return;
  await loadWorkspaceEnv(projectRoot);
}

export { loadWorkspaceEnv } from "@hypit/credential-store-env";
