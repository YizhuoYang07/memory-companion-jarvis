import test from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../src/config.js";

test("embedding config does not reuse Anthropic chat endpoint", () => {
  const config = readConfig({
    OPENAI_BASE_URL: "https://api.anthropic.com/v1",
    OPENAI_API_KEY: "anthropic-key",
    OPENAI_MODEL: "claude-sonnet-4-6",
  });

  assert.equal(config.embeddingBaseUrl, null);
  assert.equal(config.embeddingApiKey, null);
});

test("embedding config uses separate OpenAI key when available", () => {
  const config = readConfig({
    OPENAI_BASE_URL: "https://api.anthropic.com/v1",
    OPENAI_API_KEY: "anthropic-key",
    OPENAI_API_KEY_GPT: "openai-key",
  });

  assert.equal(config.embeddingBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.embeddingApiKey, "openai-key");
  assert.equal(config.embeddingModel, "text-embedding-3-small");
});

test("embedding config can still reuse OpenAI chat endpoint", () => {
  const config = readConfig({
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_API_KEY: "openai-key",
  });

  assert.equal(config.embeddingBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.embeddingApiKey, "openai-key");
});

test("user timezone defaults to Sydney and can be overridden", () => {
  assert.equal(readConfig({}).userTimezone, "UTC");
  assert.equal(readConfig({ USER_TIMEZONE: "Asia/Tokyo" }).userTimezone, "Asia/Tokyo");
});
