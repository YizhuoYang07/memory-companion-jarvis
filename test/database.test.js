import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/database.js";

function createRepository() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-db-"));
  return createDatabase(path.join(tempDir, "memory.db"), {
    now: () => new Date("2026-05-06T10:00:00.000Z"),
  });
}

test("correction retracts a clearly matched profile fact from default retrieval", () => {
  const repository = createRepository();
  const factId = repository.upsertProfileFact({
    kind: "relationship",
    value: "用户对PartnerA有分离焦虑",
    confidence: 0.92,
  });

  const correctionId = repository.createCorrection({
    originalText: "用户对PartnerA有分离焦虑",
    correctedText: "用户对PartnerA没有分离焦虑；分离焦虑主要发生在 Person1 身上",
  });

  const facts = repository.listProfileFacts(20);
  const corrections = repository.listRecentCorrections(5);

  assert.equal(facts.some((fact) => fact.id === factId), false);
  assert.equal(corrections[0].id, correctionId);
  assert.equal(corrections[0].targetType, "profile_fact");
  assert.equal(corrections[0].targetId, factId);
  assert.equal(typeof corrections[0].appliedAt, "string");
});

test("correction retracts a clearly matched memory event from default memory event list", () => {
  const repository = createRepository();
  const conversation = repository.createConversation("main");
  const userMessage = repository.createMessage(conversation.id, "user", "Person1 那天只是 kiss goodbye，不是分手。");
  const eventId = repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户与 Person1 的约会关系已结束，用户主动提出分手",
    score: 0.9,
    occurredAt: "2026-05-05",
  });

  repository.createCorrection({
    originalText: "用户与 Person1 的约会关系已结束，用户主动提出分手",
    correctedText: "Person1 的 kiss goodbye 只是日常 goodbye，不代表关系结束或分手",
  });

  const events = repository.listMemoryEvents(20);
  const corrections = repository.listRecentCorrections(5);

  assert.equal(events.some((event) => event.id === eventId), false);
  assert.equal(corrections[0].targetType, "memory_event");
  assert.equal(corrections[0].targetId, eventId);
});

test("correction without a clear target records the correction without retracting unrelated memories", () => {
  const repository = createRepository();
  const factId = repository.upsertProfileFact({
    kind: "relationship",
    value: "PartnerB是武汉人，UNSW 法学博士",
    confidence: 0.9,
  });

  repository.createCorrection({
    originalText: "最长的那个叫 PartnerC",
    correctedText: "PartnerC 是最长关系对象，但细节还没有展开",
  });

  const facts = repository.listProfileFacts(20);
  const corrections = repository.listRecentCorrections(5);

  assert.equal(facts.some((fact) => fact.id === factId), true);
  assert.equal(corrections[0].targetType, null);
  assert.equal(corrections[0].targetId, null);
  assert.equal(corrections[0].appliedAt, null);
});

test("entity cards aggregate active facts and events while excluding retracted memories", () => {
  const repository = createRepository();
  const conversation = repository.createConversation("main");
  const userMessage = repository.createMessage(conversation.id, "user", "Person1 是韩国人。");
  const retractedFactId = repository.upsertProfileFact({
    kind: "relationship",
    value: "与Person1的约会关系已结束，用户主动提出分手",
    confidence: 0.92,
  });
  repository.upsertProfileFact({
    kind: "relationship",
    value: "Person1 是用户近期重要的亲密关系对象，关系状态仍在变化",
    confidence: 0.82,
  });
  repository.createMemoryEvent({
    conversationId: conversation.id,
    sourceMessageId: userMessage.id,
    summary: "用户描述 Person1：Person1 特地从 Kings Cross 下班后绕路来看用户",
    score: 0.8,
    occurredAt: "2026-05-06",
  });
  repository.createCorrection({
    originalText: "与Person1的约会关系已结束，用户主动提出分手",
    correctedText: "Person1 的关系状态仍在变化，不能说已经分手",
  });

  const [card] = repository.findEntityCards(["Person1"]);

  assert.equal(card.name, "Person1");
  assert.equal(card.facts.some((fact) => fact.id === retractedFactId), false);
  assert.equal(card.facts.some((fact) => /关系状态仍在变化/.test(fact.value)), true);
  assert.equal(card.events.some((event) => /Kings Cross/.test(event.summary)), true);
});

test("entity cards derive a conservative relationship state from conflicting relationship evidence", () => {
  const repository = createRepository();
  repository.upsertProfileFact({
    kind: "relationship",
    value: "与 Person1 的约会关系已结束",
    confidence: 0.8,
  });
  repository.upsertProfileFact({
    kind: "relationship",
    value: "Person1 是用户近期重要的亲密关系对象，关系状态仍在变化",
    confidence: 0.82,
  });

  const [card] = repository.findEntityCards(["Person1"]);

  assert.equal(card.relationshipState.label, "conflicting_or_changing");
  assert.match(card.relationshipState.guidance, /不要直接说/);
  assert.match(card.relationshipState.guidance, /除非用户最新明确表述支持/);
});

test("entity cards keep unknown relationship details unknown", () => {
  const repository = createRepository();
  repository.upsertProfileFact({
    kind: "relationship",
    value: "用户有一个名叫 PartnerC 的重要他人（具体关系未知）",
    confidence: 0.65,
  });

  const [card] = repository.findEntityCards(["PartnerC"]);

  assert.equal(card.relationshipState.label, "unknown");
  assert.match(card.relationshipState.guidance, /不要补全关系类型/);
});
