import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadHypitAnalysisEnv } from "./workspace-env.js";

const execFileAsync = promisify(execFile);

function extractCliFailure(raw: {
  readonly reason?: string;
  readonly message?: string;
  readonly error?: string | { readonly message?: string };
}): string | undefined {
  const direct = raw.reason ?? raw.message;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const error = raw.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (error !== null && typeof error === "object" && typeof error.message === "string" && error.message.length > 0) {
    return error.message;
  }
  return undefined;
}

function hypitLauncher(): string {
  if (process.env.HYPIT_CLI_LAUNCHER !== undefined) return process.env.HYPIT_CLI_LAUNCHER;
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../../bin/hypit.mjs");
}

const distributionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

async function runHypit(args: readonly string[], workspaceRoot: string): Promise<string> {
  await loadHypitAnalysisEnv(distributionRoot, workspaceRoot);
  const launcher = hypitLauncher();
  try {
    const { stdout } = await execFileAsync(process.execPath, [launcher, ...args, "--workspace", workspaceRoot, "--json"], {
      cwd: workspaceRoot,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (typeof failed.stdout === "string" && failed.stdout.trim().length > 0) return failed.stdout;
    throw error;
  }
}

function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]!);
      } catch {
        continue;
      }
    }
    throw new Error("无法解析 hypit 命令输出");
  }
}

export async function submitBuild(workspaceRoot: string, runPath: string, runtimePath?: string): Promise<string> {
  const args = ["build", runPath, ...(runtimePath === undefined ? [] : ["--runtime", runtimePath])];
  const raw = parseJsonStdout(await runHypit(args, workspaceRoot)) as {
    build?: { id?: string };
    id?: string;
    error?: string;
    message?: string;
    reason?: string;
  };
  const buildId = raw.build?.id ?? raw.id;
  if (buildId === undefined || buildId.length === 0) {
    const detail = extractCliFailure(raw);
    if (detail !== undefined) {
      if (/OPENAI_API_KEY|RUNTIME_CREDENTIAL_MISSING|credential.*missing/iu.test(detail)) {
        throw new Error("Build 提交失败：未配置 OPENAI_API_KEY。请在仓库根目录创建 .env（复制 .env.example）并重启 hypit analysis。");
      }
      throw new Error("Build 提交失败：" + detail);
    }
    throw new Error("Build 提交失败：未返回 build id");
  }
  return buildId;
}

export async function pollBuildStatus(workspaceRoot: string, buildId: string, runtimePath?: string): Promise<{
  readonly status: "running" | "complete" | "error";
  readonly phase: string;
  readonly error?: string;
}> {
  const args = ["status", buildId, ...(runtimePath === undefined ? [] : ["--runtime", runtimePath])];
  const raw = parseJsonStdout(await runHypit(args, workspaceRoot)) as {
    build?: {
      failure?: string;
      work?: { state?: string; outcome?: string };
      result?: { state?: string };
    } | null;
  };
  const build = raw.build;
  if (build === null || build === undefined) return { status: "running", phase: "等待 Build 状态…" };
  const outcome = build.work?.outcome ?? build.result?.state;
  if (outcome === "complete") return { status: "complete", phase: "Build 完成" };
  if (outcome === "failed" || outcome === "cancelled") {
    return { status: "error", phase: "Build 失败", error: build.failure ?? outcome };
  }
  const phase = build.work?.state === "submitting" ? "提交中…"
    : build.work?.state === "working" ? "生成中…"
    : build.work?.state === "done" ? "收尾中…"
    : "生成中…";
  return { status: "running", phase };
}

export async function exportBuildVideo(workspaceRoot: string, buildId: string, destination: string): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  const args = ["get", buildId, "--output", "final.video", "--to", destination];
  await runHypit(args, workspaceRoot);
  return destination;
}

export async function ensureRuntimeUp(
  workspaceRoot: string,
  runtimePath?: string,
  endpoints: readonly string[] = [],
): Promise<void> {
  const args = [
    "runtime", "up",
    ...(runtimePath === undefined ? [] : ["--runtime", runtimePath]),
    ...endpoints.flatMap((endpoint) => ["--endpoint", endpoint]),
  ];
  await runHypit(args, workspaceRoot);
}

export async function runCheck(
  workspaceRoot: string,
  runPath: string,
  _runtimePath?: string,
): Promise<{ readonly ok: boolean; readonly summary: string; readonly raw: unknown }> {
  // `hypit check` is a local Author/Run static check; `--runtime` is rejected.
  const args = ["check", runPath];
  const raw = parseJsonStdout(await runHypit(args, workspaceRoot)) as {
    ok?: boolean;
    title?: string;
    lines?: string[];
    issues?: string[];
    error?: string;
    message?: string;
  };
  const ok = raw.ok === true;
  const lines = (raw.lines ?? raw.issues ?? []).slice(0, 8).join("\n");
  const failure = extractCliFailure(raw);
  const summary = ok
    ? [raw.title, lines].filter((part) => part !== undefined && part.length > 0).join("\n")
    : failure ?? lines ?? "工程校验失败";
  return { ok, summary, raw };
}
