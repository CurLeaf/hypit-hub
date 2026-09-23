import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin, ViteDevServer } from "vite";
import { findRuntimeProfile } from "@hypit/project-context-node";
import type { WhisperXLanguage } from "@hypit/whisperx";

import { probeMedia } from "@hypit/video-cli";
import {
  ensureRuntimeUp,
  exportBuildVideo,
  pollBuildStatus,
  submitBuild,
} from "./build-runner.js";
import { syncAllBuildVideos, syncBuildVideos } from "./build-videos.js";
import { listCompleteBuildVideos } from "./complete-build-videos.js";
import {
  importUploadedFile,
  loadSavedAnalysis,
  runFullAnalysis,
} from "./engine.js";
import { writeReferenceArchive } from "./reference-archive.js";
import { DEFAULT_VIDEO_NAME, materializeDefaultVideo, resolveDefaultVideoUrl } from "./default-video.js";
import { loadChatGateway } from "./llm.js";
import type { AnalysisConfigView, AnalysisSessionView, DirectorReviewView, GeneratedVideoView } from "./shared.js";
import {
  clampTargetDurationSeconds,
  defaultTargetDurationSeconds,
} from "./target-duration.js";
import {
  approveDirectorReview,
  canStartAdaptation,
  ensureDirectorReviewRequest,
  resetDirectorDrafts,
} from "./director-review.js";
import {
  completeDirectorAgentView,
  initialDirectorAgentView,
  resolveDirectorAgentConfig,
  runDirectorAgent,
} from "./director-agent.js";
import { prepareProductAdaptation, resetAdaptationArtifacts } from "./prepare-adaptation.js";
import { shouldInvalidateForDurationChange, shouldInvalidateForGoalChange } from "./product-adaptation-invalidation.js";
import {
  clearedProductReferenceSessionFields,
  hasProductReference,
  maxProductReferenceImages,
  normalizeProductReferences,
  productReferenceSessionUpdate,
  referencesChanged,
} from "./product-reference.js";
import { assertReplicationReady, checkReplicationReadiness } from "./replica-readiness.js";
import {
  clearWorkflowState,
  generateBrief,
  generateInsight,
  generateTreatment,
  loadWorkflowState,
  enrichSessionWithSavedInsight,
  mergeWorkflowState,
  refreshScaffoldCheck,
  runFullReplication,
  saveWorkflowState,
  scaffoldProject,
  workflowStateFromSession,
} from "./workflow.js";
import { loadHypitAnalysisEnv } from "./workspace-env.js";
import { openVideoRegistry } from "./video-registry.js";

export type AnalysisPluginOptions = {
  readonly workspaceRoot: string;
  readonly runtimePath?: string;
  readonly defaultLanguage: WhisperXLanguage;
  readonly initialVideoPath?: string;
};

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function analysisErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "";
  if (/Headers Timeout Error|HeadersTimeoutError|timed out after/u.test(message)) {
    return "WhisperX 转写超时。CPU 首次推理较慢，请稍后重试；或在 Runtime Profile 中增大 whisperx.local 的 requestTimeoutMs。";
  }
  if (code === "ECONNREFUSED"
    || /connect ECONNREFUSED 127\.0\.0\.1:8765/u.test(message)
    || /nothing is answering at http:\/\/127\.0\.0\.1:8765/u.test(message)) {
    return "WhisperX 本地环境已安装，但 127.0.0.1:8765 上的服务未启动。请运行 hypit runtime up --endpoint whisperx.local。";
  }
  if (message === "fetch failed"
    || code === "ECONNRESET"
    || /connect ECONNREFUSED|connect ECONNRESET/u.test(message)) {
    return "无法连接本地 Runtime 或 WhisperX 服务。请运行 hypit runtime up。";
  }
  return message;
}

