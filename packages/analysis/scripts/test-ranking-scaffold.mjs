import { resolve } from "node:path";

process.env.HYPIT_DISTRIBUTION_ROOT = resolve(import.meta.dirname, "../../..");
const workspace = resolve(process.env.HYPIT_DISTRIBUTION_ROOT, "examples/byok-openai-compatible");
const runtimePath = resolve(workspace, "hypit.runtime.json");

const { loadSavedAnalysis } = await import("../src/engine.ts");
const { generateInsight, generateBrief, generateTreatment, scaffoldProject } = await import("../src/workflow.ts");

const session = await loadSavedAnalysis(workspace);
if (!session) throw new Error("no analysis");

const insight = await generateInsight({ session, runtimePath });
const brief = await generateBrief({ session, insight, runtimePath });
const treatment = await generateTreatment({ session, insight, brief, runtimePath });
const scaffold = await scaffoldProject({
  session,
  insight,
  brief,
  treatment,
  distributionRoot: process.env.HYPIT_DISTRIBUTION_ROOT,
  formatId: "ranking",
  runtimePath,
  speechMode: "reference",
});

console.log("ranking scaffold:", scaffold);
