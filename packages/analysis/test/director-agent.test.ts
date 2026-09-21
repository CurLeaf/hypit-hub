import assert from "node:assert/strict";
import test from "node:test";

import { buildDirectorAgentPrompt, resolveDirectorAgentConfig } from "../src/director-agent.js";
import type { AnalysisSessionView, ViralInsightView } from "../src/shared.js";

const insight: ViralInsightView = {
  summary: "测试解读",
  whyViral: [],
  howItWorks: [],
  hookAnalysis: "Hook",
  replicationTips: [],
};

test("resolveDirectorAgentConfig requires CURSOR_API_KEY for cursor mode", () => {
  const previous = process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_API_KEY;
  delete process.env.HYPIT_DIRECTOR_AGENT;
  const config = resolveDirectorAgentConfig();
  assert.equal(config.provider, "cursor");
  assert.equal(config.available, false);
  assert.match(config.missing ?? "", /CURSOR_API_KEY/u);
  if (previous !== undefined) process.env.CURSOR_API_KEY = previous;
});

test("resolveDirectorAgentConfig respects manual mode", () => {
  process.env.HYPIT_DIRECTOR_AGENT = "manual";
  const config = resolveDirectorAgentConfig();
  assert.equal(config.provider, "manual");
  assert.equal(config.auto, false);
  delete process.env.HYPIT_DIRECTOR_AGENT;
});

test("buildDirectorAgentPrompt includes adaptation goal", () => {
  const session: AnalysisSessionView = {
    workspaceRoot: "/tmp/project",
    adaptationGoal: "URBAN FIELD 叠穿套装",
    productReferencePath: "/tmp/project/.hypit/analysis/uploads/product.png",
  };
  const prompt = buildDirectorAgentPrompt({ workspaceRoot: session.workspaceRoot, session, insight });
  assert.match(prompt, /URBAN FIELD/u);
  assert.match(prompt, /scenes\.json/u);
});
