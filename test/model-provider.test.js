import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderMessages, buildTimeContext } from "../src/model-provider.js";

function emptyRetrievalContext(overrides = {}) {
  return {
    recentMessages: [],
    relatedMessages: [],
    memoryEvents: [],
    profileFacts: [],
    latestReflection: null,
    corrections: [],
    ...overrides,
  };
}

test("time context uses UTC by default and exposes recent message timestamps", () => {
  const context = buildTimeContext(
    emptyRetrievalContext({
      recentMessages: [
        {
          role: "user",
          text: "Truffles 是今天去的吗？",
          createdAt: "2026-05-05T14:45:00.000Z",
        },
      ],
    }),
    { now: () => new Date("2026-05-05T15:30:00.000Z") },
  );

  assert.match(context, /User timezone: UTC/);
  assert.match(context, /Local date: 2026-05-05/);
  assert.match(context, /Do not call an event "today" unless its timestamp falls on 2026-05-05/);
  assert.match(context, /Recent message timestamps \(UTC\):/);
  assert.match(context, /\[2026-05-05 14:45\] user: Truffles 是今天去的吗？/);
});

test("time intent injects a temporal grounding hint into provider messages", () => {
  const messages = buildProviderMessages(
    {
      userText: "Truffles 是今天去的吗？",
      userContent: "Truffles 是今天去的吗？",
      retrievalContext: emptyRetrievalContext(),
      clientSystemPrompt: "You are Jarvis.",
    },
    { now: () => new Date("2026-05-05T15:30:00.000Z"), userTimezone: "UTC" },
  );

  const contextMessage = messages.find((message) => message.role === "system" && message.content.includes("[Intent Hint]"));
  assert.ok(contextMessage);
  assert.match(contextMessage.content, /用户的问题依赖时间判断/);
  assert.match(contextMessage.content, /不要用叙事顺序或语感判断/);
});
