import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../../examples/byok-openai-compatible");
const outputDir = resolve(workspace, "output", "merged-by-build");

const { mergeAllBuildClips } = await import("../src/merge-build-clips.ts");

const results = await mergeAllBuildClips(workspace, outputDir);

for (const result of results) {
  if (result.skipped) {
    console.log(`[skip] ${result.buildId}: ${result.reason}`);
    continue;
  }
  const note = result.reason === undefined ? "" : ` (${result.reason})`;
  console.log(`[ok]   ${result.buildId}: ${result.clipCount} clips (${result.clipNames.join(" + ")})${note} -> ${result.outputPath}`);
}

const merged = results.filter((result) => !result.skipped).length;
console.log(`\n完成：${merged} 条合并视频 -> ${outputDir}`);
