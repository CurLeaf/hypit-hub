import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

process.env.HYPIT_DISTRIBUTION_ROOT = resolve(import.meta.dirname, "../../..");
const workspace = resolve(process.env.HYPIT_DISTRIBUTION_ROOT, "examples/byok-openai-compatible");
const runtimePath = resolve(workspace, "hypit.runtime.json");

const { loadSavedAnalysis } = await import("../src/engine.ts");
const {
  generateInsight,
  generateBrief,
  generateTreatment,
  scaffoldProject,
} = await import("../src/workflow.ts");

const session = await loadSavedAnalysis(workspace);
if (!session) throw new Error("no saved analysis");

console.log("session:", session.videoName, session.probe?.duration, "s");

const insight = await generateInsight({ session, runtimePath });
console.log("insight:", insight.summary.slice(0, 80));

const brief = await generateBrief({ session, insight, runtimePath });
const treatment = await generateTreatment({ session, insight, brief, runtimePath });
const scaffold = await scaffoldProject({
  session,
  insight,
  brief,
  treatment,
  distributionRoot: process.env.HYPIT_DISTRIBUTION_ROOT,
});

console.log("scaffold:", scaffold);
const svml = await readFile(scaffold.authorPath, "utf8");
console.log("svml lines:", svml.split("\n").length);
console.log("run:", scaffold.runPath);
