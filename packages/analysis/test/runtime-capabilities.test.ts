import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadRuntimeCapabilities } from "../src/runtime-capabilities.js";

test("loadRuntimeCapabilities matches fish and h3 bindings exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-runtime-cap-"));
  const runtimePath = join(dir, "hypit.runtime.json");
  await writeFile(runtimePath, `${JSON.stringify({
    bindings: {
      "@hypit/fishaudio-speech@1#voice-design-1": "hypihub.default",
      "@hypit/minimax-h3@1#minimax-h3": "gateway.minimax",
      "@hypit/gpt-image@1#gpt-image-2": "gateway.default",
    },
  }, null, 2)}\n`, "utf8");

  const capabilities = await loadRuntimeCapabilities(runtimePath);
  assert.equal(capabilities.fishSpeech, true);
  assert.equal(capabilities.h3Video, true);
});

test("loadRuntimeCapabilities ignores unrelated fish-like binding keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-runtime-cap-"));
  const runtimePath = join(dir, "hypit.runtime.json");
  await writeFile(runtimePath, `${JSON.stringify({
    bindings: {
      "custom.fishy-gateway#tts": "gateway.default",
    },
  }, null, 2)}\n`, "utf8");

  const capabilities = await loadRuntimeCapabilities(runtimePath);
  assert.equal(capabilities.fishSpeech, false);
});
