import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/database.js";
import { createChatService } from "../src/chat-service.js";

function createHarness() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"));
  const modelProvider = {
    kind: "test-double",
    async respond(input) {
      return `reply for: ${input.userText}`;
    },
  };
  const service = createChatService({
    repository,
    modelProvider,
    now: () => new Date("2026-03-10T10:00:00.000Z"),
  });
  return { service };
}

test("respond stores both sides of the conversation", async () => {
  const { service } = createHarness();
  const conversation = service.ensureConversation(null, "main");

  const result = await service.respond({
    conversationId: conversation.id,
    text: "I am building a personal memory backend.",
  });

  assert.equal(result.userMessage.role, "user");
  assert.equal(result.assistantMessage.role, "assistant");
  assert.match(result.assistantMessage.text, /reply for:/);

  const messages = service.listMessages(conversation.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].text, "I am building a personal memory backend.");
});

test("respond extracts profile facts from user messages", async () => {
  const { service } = createHarness();
  const conversation = service.ensureConversation(null, "main");

  await service.respond({
    conversationId: conversation.id,
    text: "My name is Alex and I prefer native Apple clients.",
  });

  const facts = service.listProfileFacts(20);
  assert.equal(facts.some((fact) => fact.kind === "name" && fact.value === "Alex and I prefer native Apple clients"), false);
  assert.equal(facts.some((fact) => fact.kind === "name" && fact.value === "Alex"), true);
  assert.equal(facts.some((fact) => fact.kind === "preference" && /native Apple clients/i.test(fact.value)), true);
});

test("daily reflection summarizes stored messages", async () => {
  const { service } = createHarness();
  const conversation = service.ensureConversation(null, "main");

  await service.respond({
    conversationId: conversation.id,
    text: "I need to finish the retrieval layer next and I am stuck on ranking.",
  });

  const reflection = service.getReflection("2026-03-10");
  assert.ok(reflection);
  assert.match(reflection.summary, /Daily reflection for 2026-03-10/);
  assert.equal(reflection.openLoops.length > 0, true);
});

test("later turns receive the latest reflection in retrieval context", async () => {
  const { service } = createHarness();
  const conversation = service.ensureConversation(null, "main");

  await service.respond({
    conversationId: conversation.id,
    text: "I need to finish the retrieval layer next and I am stuck on ranking.",
  });

  const result = await service.respond({
    conversationId: conversation.id,
    text: "What should we continue tomorrow?",
  });

  assert.ok(result.retrievalContext.latestReflection);
  assert.equal(result.retrievalContext.latestReflection.reflectionDate, "2026-03-10");
  assert.equal(result.retrievalContext.latestReflection.openLoops.length > 0, true);
});

test("openai chat completion preserves image parts for provider input", async () => {
  let capturedInput = null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-vision-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"));
  const modelProvider = {
    kind: "test-double",
    async respond(input) {
      capturedInput = input;
      return "vision-aware reply";
    },
  };
  const service = createChatService({
    repository,
    modelProvider,
    now: () => new Date("2026-03-10T10:00:00.000Z"),
  });

  const result = await service.respondToOpenAiChatCompletion({
    conversationTitle: "vision-thread",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What stands out in this photo?" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZmFrZQ==" } },
        ],
      },
    ],
  });

  assert.equal(result.assistantMessage.text, "vision-aware reply");
  assert.ok(capturedInput);
  assert.equal(capturedInput.userText, "What stands out in this photo?\nAttached 1 image.");
  assert.ok(Array.isArray(capturedInput.userContent));
  assert.deepEqual(capturedInput.userContent[0], { type: "text", text: "What stands out in this photo?" });
  assert.deepEqual(capturedInput.userContent[1], {
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,ZmFrZQ==" },
  });
});

test("retrieval context excludes the current user turn from prompt history", async () => {
  let capturedInput = null;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-retrieval-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"));
  const modelProvider = {
    kind: "test-double",
    async respond(input) {
      capturedInput = input;
      return "stored";
    },
  };
  const service = createChatService({
    repository,
    modelProvider,
    now: () => new Date("2026-03-10T10:00:00.000Z"),
  });

  const conversation = service.ensureConversation(null, "main");
  await service.respond({
    conversationId: conversation.id,
    text: "I am from China.",
  });

  capturedInput = null;
  await service.respond({
    conversationId: conversation.id,
    text: "I was born in 1990.",
  });

  assert.ok(capturedInput);
  assert.equal(capturedInput.userText, "I was born in 1990.");
  assert.equal(capturedInput.retrievalContext.recentMessages.some((message) => message.text === "I was born in 1990."), false);
  assert.equal(capturedInput.retrievalContext.relatedMessages.some((message) => message.text === "I was born in 1990."), false);
  assert.equal(capturedInput.retrievalContext.recentMessages.some((message) => message.text === "I am from China."), true);
});