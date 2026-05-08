import test from "node:test";
import assert from "node:assert/strict";
import { extractTurnArtifacts } from "../src/extraction.js";

test("LLM extraction post-processing protects other-person subjects", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                profile_facts: [],
                memory_events: [
                  {
                    summary: "用户被公司临时召回，且发烧了",
                    score: 0.8,
                    occurred_at: "2026-05-06",
                  },
                ],
                corrections: [],
              }),
            },
          },
        ],
      };
    },
  });

  try {
    const artifacts = await extractTurnArtifacts(
      {
        id: "user-1",
        conversationId: "conversation-1",
        text: "Person1 被公司临时叫回去了，而且他有点发烧。",
      },
      { id: "assistant-1", conversationId: "conversation-1", text: "这听起来很折腾。" },
      { openAiBaseUrl: "https://example.com/v1", openAiApiKey: "key", openAiModel: "extract-test" },
    );

    assert.equal(artifacts.memoryEvents.length, 1);
    assert.equal(artifacts.memoryEvents[0].summary, "用户描述Ho：被公司临时召回，且发烧了");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM extraction does not rewrite user-subject summaries just because another person is mentioned", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                profile_facts: [],
                memory_events: [
                  {
                    summary: "用户担心自己对 Person1 的 attachment 变强",
                    score: 0.7,
                    occurred_at: null,
                  },
                ],
                corrections: [],
              }),
            },
          },
        ],
      };
    },
  });

  try {
    const artifacts = await extractTurnArtifacts(
      {
        id: "user-1",
        conversationId: "conversation-1",
        text: "我感觉我对 Person1 的 attachment 变强了。",
      },
      { id: "assistant-1", conversationId: "conversation-1", text: "这是一个值得看的信号。" },
      { openAiBaseUrl: "https://example.com/v1", openAiApiKey: "key", openAiModel: "extract-test" },
    );

    assert.equal(artifacts.memoryEvents[0].summary, "用户担心自己对 Person1 的 attachment 变强");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLM extraction filters low-value memory events", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                profile_facts: [],
                memory_events: [
                  { summary: "漂亮", score: 0.8, occurred_at: null },
                  { summary: "用户完成了 capstone presentation", score: 0.8, occurred_at: "2026-05-06" },
                ],
                corrections: [],
              }),
            },
          },
        ],
      };
    },
  });

  try {
    const artifacts = await extractTurnArtifacts(
      {
        id: "user-1",
        conversationId: "conversation-1",
        text: "漂亮。capstone presentation 也讲完了。",
      },
      { id: "assistant-1", conversationId: "conversation-1", text: "讲完是一个节点。" },
      { openAiBaseUrl: "https://example.com/v1", openAiApiKey: "key", openAiModel: "extract-test" },
    );

    assert.deepEqual(
      artifacts.memoryEvents.map((event) => event.summary),
      ["用户完成了 capstone presentation"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy extraction skips standalone low-value utterances", async () => {
  const artifacts = await extractTurnArtifacts(
    { id: "user-1", conversationId: "conversation-1", text: "嗯！" },
    { id: "assistant-1", conversationId: "conversation-1", text: "嗯。" },
    {},
  );

  assert.deepEqual(artifacts.memoryEvents, []);
});
