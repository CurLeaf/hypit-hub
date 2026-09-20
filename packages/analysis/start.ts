import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliIo } from "@hypit/cli";
import type { WhisperXLanguage } from "@hypit/whisperx";

const here = dirname(fileURLToPath(import.meta.url));

export function writeAnalysisHelp(io: Pick<CliIo, "write">): void {
  io.write(`hypit analysis
在浏览器中完成爆款复刻全流程：分析参考片、解读爆款逻辑、生成 Brief/Treatment、
脚手架工程、build 出片并预览。

  hypit analysis [--video <path.mp4>] [--workspace <directory>]
    [--runtime <hypit.runtime.json>] [--port <number>] [--language zh|en|es]

打开命令打印的网址。上传或指定本地视频后，点击「开始分析」。
分析结果保存在项目的 .hypit/analysis/ 目录（ANALYSIS.json、transcript.json、overview-tile.jpg）。

需要 Runtime 已选择且 runtime up，才能转写对白（WhisperX）。
画面探测与结构推断仅依赖本地 ffmpeg。

相对路径以当前目录为基准；--workspace 选择项目边界。
`);
}

function invalidArguments(message: string): never {
  throw new Error(`${message}。运行 hypit analysis --help 查看用法。`);
}

function argumentsByName(argv: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const accepted = new Set(["video", "runtime", "port", "workspace", "language"]);
  const result = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      invalidArguments(`参数格式错误：${flag ?? "末尾"}`);
    }
    const name = flag.slice(2);
    if (!accepted.has(name)) invalidArguments(`未知选项 --${name}`);
    result.set(name, [...result.get(name) ?? [], value]);
  }
  return result;
}

export async function runAnalysis(argv: readonly string[], io: Pick<CliIo, "write">): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    writeAnalysisHelp(io);
    return;
  }

  const values = argumentsByName(argv[0] === "--" ? argv.slice(1) : argv);
  const invokedFrom = process.env.INIT_CWD ?? process.cwd();
  const { resolveProjectRoot, findRuntimeProfile } = await import("@hypit/project-context-node");
  const workspaceArgument = values.get("workspace")?.at(-1);
  const requestedWorkspaceRoot = workspaceArgument === undefined
    ? undefined
    : resolve(invokedFrom, workspaceArgument);
  const workspaceRoot = await resolveProjectRoot({
    ...(requestedWorkspaceRoot === undefined ? {} : { workspaceRoot: requestedWorkspaceRoot }),
    cwd: invokedFrom,
  });
  const { loadWorkspaceEnv } = await import("./src/workspace-env.js");
  await loadWorkspaceEnv(workspaceRoot);
  const runtimeArgument = values.get("runtime")?.at(-1);
  const selectedRuntime = runtimeArgument === undefined ? await findRuntimeProfile(workspaceRoot) : undefined;
  const runtimePath = runtimeArgument === undefined ? selectedRuntime?.profile : resolve(invokedFrom, runtimeArgument);
  const language = (values.get("language")?.at(-1) ?? "zh") as WhisperXLanguage;
  if (language !== "zh" && language !== "en" && language !== "es") invalidArguments("--language 必须是 zh、en 或 es");
  const port = Number(values.get("port")?.at(-1) ?? "5180");
  if (!Number.isSafeInteger(port) || port <= 0) invalidArguments("--port 必须是正整数");
  const videoArgument = values.get("video")?.at(-1);
  const initialVideo = videoArgument === undefined
    ? undefined
    : workspaceArgument !== undefined
      ? resolve(workspaceRoot, videoArgument)
      : resolve(invokedFrom, videoArgument);

  console.info([
    `  项目              ${workspaceRoot}`,
    `  Runtime Profile   ${runtimePath ?? "未选择"}`,
    `  默认语言          ${language}`,
    ...(initialVideo === undefined ? [] : [`  初始视频          ${initialVideo}`]),
    "",
  ].join("\n"));

  const { createServer } = await import("vite");
  const { analysisPlugin } = await import("./src/server.js");
  const distributionRoot = resolve(here, "../..");
  const server = await createServer({
    configFile: false,
    root: here,
    server: {
      port,
      fs: { allow: [workspaceRoot, distributionRoot, here] },
    },
    plugins: [analysisPlugin({
      workspaceRoot,
      ...(runtimePath === undefined ? {} : { runtimePath }),
      defaultLanguage: language,
      ...(initialVideo === undefined ? {} : { initialVideoPath: initialVideo }),
    })],
  });
  await server.listen();
  server.printUrls();
  if (initialVideo !== undefined) {
    io.write(`  提示：启动后可在界面中分析 ${initialVideo}\n`);
  }
}
