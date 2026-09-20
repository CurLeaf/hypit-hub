import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../../examples/byok-openai-compatible");
const runPath = process.argv[2];
if (!runPath) throw new Error("usage: run-build.mjs <run-path-relative-to-workspace>");

const { ensureRuntimeUp, submitBuild, pollBuildStatus, exportBuildVideo } = await import("../src/build-runner.ts");

process.env.HYPIT_DISTRIBUTION_ROOT = resolve(import.meta.dirname, "../../..");
const runtimePath = resolve(workspace, "hypit.runtime.json");

await ensureRuntimeUp(workspace, runtimePath);
console.log("submitting build...");
const buildId = await submitBuild(workspace, runPath, runtimePath);
console.log("build id:", buildId);

for (let attempt = 0; attempt < 600; attempt += 1) {
  const status = await pollBuildStatus(workspace, buildId, runtimePath);
  process.stdout.write(`[${attempt}] ${status.phase} (${status.status})\n`);
  if (status.status === "complete") {
    const output = resolve(workspace, "output", "replica-" + Date.now() + ".mp4");
    await exportBuildVideo(workspace, buildId, output);
    console.log("exported:", output);
    break;
  }
  if (status.status === "error") {
    console.error("build failed:", status.error);
    process.exit(1);
  }
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
}
