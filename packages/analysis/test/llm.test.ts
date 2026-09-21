import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { chatGatewayFromConfig, loadChatGateway } from "../src/llm.js";

const env = {
  OPENAI_BASE_URL: "https://gateway.example/v1",
  OPENAI_API_KEY: "sk-test",
  HYPIT_CHAT_MODEL: "deepseek-v4-flash",
};

test("chatGatewayFromConfig resolves env-referenced baseUrl", () => {
  const gateway = chatGatewayFromConfig({
    baseUrl: { store: "env", key: "OPENAI_BASE_URL" },
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
    chatModel: "ignored-when-env-set",
  }, env);
  assert.equal(gateway?.baseUrl, "https://gateway.example/v1");
  assert.equal(gateway?.apiKeyEnv, "OPENAI_API_KEY");
  assert.equal(gateway?.model, "deepseek-v4-flash");
});

test("chatGatewayFromConfig still accepts a literal baseUrl", () => {
  const gateway = chatGatewayFromConfig({
    baseUrl: "https://api.openai.com/v1",
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
  }, {});
  assert.equal(gateway?.baseUrl, "https://api.openai.com/v1");
});

test("chatGatewayFromConfig is absent when the env baseUrl is missing", () => {
  assert.equal(chatGatewayFromConfig({
    baseUrl: { store: "env", key: "OPENAI_BASE_URL" },
    apiKey: { store: "env", key: "OPENAI_API_KEY" },
  }, {}), undefined);
});

test("loadChatGateway reads OPENAI_BASE_URL from a Profile env reference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypit-chat-gateway-"));
  const runtimePath = join(dir, "hypit.runtime.json");
  await writeFile(runtimePath, `${JSON.stringify({
    endpoints: {
      "gateway.default": {
        config: {
          baseUrl: { store: "env", key: "OPENAI_BASE_URL" },
          apiKey: { store: "env", key: "OPENAI_API_KEY" },
          chatModel: "from-json",
        },
      },
    },
  })}\n`);
  const gateway = await loadChatGateway(runtimePath, dir, env);
  assert.equal(gateway?.baseUrl, "https://gateway.example/v1");
});
