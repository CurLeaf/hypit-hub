import assert from "node:assert/strict";
import test from "node:test";

import {
  isBuildActionBusy,
  isReplicateActionBusy,
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

test("resolveCreateActionStatus shows build error instead of stale pending", () => {
  const status = resolveCreateActionStatus({
    ...baseSession,
    scaffold: {
      productionDir: "productions/replica-1",
      runPath: "productions/replica-1/runs/final.svrun",
      authorPath: "productions/replica-1/authors/main.svml",
      formatId: "ugc",
      runName: "final.svrun",
    },
    build: {
      status: "error",
      error: "media dimensions must be between 256 and 5760 pixels",
    },
  }, {
    pending: { kind: "build", phase: "请求已提交，正在启动生成…" },
  });
  assert.equal(status.tone, "error");
  assert.equal(status.headline, "视频生成失败");
  assert.match(status.detail ?? "", /256 and 5760/);
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
  });
  assert.match(status.headline, /开始生成视频/);
});

test("isBuildActionBusy tracks pending build request", () => {
  assert.equal(isBuildActionBusy(baseSession, { kind: "build", phase: "x" }), true);
  assert.equal(isReplicateActionBusy(baseSession, { kind: "replicate", phase: "x" }), true);
});