function assertWithinRoot(root: string, target: string): string {
  const resolved = resolve(target);
  const base = resolve(root);
  const rel = relative(base, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("路径超出项目边界");
  return resolved;
}

async function readBody(request: import("node:http").IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function videoArtifactSnapshot(
  session: AnalysisSessionView,
  registry: ReturnType<typeof openVideoRegistry>,
  completeVideos: readonly GeneratedVideoView[],
): AnalysisSessionView {
  const buildId = session.build?.id;
  const currentBuildVideos = buildId === undefined || buildId.length === 0
    ? []
    : completeVideos.filter((video) => video.buildId === buildId);
  const nextBuild = session.build === undefined
    ? session.build
    : {
      ...session.build,
      generatedVideos: currentBuildVideos,
      generatedVideoCount: currentBuildVideos.length,
    };
  const registryStats = registry.stats();
  return {
    ...session,
    ...(nextBuild === undefined ? {} : { build: nextBuild }),
    allGeneratedVideos: completeVideos,
    videoStats: {
      totalVideos: completeVideos.length,
      totalBuilds: registryStats.totalBuilds,
    },
  };
}

async function attachVideoArtifacts(
  session: AnalysisSessionView,
  workspaceRoot: string,
  options?: { readonly force?: boolean; readonly includeGeneration?: boolean },
): Promise<AnalysisSessionView> {
  const registry = openVideoRegistry(workspaceRoot);
  await syncAllBuildVideos(workspaceRoot, registry, options);
  const completeVideos = await listCompleteBuildVideos(workspaceRoot, {
    includeGeneration: options?.includeGeneration !== false,
  });
  const normalized = session.workspaceRoot === workspaceRoot ? session : { ...session, workspaceRoot };
  return videoArtifactSnapshot(normalized, registry, completeVideos);
}

async function mergeWorkflow(session: AnalysisSessionView): Promise<AnalysisSessionView> {
  const workflow = await loadWorkflowState(session.workspaceRoot);
  let merged = await enrichSessionWithSavedInsight(mergeWorkflowState(session, workflow));
  if (merged.scaffold?.checkOk === false) {
    const refreshed = await refreshScaffoldCheck(merged.workspaceRoot, merged.scaffold);
    if (refreshed.checkOk !== merged.scaffold.checkOk || refreshed.checkSummary !== merged.scaffold.checkSummary) {
      merged = { ...merged, scaffold: refreshed };
      await saveWorkflowState(merged.workspaceRoot, workflowStateFromSession(merged));
    }
  }
  return await attachVideoArtifacts(merged, session.workspaceRoot);
}

export function analysisPlugin(options: AnalysisPluginOptions): Plugin {
  void loadHypitAnalysisEnv(distributionRoot, options.workspaceRoot);
  let session: AnalysisSessionView = { workspaceRoot: options.workspaceRoot };
  let jobRunning = false;
  let workflowRunning = false;
  let adaptationRunning = false;
  let adaptationQueued = false;
  let adaptationGeneration = 0;
  let directorAgentRunning = false;
  let directorAgentQueued = false;
  let buildPoller: ReturnType<typeof setInterval> | undefined;

  const config: AnalysisConfigView = {
    workspaceRoot: options.workspaceRoot,
    ...(options.runtimePath === undefined ? {} : { runtimeProfile: options.runtimePath }),
    defaultLanguage: options.defaultLanguage,
  };

  async function resolveRuntime(): Promise<string | undefined> {
    if (options.runtimePath !== undefined) return options.runtimePath;
    const selected = await findRuntimeProfile(options.workspaceRoot);
    return selected?.profile;
  }

  async function refreshConfig(): Promise<AnalysisConfigView> {
    const runtime = await resolveRuntime();
    const gateway = await loadChatGateway(runtime, options.workspaceRoot);
    const defaultVideoUrl = resolveDefaultVideoUrl();
    return {
      ...config,
      ...(runtime === undefined ? {} : { runtimeProfile: runtime }),
      ...(gateway === undefined ? {} : {
        chatModel: gateway.model,
        ttsModel: gateway.ttsModel,
        ttsVoice: gateway.ttsVoice,
        hasChatApiKey: (process.env[gateway.apiKeyEnv]?.trim().length ?? 0) > 0,
      }),
      hasH3ApiKey: (process.env.H3_VIDEO_API_KEY?.trim().length ?? 0) > 0,
      ...(defaultVideoUrl === undefined ? {} : {
        defaultVideoUrl,
        defaultVideoName: DEFAULT_VIDEO_NAME,
      }),
      directorAgent: resolveDirectorAgentConfig(),
    };
  }

  async function adoptImportedVideo(target: string, imported: { readonly videoName: string; readonly videoUrl?: string }): Promise<void> {
    const probe = await probeMedia(target);
    await clearWorkflowState(options.workspaceRoot);
    const runtimePath = await resolveRuntime();
    session = {
      workspaceRoot: options.workspaceRoot,
      ...(runtimePath === undefined ? {} : { runtimeProfile: runtimePath }),
      videoPath: target,
      videoName: imported.videoName,
      probe,
      job: { id: "upload", status: "complete" },
      ...(imported.videoUrl === undefined ? {} : { videoUrl: imported.videoUrl }),
    };
  }

  async function ensureDirectorReviewReady(): Promise<DirectorReviewView> {
    if (session.insight === undefined) {
      throw new Error("请先完成参考视频分析");
    }
    if (session.directorReview !== undefined) return session.directorReview;
    const directorReview = await ensureDirectorReviewRequest({
      session,
      insight: session.insight,
    });
    session = { ...session, directorReview };
    await persistWorkflow();
    return directorReview;
  }

  async function finalizeDirectorApproval(): Promise<void> {
    if (session.insight === undefined) throw new Error("请先完成参考视频分析");
    const issues = await approveDirectorReview(options.workspaceRoot, {
      session,
      insight: session.insight,
      ...(session.brief === undefined ? {} : { brief: session.brief }),
      ...(session.treatment === undefined ? {} : { treatment: session.treatment }),
    });
    if (issues.length > 0) {
      throw new Error(issues.join("；"));
    }
    session = {
      ...session,
      directorReview: {
        ...(session.directorReview ?? await ensureDirectorReviewRequest({
          session,
          insight: session.insight,
        })),
        status: "approved",
        phase: "导演审查已通过",
        approvedAt: Date.now(),
        adaptationGoal: session.adaptationGoal?.trim() || undefined,
      },
    };
    await persistWorkflow();
    if (!adaptationRunning) void scheduleAdaptation(session.adaptationGoal);
  }

  async function scheduleDirectorAgent(force = false): Promise<void> {
    const agentConfig = resolveDirectorAgentConfig();
    if (!force && !agentConfig.auto) return;
    if (!agentConfig.available) return;
    if (!hasProductReference(session) || session.analysisPath === undefined) return;
    if (session.insight === undefined) return;
    if (session.directorReview?.status === "approved") return;
    if (!force && (session.adaptationGoal?.trim().length ?? 0) === 0) return;
    if (directorAgentRunning) {
      directorAgentQueued = true;
      return;
    }
    directorAgentRunning = true;
    try {
      const review = await ensureDirectorReviewReady();
      session = {
        ...session,
        directorReview: {
          ...review,
          status: "pending",
          phase: "Cursor Agent 正在审查…",
          agent: initialDirectorAgentView(agentConfig, "Cursor Agent 正在审查…"),
        },
      };
      await persistWorkflow();

      const result = await runDirectorAgent({
        workspaceRoot: options.workspaceRoot,
        session,
        insight: session.insight,
        onPhase: (phase) => {
          session = {
            ...session,
            directorReview: {
              ...(session.directorReview ?? review),
              status: "pending",
              phase,
              agent: {
                ...(session.directorReview?.agent ?? initialDirectorAgentView(agentConfig, phase)),
                status: "running",
                phase,
              },
            },
          };
        },
      });

      if (result.ok) {
        await finalizeDirectorApproval();
        session = {
          ...session,
          directorReview: {
            ...(session.directorReview ?? review),
            status: "approved",
            phase: "导演审查已通过",
            approvedAt: Date.now(),
            adaptationGoal: session.adaptationGoal?.trim() || undefined,
            agent: completeDirectorAgentView(session.directorReview?.agent, result),
          },
        };
        await persistWorkflow();
        return;
      }

      session = {
        ...session,
        directorReview: {
          ...(session.directorReview ?? review),
          status: "pending",
          phase: "等待导演审查",
          agent: completeDirectorAgentView(session.directorReview?.agent, result),
        },
      };
      await persistWorkflow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session = {
        ...session,
        directorReview: {
          ...(session.directorReview ?? {
            status: "pending",
            dir: "",
            requestPath: "",
            briefPath: "",
            treatmentPath: "",
            scenesPath: "",
            checklistPath: "",
          }),
          status: "pending",
          phase: "等待导演审查",
          agent: {
            provider: "cursor",
            status: "error",
            phase: "导演 Agent 未完成",
            error: message,
            finishedAt: Date.now(),
          },
        },
      };
      await persistWorkflow();
    } finally {
      directorAgentRunning = false;
      if (directorAgentQueued) {
        directorAgentQueued = false;
        void scheduleDirectorAgent(force);
      }
    }
  }

  const clearedProductAdaptationSession = (): Pick<
    AnalysisSessionView,
    "adaptation" | "brief" | "treatment" | "scaffold" | "build" | "workflowJob" | "directorReview"
  > => ({
    adaptation: undefined,
    brief: undefined,
    treatment: undefined,
    scaffold: undefined,
    build: undefined,
    workflowJob: undefined,
    directorReview: undefined,
  });

  async function invalidateProductAdaptationState(): Promise<void> {
    adaptationGeneration += 1;
    adaptationQueued = false;
    await resetDirectorDrafts(options.workspaceRoot);
    await resetAdaptationArtifacts(options.workspaceRoot);
  }

  async function applyProductReferenceUpdate(
    current: AnalysisSessionView,
    newPaths: readonly string[],
    newNames: readonly string[],
  ): Promise<{ readonly session: AnalysisSessionView; readonly referenceChanged: boolean }> {
    const { paths: existingPaths } = normalizeProductReferences(current);
    const referenceChanged = referencesChanged(existingPaths, newPaths);
    if (referenceChanged) {
      await invalidateProductAdaptationState();
    }
    const { adaptation: _adaptation, scaffold: _scaffold, build: _build, workflowJob: _workflowJob, ...retained } = current;
    const fields = newPaths.length === 0
      ? clearedProductReferenceSessionFields()
      : productReferenceSessionUpdate(newPaths, newNames);
    return {
      referenceChanged,
      session: {
        ...(referenceChanged ? retained : current),
        ...fields,
        videoAroll: current.videoAroll ?? true,
        ...(referenceChanged ? clearedProductAdaptationSession() : {}),
      },
    };
  }

  async function persistWorkflow(): Promise<void> {
    await saveWorkflowState(options.workspaceRoot, {
      ...(session.videoPath === undefined ? {} : { videoPath: session.videoPath }),
      ...(session.videoUrl === undefined ? {} : { videoUrl: session.videoUrl }),
      ...(session.productReferencePath === undefined ? {} : { productReferencePath: session.productReferencePath }),
      ...(session.productReferenceName === undefined ? {} : { productReferenceName: session.productReferenceName }),
      ...(session.productReferencePaths === undefined ? {} : { productReferencePaths: session.productReferencePaths }),
      ...(session.productReferenceNames === undefined ? {} : { productReferenceNames: session.productReferenceNames }),
      ...(session.videoAroll === undefined ? {} : { videoAroll: session.videoAroll }),
      ...(session.targetDurationSeconds === undefined ? {} : { targetDurationSeconds: session.targetDurationSeconds }),
      ...(session.insight === undefined ? {} : { insight: session.insight }),
      ...(session.brief === undefined ? {} : { brief: session.brief }),
      ...(session.treatment === undefined ? {} : { treatment: session.treatment }),
      ...(session.scaffold === undefined ? {} : { scaffold: session.scaffold }),
      ...(session.build === undefined ? {} : { build: session.build }),
      ...(session.adaptation === undefined ? {} : { adaptation: session.adaptation }),
      ...(session.adaptationGoal === undefined ? {} : { adaptationGoal: session.adaptationGoal }),
      ...(session.directorReview === undefined ? {} : { directorReview: session.directorReview }),
    });
  }

  async function requestDirectorReview(): Promise<void> {
    if (session.analysisPath === undefined || session.insight === undefined) return;
    if (!hasProductReference(session)) return;
    const directorReview = await ensureDirectorReviewRequest({
      session,
      insight: session.insight,
    });
    session = { ...session, directorReview };
    await persistWorkflow();
  }

  async function scheduleAdaptation(goal?: string): Promise<void> {
    const effectiveGoal = goal ?? session.adaptationGoal;
    if (!hasProductReference(session) || session.analysisPath === undefined) return;
    if (!canStartAdaptation(session.directorReview)) return;
    if (adaptationRunning) return;
    adaptationRunning = true;
    const generation = adaptationGeneration;
    session = {
      ...session,
      adaptation: { status: "running", phase: "准备改编配音…" },
    };
    await persistWorkflow();
    try {
      const runtimePath = await resolveRuntime();
      const adaptation = await prepareProductAdaptation({
        session,
        ...(runtimePath === undefined ? {} : { runtimePath }),
        ...(effectiveGoal === undefined ? {} : { goal: effectiveGoal }),
        onPhase: (phase) => {
          if (generation !== adaptationGeneration) return;
          session = { ...session, adaptation: { status: "running", phase } };
        },
      });
      if (generation !== adaptationGeneration) return;
      const briefMarkdown = adaptation.briefPath === undefined
        ? undefined
        : await readFile(adaptation.briefPath, "utf8");
      const treatmentMarkdown = adaptation.treatmentPath === undefined
        ? undefined
        : await readFile(adaptation.treatmentPath, "utf8");
      session = {
        ...session,
        adaptation,
        ...(briefMarkdown === undefined ? {} : {
          brief: { markdown: briefMarkdown, ...(adaptation.briefPath === undefined ? {} : { path: adaptation.briefPath }) },
        }),
        ...(treatmentMarkdown === undefined ? {} : {
          treatment: { markdown: treatmentMarkdown, ...(adaptation.treatmentPath === undefined ? {} : { path: adaptation.treatmentPath }) },
        }),
      };
      await persistWorkflow();
    } catch (error) {
      if (generation !== adaptationGeneration) return;
      const message = error instanceof Error ? error.message : String(error);
      session = {
        ...session,
        adaptation: { status: "error", error: message, phase: "配音制作失败" },
      };
      await persistWorkflow();
    } finally {
      adaptationRunning = false;
      if (adaptationQueued && generation === adaptationGeneration) {
        adaptationQueued = false;
        void scheduleAdaptation();
      }
    }
  }

  function startBuildPolling(buildId: string, runtimePath: string | undefined, outputPath: string): void {
    if (buildPoller !== undefined) clearInterval(buildPoller);
    buildPoller = setInterval(() => {
      void (async () => {
        try {
          const status = await pollBuildStatus(options.workspaceRoot, buildId, runtimePath);
          session = {
            ...session,
            build: {
              id: buildId,
              status: status.status === "complete" ? "complete" : status.status === "error" ? "error" : "building",
              phase: status.phase,
              ...(status.error === undefined ? {} : { error: status.error }),
              ...(session.build?.planSummary === undefined ? {} : { planSummary: session.build.planSummary }),
              ...(session.build?.outputVideoPath === undefined ? {} : { outputVideoPath: session.build.outputVideoPath }),
            },
            workflowJob: {
              id: session.workflowJob?.id ?? "workflow",
              status: status.status === "complete" ? "complete" : status.status === "error" ? "error" : "running",
              phase: status.phase,
              ...(status.error === undefined ? {} : { error: status.error }),
            },
          };
          if (status.status === "complete") {
            try {
              const exported = await exportBuildVideo(options.workspaceRoot, buildId, outputPath);
              session = {
                ...session,
                build: { ...session.build!, status: "complete", phase: "成片已导出", outputVideoPath: exported },
                workflowJob: { id: session.workflowJob?.id ?? "workflow", status: "complete", phase: "复刻完成" },
              };
            } catch (error) {
              session = {
                ...session,
                build: {
                  ...session.build!,
                  status: "complete",
                  phase: "Build 完成，导出失败",
                  error: error instanceof Error ? error.message : String(error),
                },
              };
            }
            if (buildPoller !== undefined) clearInterval(buildPoller);
            buildPoller = undefined;
          }
          if (status.status === "error") {
            if (buildPoller !== undefined) clearInterval(buildPoller);
            buildPoller = undefined;
          }
          const registry = openVideoRegistry(options.workspaceRoot);
          await syncBuildVideos(
            options.workspaceRoot,
            buildId,
            registry,
            status.status === "complete" ? "complete" : status.status === "error" ? "failed" : "building",
          );
          session = await attachVideoArtifacts(session, options.workspaceRoot, { force: true });
          await persistWorkflow();
        } catch {
          // keep polling
        }
      })();
    }, 2500);
  }

  return {
    name: "hypit-analysis",
    configureServer(server: ViteDevServer): void {
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (!url.pathname.startsWith("/__analysis/")) return next();

        try {
          if (request.method === "GET" && url.pathname === "/__analysis/config") {
            json(response, 200, await refreshConfig());
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/session") {
            session = await mergeWorkflow(session);
            if (hasProductReference(session)
              && session.insight !== undefined
              && session.analysisPath !== undefined
              && session.directorReview === undefined) {
              await requestDirectorReview();
            }
            json(response, 200, { ...session, runtimeProfile: await resolveRuntime() });
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/analyze") {
            if (jobRunning) throw new Error("已有分析任务在运行");
            const body = JSON.parse((await readBody(request)).toString("utf8")) as {
              path?: string;
              language?: WhisperXLanguage;
            };
            const videoPath = body.path === undefined
              ? session.videoPath
              : assertWithinRoot(options.workspaceRoot, resolve(options.workspaceRoot, body.path));
            if (videoPath === undefined || !existsSync(videoPath)) throw new Error("请先选择或上传视频");
            const language = body.language ?? options.defaultLanguage;
            jobRunning = true;
            await clearWorkflowState(options.workspaceRoot);
            session = {
              workspaceRoot: options.workspaceRoot,
              videoPath,
              videoName: basename(videoPath),
              job: { id: `job-${Date.now()}`, status: "running", phase: "准备中…" },
            };
            json(response, 202, session);
            void (async () => {
              try {
                const runtimePath = await resolveRuntime();
                session = {
                  ...session,
                  job: { ...(session.job ?? { id: "latest", status: "running" }), status: "running", phase: "启动 WhisperX…" },
                };
                await ensureRuntimeUp(options.workspaceRoot, runtimePath, ["whisperx.local"]);
                const result = await runFullAnalysis({
                  workspaceRoot: options.workspaceRoot,
                  videoPath,
                  language,
                  ...(runtimePath === undefined ? {} : { runtimePath }),
                  onPhase: (phase) => {
                    session = { ...session, job: { ...(session.job ?? { id: "latest", status: "running" }), status: "running", phase } };
                  },
                });
                session = { ...result, ...(runtimePath === undefined ? {} : { runtimeProfile: runtimePath }) };
                const insight = await generateInsight({
                  session,
                  ...(runtimePath === undefined ? {} : { runtimePath }),
                  onPhase: (phase) => {
                    session = {
                      ...session,
                      job: {
                        id: session.job?.id ?? "latest",
                        status: "running",
                        phase,
                      },
                    };
                  },
                });
                session = {
                  ...session,
                  insight,
                  job: {
                    id: session.job?.id ?? "latest",
                    status: "complete",
                    phase: "分析完成",
                  },
                };
                await persistWorkflow();
                if (hasProductReference(session)) {
                  await requestDirectorReview();
                }
              } catch (error) {
                session = {
                  ...session,
                  job: {
                    id: session.job?.id ?? "latest",
                    status: "error",
                    error: analysisErrorMessage(error),
                  },
                };
              } finally {
                jobRunning = false;
              }
            })();
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/readiness") {
            const forBuild = url.searchParams.get("forBuild") === "1";
            const runtimePath = await resolveRuntime();
            session = await mergeWorkflow(session);
            json(response, 200, await checkReplicationReadiness(session, {
              forBuild,
              ...(runtimePath === undefined ? {} : { runtimePath }),
            }));
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/adaptation-goal") {
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as {
              goal?: string;
              targetDurationSeconds?: number;
            };
            const goalProvided = body.goal !== undefined;
            const durationProvided = body.targetDurationSeconds !== undefined;
            const previousGoal = session.adaptationGoal?.trim() ?? "";
            const nextGoalText = goalProvided ? (body.goal?.trim() ?? "") : previousGoal;
            const previousDuration = session.targetDurationSeconds;
            const nextDuration = durationProvided
              ? clampTargetDurationSeconds(
                body.targetDurationSeconds!,
                defaultTargetDurationSeconds(session),
              )
              : previousDuration;
            session = {
              ...session,
              ...(goalProvided ? { adaptationGoal: nextGoalText || undefined } : {}),
              ...(durationProvided ? { targetDurationSeconds: nextDuration } : {}),
            };
            const goalChanged = goalProvided && shouldInvalidateForGoalChange(session, previousGoal, nextGoalText);
            const durationChanged = durationProvided && shouldInvalidateForDurationChange(session, previousDuration, nextDuration);
            if (goalChanged || durationChanged) {
              await invalidateProductAdaptationState();
              session = { ...session, ...clearedProductAdaptationSession() };
              await persistWorkflow();
              if (session.analysisPath !== undefined && session.insight !== undefined) {
                void requestDirectorReview();
              }
            } else {
              await persistWorkflow();
            }
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/director/approve") {
            if (!hasProductReference(session) || session.analysisPath === undefined) {
              throw new Error("请先完成参考视频分析并上传参考图");
            }
            await finalizeDirectorApproval();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/director/run-agent") {
            if (!hasProductReference(session) || session.analysisPath === undefined) {
              throw new Error("请先完成参考视频分析并上传参考图");
            }
            if (session.insight === undefined) throw new Error("请先完成参考视频分析");
            const agentConfig = resolveDirectorAgentConfig();
            if (!agentConfig.available) {
              throw new Error(agentConfig.missing ?? "导演 Agent 不可用，请配置 CURSOR_API_KEY");
            }
            if (directorAgentRunning) {
              json(response, 202, session);
              return;
            }
            json(response, 202, {
              ...session,
              directorReview: {
                ...(session.directorReview ?? await ensureDirectorReviewRequest({
                  session,
                  insight: session.insight,
                })),
                status: "pending",
                phase: "Cursor Agent 正在审查…",
                agent: initialDirectorAgentView(agentConfig, "Cursor Agent 正在审查…"),
              },
            });
            void scheduleDirectorAgent(true);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/director/refresh") {
            if (session.insight === undefined) throw new Error("请先完成参考视频分析");
            await invalidateProductAdaptationState();
            session = { ...session, ...clearedProductAdaptationSession() };
            await requestDirectorReview();
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/prepare-adaptation") {
            if (adaptationRunning) throw new Error("配音制作任务已在运行");
            if (!canStartAdaptation(session.directorReview)) {
              throw new Error("导演审查尚未通过。请先在 Cursor 编辑 .hypit/analysis/director/ 并点击「导演审查通过」。");
            }
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as {
              goal?: string;
              targetDurationSeconds?: number;
            };
            if (body.targetDurationSeconds !== undefined) {
              session = {
                ...session,
                targetDurationSeconds: clampTargetDurationSeconds(
                  body.targetDurationSeconds,
                  defaultTargetDurationSeconds(session),
                ),
              };
              await persistWorkflow();
            }
            json(response, 202, { ...session, adaptation: { status: "running", phase: "准备改编配音…" } });
            void scheduleAdaptation(body.goal);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/replicate") {
            if (workflowRunning) throw new Error("已有复刻任务在运行");
            if (session.analysisPath === undefined) throw new Error("请先完成媒体分析");
            const replicaRuntimePath = await resolveRuntime();
            await assertReplicationReady(session, {
              ...(replicaRuntimePath === undefined ? {} : { runtimePath: replicaRuntimePath }),
            });
            const body = JSON.parse((await readBody(request)).toString("utf8")) as {
              replacements?: string;
              goal?: string;
              autoBuild?: boolean;
              speechMode?: "reference" | "tts";
              formatId?: string;
              videoAroll?: boolean;
              targetDurationSeconds?: number;
            };
            workflowRunning = true;
            const workflowId = `workflow-${Date.now()}`;
            session = {
              ...session,
              videoAroll: body.videoAroll ?? session.videoAroll ?? true,
              ...(body.targetDurationSeconds === undefined
                ? {}
                : {
                  targetDurationSeconds: clampTargetDurationSeconds(
                    body.targetDurationSeconds,
                    defaultTargetDurationSeconds(session),
                  ),
                }),
              workflowJob: { id: workflowId, status: "running", phase: "准备复刻…" },
            };
            json(response, 202, session);
            void (async () => {
              const runtimePath = await resolveRuntime();
              try {
                const videoAroll = body.videoAroll ?? session.videoAroll;
                const workflow = await runFullReplication({
                  session,
                  distributionRoot,
                  ...(runtimePath === undefined ? {} : { runtimePath }),
                  ...(body.replacements === undefined ? {} : { replacements: body.replacements }),
                  ...(body.goal === undefined ? {} : { goal: body.goal }),
                  ...(body.speechMode === undefined ? {} : { speechMode: body.speechMode }),
                  ...(body.formatId === undefined ? {} : { formatId: body.formatId }),
                  ...(normalizeProductReferences(session).paths.length === 0
                    ? {}
                    : { productReferencePaths: normalizeProductReferences(session).paths }),
                  ...(videoAroll === undefined ? {} : { videoAroll }),
                  onPhase: (phase) => {
                    session = {
                      ...session,
                      workflowJob: { id: workflowId, status: "running", phase },
                    };
                  },
                });
                session = { ...session, ...workflow, ...(runtimePath === undefined ? {} : { runtimeProfile: runtimePath }) };
                await persistWorkflow();

                if (body.autoBuild !== false) {
                  session = {
                    ...session,
                    workflowJob: { id: workflowId, status: "running", phase: "检查 Runtime…" },
                    build: { status: "planning", phase: "准备生成…" },
                  };
                  await ensureRuntimeUp(options.workspaceRoot, runtimePath);
                  const runPath = workflow.scaffold?.runPath;
                  if (runPath === undefined) throw new Error("工程脚手架失败");
                  session = {
                    ...session,
                    workflowJob: { id: workflowId, status: "running", phase: "提交生成…" },
                    build: { status: "building", phase: "提交生成…" },
                  };
                  const buildId = await submitBuild(options.workspaceRoot, runPath, runtimePath);
                  const outputPath = resolve(workflow.scaffold!.productionDir, "output", "final.mp4");
                  session = {
                    ...session,
                    build: { id: buildId, status: "building", phase: "生成中…" },
                    workflowJob: { id: workflowId, status: "running", phase: "生成视频中…" },
                  };
                  await persistWorkflow();
                  startBuildPolling(buildId, runtimePath, outputPath);
                } else {
                  session = {
                    ...session,
                    workflowJob: { id: workflowId, status: "complete", phase: "方案已生成，可手动 build" },
                  };
                  await persistWorkflow();
                }
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const nextBuild = session.build?.status === "building" || session.build?.status === "planning"
                  ? { ...session.build, status: "error" as const, error: message }
                  : session.build;
                session = {
                  ...session,
                  workflowJob: { id: workflowId, status: "error", error: message },
                  ...(nextBuild === undefined ? {} : { build: nextBuild }),
                };
                await persistWorkflow();
              } finally {
                workflowRunning = false;
              }
            })();
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/interpret") {
            if (session.analysisPath === undefined) throw new Error("请先完成媒体分析");
            const runtimePath = await resolveRuntime();
            const insight = await generateInsight({ session, ...(runtimePath === undefined ? {} : { runtimePath }) });
            session = { ...session, insight };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/brief") {
            const body = JSON.parse((await readBody(request)).toString("utf8")) as { replacements?: string; goal?: string };
            const runtimePath = await resolveRuntime();
            const insight = session.insight ?? await generateInsight({ session, ...(runtimePath === undefined ? {} : { runtimePath }) });
            const brief = await generateBrief({
              session,
              insight,
              ...(body.replacements === undefined ? {} : { replacements: body.replacements }),
              ...(body.goal === undefined ? {} : { goal: body.goal }),
              ...(runtimePath === undefined ? {} : { runtimePath }),
            });
            session = { ...session, insight, brief };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/treatment") {
            if (session.brief === undefined) throw new Error("请先生成 Brief");
            const runtimePath = await resolveRuntime();
            const insight = session.insight ?? await generateInsight({ session, ...(runtimePath === undefined ? {} : { runtimePath }) });
            const treatment = await generateTreatment({
              session,
              insight,
              brief: session.brief,
              ...(runtimePath === undefined ? {} : { runtimePath }),
            });
            session = { ...session, insight, treatment };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/scaffold") {
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as {
              speechMode?: "reference" | "tts";
              formatId?: string;
            };
            const runtimePath = await resolveRuntime();
            const insight = session.insight ?? await generateInsight({ session, ...(runtimePath === undefined ? {} : { runtimePath }) });
            const brief = session.brief ?? await generateBrief({ session, insight, ...(runtimePath === undefined ? {} : { runtimePath }) });
            const treatment = session.treatment ?? await generateTreatment({
              session,
              insight,
              brief,
              ...(runtimePath === undefined ? {} : { runtimePath }),
            });
            const scaffold = await scaffoldProject({
              session,
              insight,
              brief,
              treatment,
              distributionRoot,
              ...(body.formatId === undefined ? {} : { formatId: body.formatId }),
              ...(runtimePath === undefined ? {} : { runtimePath }),
              ...(body.speechMode === undefined ? {} : { speechMode: body.speechMode }),
              ...(normalizeProductReferences(session).paths.length === 0
                ? {}
                : { productReferencePaths: normalizeProductReferences(session).paths }),
              ...(session.videoAroll === undefined ? {} : { videoAroll: session.videoAroll }),
              ...(session.adaptationGoal === undefined ? {} : { goal: session.adaptationGoal }),
              ...(session.adaptation === undefined ? {} : { preparedAdaptation: session.adaptation }),
            });
            session = { ...session, insight, brief, treatment, scaffold };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/build") {
            if (workflowRunning) throw new Error("已有任务在运行");
            session = await mergeWorkflow(session);
            if (session.scaffold !== undefined) {
              const refreshed = await refreshScaffoldCheck(session.workspaceRoot, session.scaffold);
              session = { ...session, scaffold: refreshed };
              await persistWorkflow();
            }
            const runtimePath = await resolveRuntime();
            await assertReplicationReady(session, { forBuild: true, ...(runtimePath === undefined ? {} : { runtimePath }) });
            workflowRunning = true;
            json(response, 202, { ...session, build: { status: "planning", phase: "启动中…" } });
            void (async () => {
              try {
                await ensureRuntimeUp(options.workspaceRoot, runtimePath);
                const buildId = await submitBuild(options.workspaceRoot, session.scaffold!.runPath, runtimePath);
                const outputPath = resolve(session.scaffold!.productionDir, "output", "final.mp4");
                session = {
                  ...session,
                  build: { id: buildId, status: "building", phase: "生成中…" },
                  workflowJob: { id: `build-${Date.now()}`, status: "running", phase: "生成视频中…" },
                };
                await persistWorkflow();
                startBuildPolling(buildId, runtimePath, outputPath);
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                session = {
                  ...session,
                  build: { status: "error", phase: "生成失败", error: message },
                  workflowJob: {
                    id: session.workflowJob?.id ?? `build-${Date.now()}`,
                    status: "error",
                    phase: "生成失败",
                    error: message,
                  },
                };
                await persistWorkflow();
              } finally {
                workflowRunning = false;
              }
            })();
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/reference-archive") {
            const analysisPath = session.analysisPath;
            if (analysisPath === undefined) throw new Error("请先完成媒体分析");
            const archive = await writeReferenceArchive(session);
            session = { ...session, referenceArchive: archive };
            const raw = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;
            await writeFile(analysisPath, `${JSON.stringify({ ...raw, referenceArchive: archive }, null, 2)}\n`, "utf8");
            json(response, 200, session);
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/document") {
            const target = url.searchParams.get("path");
            if (target === null || target.length === 0) throw new Error("缺少 path");
            const docPath = assertWithinRoot(options.workspaceRoot, resolve(options.workspaceRoot, target));
            const text = await readFile(docPath, "utf8");
            json(response, 200, { path: docPath, markdown: text });
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/upload") {
            const raw = await readBody(request);
            const upload = parseMultipartUpload(request.headers["content-type"], raw, "upload.mp4");
            const fileName = upload.fileName;
            const fileBytes = upload.fileBytes;
            if (fileBytes === undefined || fileBytes.length === 0) throw new Error("未收到视频文件");
            const staging = resolve(options.workspaceRoot, ".hypit", "analysis", "uploads", `incoming-${Date.now()}${extname(fileName) || ".mp4"}`);
            await mkdir(dirname(staging), { recursive: true });
            await writeFile(staging, fileBytes);
            const target = await importUploadedFile(staging, options.workspaceRoot, fileName);
            await adoptImportedVideo(target, { videoName: basename(target) });
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/use-default-video") {
            const defaultVideoUrl = resolveDefaultVideoUrl();
            if (defaultVideoUrl === undefined) throw new Error("未配置默认视频。请运行 pnpm upload:origin");
            const localFallback = resolve(distributionRoot, DEFAULT_VIDEO_NAME);
            const target = await materializeDefaultVideo({
              url: defaultVideoUrl,
              workspaceRoot: options.workspaceRoot,
              ...(existsSync(localFallback) ? { localFallback } : {}),
            });
            await adoptImportedVideo(target, { videoName: DEFAULT_VIDEO_NAME, videoUrl: defaultVideoUrl });
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/upload-reference") {
            const raw = await readBody(request);
            const upload = parseMultipartReferenceUpload(request.headers["content-type"], raw, "reference.jpg");
            if (upload.files.length === 0) throw new Error("未收到参考图文件");
            const limit = maxProductReferenceImages(session);
            const { paths: existingPaths, names: existingNames } = normalizeProductReferences(session);
            const basePaths = upload.mode === "append" ? [...existingPaths] : [];
            const baseNames = upload.mode === "append" ? [...existingNames] : [];
            const newPaths = [...basePaths];
            const newNames = [...baseNames];
            for (const [index, file] of upload.files.entries()) {
              const ext = resolveImageExtension(file.fileName, file.contentType, file.fileBytes);
              const staging = resolve(
                options.workspaceRoot,
                ".hypit",
                "analysis",
                "uploads",
                `reference-${Date.now()}-${index}${ext}`,
              );
              await mkdir(dirname(staging), { recursive: true });
              await writeFile(staging, file.fileBytes);
              const target = await importUploadedFile(staging, options.workspaceRoot, file.fileName);
              newPaths.push(target);
              newNames.push(basename(target));
            }
            if (newPaths.length > limit) {
              throw new Error(`参考图最多上传 ${limit} 张`);
            }
            const update = await applyProductReferenceUpdate(session, newPaths, newNames);
            session = update.session;
            await persistWorkflow();
            json(response, 200, session);
            if (update.referenceChanged && newPaths.length > 0
              && session.analysisPath !== undefined && session.insight !== undefined) {
              void requestDirectorReview();
            }
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/remove-reference") {
            const body = JSON.parse((await readBody(request)).toString("utf8")) as { index?: number };
            const index = body.index;
            if (index === undefined || !Number.isInteger(index) || index < 0) throw new Error("缺少有效的参考图序号");
            const { paths: existingPaths, names: existingNames } = normalizeProductReferences(session);
            if (index >= existingPaths.length) throw new Error("参考图不存在");
            const newPaths = existingPaths.filter((_, itemIndex) => itemIndex !== index);
            const newNames = existingNames.filter((_, itemIndex) => itemIndex !== index);
            const update = await applyProductReferenceUpdate(session, newPaths, newNames);
            session = update.session;
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/clear-references") {
            const { paths: existingPaths } = normalizeProductReferences(session);
            if (existingPaths.length > 0) {
              const update = await applyProductReferenceUpdate(session, [], []);
              session = update.session;
              await persistWorkflow();
            }
            json(response, 200, session);
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/media") {
            const target = url.searchParams.get("path");
            if (target === null || target.length === 0) throw new Error("缺少 path");
            const videoPath = assertWithinRoot(options.workspaceRoot, resolve(options.workspaceRoot, target));
            if (!existsSync(videoPath)) throw new Error("文件不存在");
            const ext = extname(videoPath).toLowerCase();
            const type = ext === ".mp4" ? "video/mp4"
              : ext === ".webm" ? "video/webm"
              : ext === ".mov" ? "video/quicktime"
              : ext === ".wav" ? "audio/wav"
              : ext === ".mp3" ? "audio/mpeg"
              : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
              : ext === ".png" ? "image/png"
              : ext === ".webp" ? "image/webp"
              : ext === ".gif" ? "image/gif"
              : ext === ".avif" ? "image/avif"
              : "application/octet-stream";
            response.statusCode = 200;
            response.setHeader("content-type", type);
            if (url.searchParams.get("download") === "1") {
              response.setHeader("content-disposition", `attachment; filename="${basename(videoPath)}"`);
            }
            createReadStream(videoPath).pipe(response);
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/restore") {
            const saved = await loadSavedAnalysis(options.workspaceRoot);
            const runtimePath = await resolveRuntime();
            if (saved !== undefined) session = { ...saved, ...(runtimePath === undefined ? {} : { runtimeProfile: runtimePath }) };
            session = await mergeWorkflow(session);
            json(response, 200, session);
            return;
          }

          json(response, 404, { error: "unknown analysis route" });
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
    async buildStart(): Promise<void> {
      await loadHypitAnalysisEnv(distributionRoot, options.workspaceRoot);
      const saved = await loadSavedAnalysis(options.workspaceRoot);
      if (saved !== undefined) {
        session = await mergeWorkflow(saved);
      } else if (options.initialVideoPath !== undefined && existsSync(options.initialVideoPath)) {
        const probe = await probeMedia(options.initialVideoPath);
        session = {
          workspaceRoot: options.workspaceRoot,
          ...(options.runtimePath === undefined ? {} : { runtimeProfile: options.runtimePath }),
          videoPath: options.initialVideoPath,
          videoName: basename(options.initialVideoPath),
          probe,
          job: { id: "initial", status: "complete" },
        };
        session = await mergeWorkflow(session);
      } else {
        session = await mergeWorkflow(session);
      }
      if (session.build?.status === "building" && session.build.id !== undefined && session.scaffold !== undefined) {
        const runtimePath = await resolveRuntime();
        const outputPath = resolve(session.scaffold.productionDir, "output", "final.mp4");
        startBuildPolling(session.build.id, runtimePath, outputPath);
      }
    },
  };
}

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);

function trimMultipartContent(content: Buffer): Buffer {
  if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
    return content.subarray(0, content.length - 2);
  }
  return content;
}

function parseMultipartBoundary(contentType: string | undefined): string {
  if (contentType === undefined || !contentType.includes("multipart/form-data")) {
    throw new Error("需要 multipart 上传");
  }
  const boundaryRaw = contentType.split("boundary=")[1];
  if (boundaryRaw === undefined) throw new Error("无效的上传请求");
  return boundaryRaw.trim().replace(/^"|"$/u, "");
}

type MultipartFilePart = {
  readonly fileName: string;
  readonly fileBytes: Buffer;
  readonly contentType?: string;
};

function parseMultipartReferenceUpload(
  contentType: string | undefined,
  raw: Buffer,
  defaultFileName: string,
): { readonly mode: "append" | "replace"; readonly files: readonly MultipartFilePart[] } {
  const boundary = parseMultipartBoundary(contentType);
  const marker = Buffer.from(`--${boundary}`);
  const parts = splitMultipart(raw, marker);
  let mode: "append" | "replace" = "replace";
  const files: MultipartFilePart[] = [];
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const trimmed = trimMultipartContent(content);
    const fieldMatch = /name="([^"]+)"/u.exec(headers);
    const fieldName = fieldMatch?.[1];
    if (fieldName === "mode") {
      if (trimmed.toString("utf8").trim() === "append") mode = "append";
      continue;
    }
    if (fieldName !== "file") continue;
    const nameMatch = /filename="([^"]+)"/u.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/iu.exec(headers);
    if (trimmed.length === 0) continue;
    files.push({
      fileName: nameMatch?.[1] ?? defaultFileName,
      fileBytes: trimmed,
      ...(typeMatch?.[1] === undefined ? {} : { contentType: typeMatch[1].trim().toLowerCase() }),
    });
  }
  return { mode, files };
}

