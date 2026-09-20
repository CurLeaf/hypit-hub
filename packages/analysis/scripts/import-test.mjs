try {
  await import("../src/workflow.ts");
  console.log("workflow ok");
} catch (error) {
  console.error("workflow fail", error.message);
}
try {
  await import("../src/scaffold-ugc.ts");
  console.log("scaffold ok");
} catch (error) {
  console.error("scaffold fail", error.message);
}
