import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/database.js";
import { buildPromptContext, buildRetrievalContext, classifyRetrievalRoute } from "../src/retrieval.js";

test("retrieval context includes entity cards for named-person queries", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-retrieval-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"), {
    now: () => new Date("2026-05-06T10:00:00.000Z"),
  });
  const conversation = repository.createConversation("main");
  const userMessage = repository.createMessage(conversation.id, "user", "Ho 是韩国人。");
  repository.upsertProfileFact({
    kind: "relationship",
    value: "Ho 是用户近期重要的亲密关系对象，关系状态仍在变化",
    confidence: 0.82,
  });
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户描述 Ho：Ho 特地从 Kings Cross 下班后绕路来看用户",
    score: 0.8,
    occurredAt: "2026-05-06",
  });

  const context = await buildRetrievalContext(repository, conversation.id, "Ho 是谁？", {});
  const promptContext = buildPromptContext(context);

  assert.equal(context.retrievalRoute.type, "entity_query");
  assert.match(promptContext, /Evidence packet rules/);
  assert.match(promptContext, /User corrections override older facts\/events/);
  assert.match(promptContext, /Retrieval route for this turn/);
  assert.match(promptContext, /Route: entity_query/);
  assert.match(promptContext, /Value execution check/);
  assert.match(promptContext, /Entity query: distinguish stable identity facts/);
  assert.equal(context.entityCards.length, 1);
  assert.equal(context.entityCards[0].name, "Ho");
  assert.match(promptContext, /Entity cards for this turn/);
  assert.match(promptContext, /Relationship state: uncertain_or_changing/);
  assert.match(promptContext, /不要写死成男友、前任或分手/);
  assert.match(promptContext, /Ho 是用户近期重要的亲密关系对象/);
  assert.match(promptContext, /Kings Cross/);
});

test("time-sensitive retrieval includes deterministic timeline events", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-timeline-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"), {
    now: () => new Date("2026-05-06T10:00:00.000Z"),
  });
  const conversation = repository.createConversation("main");
  const userMessage = repository.createMessage(conversation.id, "user", "Ho 去了 Truffles。");
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户去 Truffles 找 Ho，但 Ho 不在",
    score: 0.8,
    occurredAt: "2026-05-05",
  });
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户完成 capstone presentation",
    score: 0.8,
    occurredAt: "2026-05-06",
  });

  const context = await buildRetrievalContext(repository, conversation.id, "Truffles 是今天去的吗？", {});
  const promptContext = buildPromptContext(context);

  assert.equal(context.retrievalRoute.type, "timeline_query");
  assert.equal(context.timelineEvents.length, 2);
  assert.match(promptContext, /Timeline context for this time-sensitive turn/);
  assert.match(promptContext, /Route: timeline_query/);
  assert.match(promptContext, /Time reasoning: relative-time words must be anchored/);
  assert.match(promptContext, /\[2026-05-05\] 用户去 Truffles 找 Ho/);
  assert.match(promptContext, /\[2026-05-06\] 用户完成 capstone presentation/);
});

test("entity time queries filter timeline events to that entity", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-entity-timeline-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"), {
    now: () => new Date("2026-05-06T10:00:00.000Z"),
  });
  const conversation = repository.createConversation("main");
  const userMessage = repository.createMessage(conversation.id, "user", "Ho 和 capstone 都有事。");
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户描述 Ho：Ho 被公司临时召回",
    score: 0.8,
    occurredAt: "2026-05-05",
  });
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户完成 capstone presentation",
    score: 0.8,
    occurredAt: "2026-05-06",
  });

  const context = await buildRetrievalContext(repository, conversation.id, "Ho 昨天发生了什么？", {});

  assert.equal(context.timelineEvents.length, 1);
  assert.match(context.timelineEvents[0].summary, /Ho/);
});

test("retrieval router separates relationship, health, correction, and open thinking routes", () => {
  assert.equal(classifyRetrievalRoute("我对老金有分离焦虑吗？").type, "relationship_reasoning");
  assert.equal(classifyRetrievalRoute("Ho 发烧是不是 HIV？").type, "health_risk");
  assert.equal(classifyRetrievalRoute("不是生气，是 annoyed。").type, "correction");
  assert.equal(classifyRetrievalRoute("你怎么看这个事情？").type, "open_thinking");
  assert.equal(classifyRetrievalRoute("哈哈").type, "casual_chat");
});

test("value execution check adds route-specific guardrails for health and relationship turns", () => {
  const healthPrompt = buildPromptContext({
    recentMessages: [],
    relatedMessages: [],
    memoryEvents: [],
    profileFacts: [],
    corrections: [],
    latestReflection: null,
    entityCards: [],
    timelineEvents: [],
    retrievalRoute: classifyRetrievalRoute("Ho 发烧是不是 HIV？"),
  });
  assert.match(healthPrompt, /Health risk: separate known facts, general risk, unknowns/);
  assert.match(healthPrompt, /Never imply zero risk/);

  const relationshipPrompt = buildPromptContext({
    recentMessages: [],
    relatedMessages: [],
    memoryEvents: [],
    profileFacts: [],
    corrections: [],
    latestReflection: null,
    entityCards: [],
    timelineEvents: [],
    retrievalRoute: classifyRetrievalRoute("我对老金有分离焦虑吗？"),
  });
  assert.match(relationshipPrompt, /Relationship reasoning: separate behavior facts/);
  assert.match(relationshipPrompt, /alternative explanations/);
});
