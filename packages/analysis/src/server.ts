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
  runPlan,
  runPricing,
  submitBuild,
} from "./build-runner.js";
import {
  importUploadedFile,
  loadSavedAnalysis,
  runFullAnalysis,
} from "./engine.js";
import { writeReferenceArchive } from "./reference-archive.js";
import { loadChatGateway } from "./llm.js";
import type { AnalysisConfigView, AnalysisSessionView } from "./shared.js";
import { prepareProductAdaptation } from "./prepare-adaptation.js";
import { assertReplicationReady, checkReplicationReadiness } from "./replica-readiness.js";
import {
  clearWorkflowState,
  generateBrief,
  generateInsight,
  generateTreatment,
  loadWorkflowState,
  enrichSessionWithSavedInsight,
  mergeWorkflowState,
  runFullReplication,
  saveWorkflowState,
  scaffoldProject,
} from "./workflow.js";
import { loadWorkspaceEnv } from "./workspace-env.js";

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
  if (message === "fetch failed"
    || code === "ECONNREFUSED"
    || code === "ECONNRESET"
    || /connect ECONNREFUSED|connect ECONNRESET/u.test(message)) {
    return "无法连接 WhisperX 本地服务。请运行 hypit runtime up。";
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

async function mergeWorkflow(session: AnalysisSessionView): Promise<AnalysisSessionView> {
  const workflow = await loadWorkflowState(session.workspaceRoot);
  return enrichSessionWithSavedInsight(mergeWorkflowState(session, workflow));
}

export function analysisPlugin(options: AnalysisPluginOptions): Plugin {
  void loadWorkspaceEnv(options.workspaceRoot);
  let session: AnalysisSessionView = { workspaceRoot: options.workspaceRoot };
  let jobRunning = false;
  let workflowRunning = false;
  let adaptationRunning = false;
  let adaptationQueued = false;
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
    };
  }

  async function persistWorkflow(): Promise<void> {
    await saveWorkflowState(options.workspaceRoot, {
      videoPath: session.videoPath,
      productReferencePath: session.productReferencePath,
      productReferenceName: session.productReferenceName,
      videoAroll: session.videoAroll,
      insight: session.insight,
      brief: session.brief,
      treatment: session.treatment,
      scaffold: session.scaffold,
      build: session.build,
      adaptation: session.adaptation,
      adaptationGoal: session.adaptationGoal,
    });
  }

  async function scheduleAdaptation(goal?: string): Promise<void> {
    const effectiveGoal = goal ?? session.adaptationGoal;
    if (session.productReferencePath === undefined || session.analysisPath === undefined) return;
    if (adaptationRunning) return;
    adaptationRunning = true;
    session = {
      ...session,
      adaptation: { status: "running", phase: "准备改编配音…" },
    };
    await persistWorkflow();
    try {
      const runtimePath = await resolveRuntime();
      const adaptation = await prepareProductAdaptation({
        session,
        runtimePath,
        goal: effectiveGoal,
        onPhase: (phase) => {
          session = { ...session, adaptation: { status: "running", phase } };
        },
      });
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
          brief: { markdown: briefMarkdown, path: adaptation.briefPath },
        }),
        ...(treatmentMarkdown === undefined ? {} : {
          treatment: { markdown: treatmentMarkdown, path: adaptation.treatmentPath },
        }),
      };
      await persistWorkflow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      session = {
        ...session,
        adaptation: { status: "error", error: message, phase: "配音制作失败" },
      };
      await persistWorkflow();
    } finally {
      adaptationRunning = false;
      if (adaptationQueued) {
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
              planSummary: session.build?.planSummary,
              outputVideoPath: session.build?.outputVideoPath,
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
                const result = await runFullAnalysis({
                  workspaceRoot: options.workspaceRoot,
                  videoPath,
                  language,
                  runtimePath,
                  onPhase: (phase) => {
                    session = { ...session, job: { ...(session.job ?? { id: "latest", status: "running" }), status: "running", phase } };
                  },
                });
                session = { ...result, runtimeProfile: runtimePath };
                const insight = await generateInsight({
                  session,
                  runtimePath,
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
                if (session.productReferencePath !== undefined) {
                  void scheduleAdaptation(session.adaptationGoal);
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
            session = await mergeWorkflow(session);
            json(response, 200, await checkReplicationReadiness(session, {
              forBuild,
              runtimePath: await resolveRuntime(),
            }));
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/adaptation-goal") {
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as { goal?: string };
            session = { ...session, adaptationGoal: body.goal?.trim() || undefined };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/prepare-adaptation") {
            if (adaptationRunning) throw new Error("配音制作任务已在运行");
            const body = JSON.parse((await readBody(request)).toString("utf8") || "{}") as { goal?: string };
            json(response, 202, { ...session, adaptation: { status: "running", phase: "准备改编配音…" } });
            void scheduleAdaptation(body.goal);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/replicate") {
            if (workflowRunning) throw new Error("已有复刻任务在运行");
            if (session.analysisPath === undefined) throw new Error("请先完成媒体分析");
            await assertReplicationReady(session, { runtimePath: await resolveRuntime() });
            const body = JSON.parse((await readBody(request)).toString("utf8")) as {
              replacements?: string;
              goal?: string;
              autoBuild?: boolean;
              speechMode?: "reference" | "tts";
              formatId?: string;
              videoAroll?: boolean;
            };
            workflowRunning = true;
            const workflowId = `workflow-${Date.now()}`;
            session = {
              ...session,
              videoAroll: body.videoAroll ?? session.videoAroll ?? true,
              workflowJob: { id: workflowId, status: "running", phase: "准备复刻…" },
            };
            json(response, 202, session);
            void (async () => {
              const runtimePath = await resolveRuntime();
              try {
                const workflow = await runFullReplication({
                  session,
                  runtimePath,
                  distributionRoot,
                  replacements: body.replacements,
                  goal: body.goal,
                  speechMode: body.speechMode,
                  formatId: body.formatId,
                  productReferencePath: session.productReferencePath,
                  videoAroll: body.videoAroll ?? session.videoAroll,
                  onPhase: (phase) => {
                    session = {
                      ...session,
                      workflowJob: { id: workflowId, status: "running", phase },
                    };
                  },
                });
                session = { ...session, ...workflow, runtimeProfile: runtimePath };
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
                    workflowJob: { id: workflowId, status: "running", phase: "查看执行计划…" },
                    build: { status: "planning", phase: "plan…" },
                  };
                  const plan = await runPlan(options.workspaceRoot, runPath, runtimePath);
                  session = {
                    ...session,
                    build: { status: "planning", phase: "估算费用…", planSummary: plan.summary },
                    workflowJob: { id: workflowId, status: "running", phase: "估算费用…" },
                  };
                  const pricing = await runPricing(options.workspaceRoot, runPath, runtimePath);
                  session = {
                    ...session,
                    build: { status: "building", phase: "提交 Build…", planSummary: plan.summary, pricingSummary: pricing.summary },
                    workflowJob: { id: workflowId, status: "running", phase: "提交 Build…" },
                  };
                  const buildId = await submitBuild(options.workspaceRoot, runPath, runtimePath);
                  const outputPath = resolve(workflow.scaffold!.productionDir, "output", "final.mp4");
                  session = {
                    ...session,
                    build: { id: buildId, status: "building", phase: "生成中…", planSummary: plan.summary },
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
                session = {
                  ...session,
                  workflowJob: {
                    id: workflowId,
                    status: "error",
                    error: error instanceof Error ? error.message : String(error),
                  },
                  build: session.build?.status === "building" || session.build?.status === "planning"
                    ? { ...session.build, status: "error", error: error instanceof Error ? error.message : String(error) }
                    : session.build,
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
            const insight = await generateInsight({ session, runtimePath: await resolveRuntime() });
            session = { ...session, insight };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/brief") {
            const body = JSON.parse((await readBody(request)).toString("utf8")) as { replacements?: string; goal?: string };
            const insight = session.insight ?? await generateInsight({ session, runtimePath: await resolveRuntime() });
            const brief = await generateBrief({ session, insight, replacements: body.replacements, goal: body.goal, runtimePath: await resolveRuntime() });
            session = { ...session, insight, brief };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/treatment") {
            if (session.brief === undefined) throw new Error("请先生成 Brief");
            const insight = session.insight ?? await generateInsight({ session, runtimePath: await resolveRuntime() });
            const treatment = await generateTreatment({ session, insight, brief: session.brief, runtimePath: await resolveRuntime() });
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
            const insight = session.insight ?? await generateInsight({ session, runtimePath: await resolveRuntime() });
            const brief = session.brief ?? await generateBrief({ session, insight, runtimePath: await resolveRuntime() });
            const treatment = session.treatment ?? await generateTreatment({ session, insight, brief, runtimePath: await resolveRuntime() });
            const scaffold = await scaffoldProject({
              session,
              insight,
              brief,
              treatment,
              distributionRoot,
              formatId: body.formatId,
              runtimePath: await resolveRuntime(),
              speechMode: body.speechMode,
              productReferencePath: session.productReferencePath,
              videoAroll: session.videoAroll,
              goal: session.adaptationGoal,
              preparedAdaptation: session.adaptation,
            });
            session = { ...session, insight, brief, treatment, scaffold };
            await persistWorkflow();
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/build") {
            if (workflowRunning) throw new Error("已有任务在运行");
            await assertReplicationReady(session, { forBuild: true, runtimePath: await resolveRuntime() });
            workflowRunning = true;
            const runtimePath = await resolveRuntime();
            json(response, 202, { ...session, build: { status: "planning", phase: "启动中…" } });
            void (async () => {
              try {
                await ensureRuntimeUp(options.workspaceRoot, runtimePath);
                const plan = await runPlan(options.workspaceRoot, session.scaffold!.runPath, runtimePath);
                const pricing = await runPricing(options.workspaceRoot, session.scaffold!.runPath, runtimePath);
                const buildId = await submitBuild(options.workspaceRoot, session.scaffold!.runPath, runtimePath);
                const outputPath = resolve(session.scaffold!.productionDir, "output", "final.mp4");
                session = {
                  ...session,
                  build: { id: buildId, status: "building", phase: "生成中…", planSummary: plan.summary, pricingSummary: pricing.summary },
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
            if (session.analysisPath === undefined) throw new Error("请先完成媒体分析");
            const archive = await writeReferenceArchive(session);
            session = { ...session, referenceArchive: archive };
            const analysisPath = session.analysisPath;
            const raw = JSON.parse(await readFile(analysisPath, "utf8")) as Record<string, unknown>;
            await writeFile(analysisPath, `${JSON.stringify({ ...raw, referenceArchive: archive }, null, 2)}\n`, "utf8");
            json(response, 200, session);
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/document") {
            const target = url.searchParams.get("path");
            if (target === undefined) throw new Error("缺少 path");
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
            const probe = await probeMedia(target);
            await clearWorkflowState(options.workspaceRoot);
            session = {
              workspaceRoot: options.workspaceRoot,
              runtimeProfile: await resolveRuntime(),
              videoPath: target,
              videoName: basename(target),
              probe,
              job: { id: "upload", status: "complete" },
            };
            json(response, 200, session);
            return;
          }

          if (request.method === "POST" && url.pathname === "/__analysis/upload-reference") {
            const raw = await readBody(request);
            const upload = parseMultipartUpload(request.headers["content-type"], raw, "reference.jpg");
            const fileName = upload.fileName;
            const fileBytes = upload.fileBytes;
            if (fileBytes === undefined || fileBytes.length === 0) throw new Error("未收到参考图文件");
            const ext = resolveImageExtension(fileName, upload.contentType, fileBytes);
            const staging = resolve(options.workspaceRoot, ".hypit", "analysis", "uploads", `reference-${Date.now()}${ext}`);
            await mkdir(dirname(staging), { recursive: true });
            await writeFile(staging, fileBytes);
            const target = await importUploadedFile(staging, options.workspaceRoot, fileName);
            const referenceChanged = session.productReferencePath !== target;
            session = {
              ...session,
              productReferencePath: target,
              productReferenceName: basename(target),
              videoAroll: session.videoAroll ?? true,
              ...(referenceChanged ? {
                adaptation: undefined,
                scaffold: undefined,
                build: undefined,
                workflowJob: undefined,
              } : {}),
            };
            await persistWorkflow();
            json(response, 200, session);
            if (session.analysisPath !== undefined) {
              if (adaptationRunning) adaptationQueued = true;
              else void scheduleAdaptation(session.adaptationGoal);
            }
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/media") {
            const target = url.searchParams.get("path");
            if (target === undefined) throw new Error("缺少 path");
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
            createReadStream(videoPath).pipe(response);
            return;
          }

          if (request.method === "GET" && url.pathname === "/__analysis/restore") {
            const saved = await loadSavedAnalysis(options.workspaceRoot);
            if (saved !== undefined) session = { ...saved, runtimeProfile: await resolveRuntime() };
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
      const saved = await loadSavedAnalysis(options.workspaceRoot);
      if (saved !== undefined) {
        session = await mergeWorkflow(saved);
      } else if (options.initialVideoPath !== undefined && existsSync(options.initialVideoPath)) {
        const probe = await probeMedia(options.initialVideoPath);
        session = {
          workspaceRoot: options.workspaceRoot,
          runtimeProfile: options.runtimePath,
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

function parseMultipartUpload(
  contentType: string | undefined,
  raw: Buffer,
  defaultFileName: string,
): { fileName: string; fileBytes?: Buffer; contentType?: string } {
  const boundary = parseMultipartBoundary(contentType);
  const marker = Buffer.from(`--${boundary}`);
  const parts = splitMultipart(raw, marker);
  let fileName = defaultFileName;
  let fileBytes: Buffer | undefined;
  let mimeType: string | undefined;
  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd).toString("utf8");
    const content = part.subarray(headerEnd + 4);
    const trimmed = trimMultipartContent(content);
    const nameMatch = /filename="([^"]+)"/u.exec(headers);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/iu.exec(headers);
    if (headers.includes("name=\"file\"")) {
      fileName = nameMatch?.[1] ?? fileName;
      fileBytes = trimmed;
      mimeType = typeMatch?.[1]?.trim().toLowerCase();
    }
  }
  return { fileName, fileBytes, contentType: mimeType };
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