function parseMultipartUpload(
  contentType: string | undefined,
  raw: Buffer,
  defaultFileName: string,
): { fileName: string; fileBytes?: Buffer; contentType?: string } {
  const upload = parseMultipartReferenceUpload(contentType, raw, defaultFileName);
  const file = upload.files[0];
  return {
    fileName: file?.fileName ?? defaultFileName,
    ...(file === undefined ? {} : { fileBytes: file.fileBytes, contentType: file.contentType }),
  };
}

function resolveImageExtension(fileName: string, mimeType: string | undefined, fileBytes: Buffer): string {
  const ext = extname(fileName).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return ext;
  const mimeMap: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/avif": ".avif",
  };
  if (mimeType !== undefined && mimeMap[mimeType] !== undefined) return mimeMap[mimeType];
  if (fileBytes.length >= 3 && fileBytes[0] === 0xff && fileBytes[1] === 0xd8 && fileBytes[2] === 0xff) return ".jpg";
  if (fileBytes.length >= 8
    && fileBytes[0] === 0x89 && fileBytes[1] === 0x50 && fileBytes[2] === 0x4e && fileBytes[3] === 0x47) return ".png";
  if (fileBytes.length >= 12
    && fileBytes.subarray(0, 4).toString("ascii") === "RIFF"
    && fileBytes.subarray(8, 12).toString("ascii") === "WEBP") return ".webp";
  if (fileBytes.length >= 6
    && (fileBytes.subarray(0, 6).toString("ascii") === "GIF87a" || fileBytes.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return ".gif";
  }
  throw new Error("参考图仅支持 jpg、png、webp、gif、avif");
}

function splitMultipart(raw: Buffer, marker: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  while (start < raw.length) {
    const index = raw.indexOf(marker, start);
    if (index < 0) break;
    if (index > start) parts.push(raw.subarray(start, index));
    start = index + marker.length;
    if (raw.subarray(start, start + 2).equals(Buffer.from("--"))) break;
    start += 2;
  }
  return parts;
}

export const analysisRoot = dirname(fileURLToPath(import.meta.url));
