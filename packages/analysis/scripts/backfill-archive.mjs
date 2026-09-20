import { resolve } from "node:path";

const workspace = resolve(import.meta.dirname, "../../../examples/byok-openai-compatible");
const { loadSavedAnalysis } = await import("../src/engine.ts");
const { writeReferenceArchive } = await import("../src/reference-archive.ts");
const { readFile, writeFile } = await import("node:fs/promises");

const session = await loadSavedAnalysis(workspace);
if (!session) throw new Error("no analysis");
const archive = await writeReferenceArchive(session);
if (!session.analysisPath) throw new Error("no analysis path");
const raw = JSON.parse(await readFile(session.analysisPath, "utf8"));
await writeFile(session.analysisPath, JSON.stringify({ ...raw, referenceArchive: archive }, null, 2) + "\n", "utf8");
console.log("archive:", archive.referenceDir);
console.log("evidence:", archive.evidencePaths.length);
