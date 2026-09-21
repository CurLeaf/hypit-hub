import assert from "node:assert/strict";
import test from "node:test";

import {
  isBuildActionBusy,
  isReplicateActionBusy,
  officialPathCheckHint,
  resolveCreateActionStatus,
} from "../src/create-action-status.js";
import type { AnalysisSessionView } from "../src/shared.js";

const baseSession: AnalysisSessionView = {
  workspaceRoot: ".",
  analysisPath: "references/demo/ANALYSIS.md",
};

test("resolveCreateActionStatus prefers pending phase", () => {
  const status = resolveCreateActionStatus(baseSession, {
    pending: { kind: "build", phase: "正在发送视频生成请求…" },
  });
  assert.equal(status.tone, "running");
  assert.equal(status.headline, "正在发送视频生成请求…");
});

test("resolveCreateActionStatus hints build after scaffold", () => {
  const status = resolveCreateActionStatus({
    ...baseSession,
    scaffold: {
      productionDir: "productions/replica-1",
      runPath: "productions/replica-1/runs/final.svrun",
      authorPath: "productions/replica-1/authors/main.svml",
      formatId: "ugc",
      runName: "final.svrun",
    },
  }, { officialPathReady: true });
  assert.match(status.headline, /开始生成视频/);
});

test("officialPathCheckHint changes after scaffold", () => {
  assert.match(officialPathCheckHint(baseSession, true), /一键复刻/);
  assert.match(officialPathCheckHint({
    ...baseSession,
    scaffold: {
      productionDir: "productions/replica-1",
      runPath: "productions/replica-1/runs/final.svrun",
      authorPath: "productions/replica-1/authors/main.svml",
      formatId: "ugc",
      runName: "final.svrun",
    },
  }, true), /开始生成视频/);
});

test("isBuildActionBusy tracks pending build request", () => {
  assert.equal(isBuildActionBusy(baseSession, { kind: "build", phase: "x" }), true);
  assert.equal(isReplicateActionBusy(baseSession, { kind: "replicate", phase: "x" }), true);
});
