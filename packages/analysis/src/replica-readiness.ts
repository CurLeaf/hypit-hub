import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { AdaptationView, AnalysisSessionView, OfficialPathReportView } from "./shared.js";
import { adaptationDir } from "./prepare-adaptation.js";
import {
  assertOfficialH3Credential,
  assertOfficialLlmGateway,
  buildOfficialPathReport,
  loadOfficialGateway,
} from "./official-replica.js";
import { loadRuntimeCapabilities } from "./runtime-capabilities.js";

export type ReplicaReadiness = OfficialPathReportView & {
  readonly issues: readonly string[];
};

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function listProductReferenceAssets(assetsDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(assetsDir);
    return entries.filter((name) => name.startsWith("product-reference."));
  } catch {
    return [];
  }
}

export function needsProductAdaptation(session: AnalysisSessionView): boolean {
  return session.productReferencePath !== undefined;
}

export function adaptationMatchesReference(
  adaptation: AdaptationView | undefined,
  productReferencePath: string | undefined,
): boolean {
  if (adaptation === undefined || productReferencePath === undefined) return false;
  return adaptation.productReferenceSource === productReferencePath;
}

export async function assertOfficialReplicaCredentials(
  session: AnalysisSessionView,
  runtimePath?: string,
): Promise<void> {
  if (!needsProductAdaptation(session)) return;
  const gateway = assertOfficialLlmGateway(await loadOfficialGateway(runtimePath, session.workspaceRoot));
  void gateway;
  const capabilities = await loadRuntimeCapabilities(runtimePath ?? session.runtimeProfile);
  assertOfficialH3Credential(capabilities, session.videoAroll ?? true);
}

export async function checkReplicationReadiness(
  session: AnalysisSessionView,
  options?: { readonly forBuild?: boolean; readonly runtimePath?: string },
): Promise<ReplicaReadiness> {
  const runtimePath = options?.runtimePath ?? session.runtimeProfile;
  const svmlPath = options?.forBuild === true && session.scaffold?.authorPath !== undefined
    ? session.scaffold.authorPath
    : undefined;
  const report = await buildOfficialPathReport({
    session,
    ...(runtimePath === undefined ? {} : { runtimePath }),
    ...(options?.forBuild === undefined ? {} : { forBuild: options.forBuild }),
    ...(svmlPath === undefined ? {} : { svmlPath }),
  });
  const issues = report.checks.filter((check) => !check.ok).map((check) => `${check.label}：${check.detail}`);

  if (options?.forBuild === true && session.scaffold !== undefined) {
    const assetsDir = join(session.scaffold.productionDir, "assets");
    const useVideoAroll = session.videoAroll ?? true;
    const capabilities = await loadRuntimeCapabilities(runtimePath);
    if (!(await fileExists(join(assetsDir, "generated-speech.wav")))) {
      issues.push("工程内缺少配音素材 generated-speech.wav，请重新点击「一键复刻」");
    }
    if (useVideoAroll && !capabilities.fishSpeech && !(await fileExists(join(assetsDir, "voice-reference.wav")))) {
      issues.push("工程内缺少 H3 音色样本 voice-reference.wav，请重新点击「一键复刻」");
    }
    const productAssets = await listProductReferenceAssets(assetsDir);
    if (productAssets.length === 0) {
      issues.push("工程内缺少参考图素材 product-reference.*，请重新点击「一键复刻」");
    }
    if (session.scaffold.checkOk === false) {
      issues.push(`工程校验未通过：${session.scaffold.checkSummary ?? "请运行 hypit check 查看详情"}`);
    }
  }

  return {
    ok: issues.length === 0,
    checks: report.checks,
    issues,
  };
}

export async function assertReplicationReady(
  session: AnalysisSessionView,
  options?: { readonly forBuild?: boolean; readonly runtimePath?: string },
): Promise<void> {
  await assertOfficialReplicaCredentials(session, options?.runtimePath ?? session.runtimeProfile);
  const readiness = await checkReplicationReadiness(session, options);
  if (!readiness.ok) {
    throw new Error(readiness.issues.join("\n"));
  }
}
