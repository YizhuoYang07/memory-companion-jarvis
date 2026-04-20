---
title: Retrieval 重构执行文档
description: 将 Jarvis 的检索和提取从英文 token-overlap 迁移到 embedding-based 语义检索 + LLM 提取。这份文档是给执行 AI 看的，包含完整上下文。
last_updated: 2025-03-30
---

# Retrieval 重构执行文档

## 0. 阅读说明

**这份文档的读者是执行重构任务的 AI agent。** 你没有这个项目之前的对话上下文，所以本文档会从零讲清楚：项目是什么、当前代码怎么工作、问题在哪、要改成什么、怎么改。

如果你理解了这份文档的所有内容，你应该能在不问任何人的情况下完成重构。

---

## 1. 项目背景

### 1.1 Jarvis 是什么

Jarvis 是一个**单用户个人记忆系统**。用户是一位中文母语者，她希望有一个能跨对话记住她说过什么的 AI 伴侣。

技术栈：
- **后端**：Node.js 24+（利用内建 `node:sqlite`），零第三方依赖，ES modules
- **数据库**：SQLite（通过 `node:sqlite` 的 `DatabaseSync`），存储在 `data/memory.db`
- **API**：原生 `node:http` 服务，端口 3030
- **模型**：调用任何 OpenAI-compatible API（当前配置为 `gpt-4.1`）
- **客户端**：SwiftUI iOS + macOS 原生 app
- **部署**：Docker + Caddy HTTPS，云服务器

### 1.2 核心架构流程

```
用户发消息
  → server.js 接收 HTTP 请求
  → chat-service.js 协调整个流程：
      1. ensureConversation() — 获取或创建会话
      2. buildRetrievalContext() — 【retrieval.js】从数据库检索相关记忆
      3. createMessage() — 保存用户消息到 messages 表
      4. logRetrieval() — 记录本次检索结果到 retrieval_logs 表
      5. modelProvider.respond() — 【model-provider.js】调用 LLM 生成回复
         ↳ buildProviderMessages() 把 system prompt + 检索结果 + 近期消息 + 用户消息拼成 messages 数组
      6. createMessage() — 保存助手回复到 messages 表
      7. extractTurnArtifacts() — 【extraction.js】从本轮对话提取 profile facts 和 memory events
      8. createDailyReflection() — 【reflection-service.js】生成当日反思摘要
```

### 1.3 源文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/index.js` | ~25 | 入口，组装依赖，启动服务 |
| `src/config.js` | ~18 | 读取环境变量 |
| `src/server.js` | ~250 | HTTP 路由、认证、限流 |
| `src/chat-service.js` | ~200 | 业务逻辑协调层 |
| `src/retrieval.js` | ~115 | **本次重构核心** — 检索上下文构建 |
| `src/database.js` | ~460 | SQLite 操作 + schema 定义 |
| `src/extraction.js` | ~100 | **本次重构核心** — profile fact 提取 |
| `src/model-provider.js` | ~180 | OpenAI-compatible API 调用 + system prompt |
| `src/reflection-service.js` | ~90 | 每日反思摘要 |

---

## 2. 当前问题（为什么要重构）

### 2.1 问题一：中文完全不可见

项目中有 **三个** `tokenize()` 函数，全部使用英文正则：

**文件 1：`src/retrieval.js` 第 82 行**
```javascript
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}
```

**文件 2：`src/database.js` 第 ~338 行**
```javascript
function tokenize(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3)
  );
}
```

**文件 3：`src/reflection-service.js` 第 ~76 行**
```javascript
function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
}
```

`/[^a-z0-9]+/` 只保留英文字母和数字。所有中文字符会被 split 掉，产生空字符串，被 `.filter(token => token.length >= 3)` 过滤。**结果：中文消息的 token 集合为空，token-overlap 得分永远为 0，在排序中永远不会被选中。**

用户用中文对话 → 她说过的话全部不可检索 → Jarvis 的"记忆"对她来说不存在。

### 2.2 问题二：Profile fact 提取只认英文

**文件：`src/extraction.js` 第 1-13 行**
```javascript
const profileMatchers = [
  { kind: "name", regex: /\bmy name is ([^.!?\n]+)/i },
  { kind: "self_description", regex: /\bi am ([^.!?\n]+)/i },
  { kind: "self_description", regex: /\bi'm ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi prefer ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi like ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi love ([^.!?\n]+)/i },
  { kind: "location", regex: /\bi live in ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi am working on ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi'm working on ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi am building ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi'm building ([^.!?\n]+)/i },
];
```

11 条正则全是英文模式。"我叫[名字]"、"我住在悉尼"、"我在做一个记忆系统"——全部不会被匹配。

### 2.3 问题三：Memory event 摘要是机械截断

`extraction.js` 的 `summarizeEvent()` 只是取第一句话加前缀（"User discussed: ..."），没有语义理解。对中文的句子切分也不准确（`split(/(?<=[.!?])\s+/)` 不匹配中文标点）。

### 2.4 问题四：检索是全表扫描

`database.js` 的 `findRelevantMessages()` 每次加载最近 200 条消息到内存，在 JavaScript 中循环计算 token overlap。数据量小时可以工作，但：

1. 对中文无效（如 2.1 所述）
2. 随着消息增长会越来越慢
3. Token overlap 是词袋模型，无法理解语义相似性（"我很累" 和 "今天精力不好" 零 overlap）

---

## 3. 重构方案

### 3.1 整体策略

分两步走：

| 阶段 | 内容 | 复杂度 |
|------|------|--------|
| **Phase 1** | Embedding 替换 token-overlap + LLM 替换正则提取 | 中 |
| **Phase 2** | Memory dedup（ADD/UPDATE/DELETE）+ sleep-time reflection | 高 |

**本文档只覆盖 Phase 1。** Phase 2 在 Phase 1 稳定后再规划。

### 3.2 Phase 1 变更概览

> **Status（2025-03-30）：Phase 1 已完成。** 所有变更已实现并部署到生产。

```
改动文件：
  src/retrieval.js      — 重写，用 embedding 向量搜索替换 token-overlap ✅
  src/database.js       — 新增 embedding 相关表和查询方法 ✅
  src/extraction.js     — 重写，用 LLM 调用替换正则匹配 ✅
  src/config.js         — 新增 embedding 模型配置 ✅
  src/chat-service.js   — 接受 config，prepareResponse/completePreparedResponse 变为 async ✅
  src/reflection-service.js — 修复 tokenize 的中文问题 ✅

新增文件：
  src/embedding.js      — embedding 计算和向量相似度工具函数 ✅
  scripts/backfill-embeddings.js — 历史数据 embedding 回填脚本 ✅
  scripts/seed-data.js  — 冷启动数据灌入脚本（25 facts + 20 events）✅

未改动（实际与原计划的偏差）：
  src/model-provider.js — 计划列为改动目标，但实际无需修改。
                          embedding API 调用路由到独立的 src/embedding.js；
                          extraction LLM 调用在 src/extraction.js 内部完成。
  src/index.js          — 仅新增了 config 参数传递 ✅
  src/server.js         — 仅补充了对 async chat-service 方法的 await ✅
```

---

## 4. 详细执行计划

### 4.1 新增 embedding 配置（config.js）

在 `readConfig()` 中新增：

```javascript
// 新增配置项
embeddingBaseUrl: env.EMBEDDING_BASE_URL?.trim() || env.OPENAI_BASE_URL?.trim() || null,
embeddingApiKey: env.EMBEDDING_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || null,
embeddingModel: env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
extractionModel: env.EXTRACTION_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null,
```

对应 `.env.example` 新增：

```
# Embedding model (defaults to same provider as chat model)
# EMBEDDING_BASE_URL=https://api.openai.com/v1
# EMBEDDING_API_KEY=
EMBEDDING_MODEL=text-embedding-3-small

# Extraction model (cheap model for profile/memory extraction, defaults to chat model)
# EXTRACTION_MODEL=gpt-4.1-nano
```

**设计决策**：embedding 和 extraction 默认复用主模型的 base URL 和 API key，减少配置负担。只在需要用不同provider时才需要额外配置。

### 4.2 新增 embedding 模块（embedding.js）

创建 `src/embedding.js`：

```javascript
/**
 * 调用 OpenAI-compatible embedding API。
 * 
 * @param {object} config - { embeddingBaseUrl, embeddingApiKey, embeddingModel }
 * @param {string|string[]} input - 要编码的文本（单条或批量）
 * @returns {Promise<number[][]>} 向量数组
 */
export async function computeEmbeddings(config, input) {
  const texts = Array.isArray(input) ? input : [input];
  
  const response = await fetch(
    `${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  // OpenAI 返回格式: { data: [{ embedding: [...], index: 0 }, ...] }
  return payload.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/**
 * 计算两个向量的余弦相似度。
 */
export function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
```

**关于维度**：`text-embedding-3-small` 输出 1536 维浮点向量。每个向量约 6KB。10000 条消息的索引约 60MB 内存。对单用户系统完全可接受。

### 4.3 修改 database.js — 新增 embedding 存储

#### 4.3.1 新增表

在 `schemaSql` 中追加：

```sql
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_event_embeddings (
  memory_event_id TEXT PRIMARY KEY REFERENCES memory_events(id) ON DELETE CASCADE,
  embedding_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

**为什么用 BLOB 而不是 JSON**：`Float32Array` → `Buffer` 存 BLOB，每向量 6KB（1536 * 4 bytes）。JSON 存储同样数据约 20KB。BLOB 节省 3 倍空间，读写也更快。

#### 4.3.2 新增 repository 方法

在 `createRepository()` 返回对象中追加：

```javascript
saveMessageEmbedding(messageId, embedding, model) {
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare(
    `INSERT OR REPLACE INTO message_embeddings (message_id, embedding_blob, model, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(messageId, buffer, model, nowIso());
},

saveMemoryEventEmbedding(memoryEventId, embedding, model) {
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare(
    `INSERT OR REPLACE INTO memory_event_embeddings (memory_event_id, embedding_blob, model, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(memoryEventId, buffer, model, nowIso());
},

getAllMessageEmbeddings() {
  const rows = db.prepare(
    `SELECT me.message_id AS messageId, me.embedding_blob AS embeddingBlob,
            m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt
     FROM message_embeddings me
     JOIN messages m ON m.id = me.message_id
     ORDER BY m.created_at DESC`
  ).all();

  return rows.map((row) => ({
    messageId: row.messageId,
    embedding: new Float32Array(row.embeddingBlob.buffer, row.embeddingBlob.byteOffset, row.embeddingBlob.byteLength / 4),
    conversationId: row.conversationId,
    role: row.role,
    text: row.text,
    createdAt: row.createdAt,
  }));
},

getAllMemoryEventEmbeddings() {
  const rows = db.prepare(
    `SELECT mee.memory_event_id AS memoryEventId, mee.embedding_blob AS embeddingBlob,
            me.summary, me.score, me.occurred_at AS occurredAt
     FROM memory_event_embeddings mee
     JOIN memory_events me ON me.id = mee.memory_event_id
     ORDER BY me.occurred_at DESC`
  ).all();

  return rows.map((row) => ({
    memoryEventId: row.memoryEventId,
    embedding: new Float32Array(row.embeddingBlob.buffer, row.embeddingBlob.byteOffset, row.embeddingBlob.byteLength / 4),
    summary: row.summary,
    score: row.score,
    occurredAt: row.occurredAt,
  }));
},

getMessagesWithoutEmbeddings(limit = 100) {
  return db.prepare(
    `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt
     FROM messages m
     LEFT JOIN message_embeddings me ON me.message_id = m.id
     WHERE me.message_id IS NULL
     ORDER BY m.created_at DESC
     LIMIT ?`
  ).all(limit);
},

getMemoryEventsWithoutEmbeddings(limit = 100) {
  return db.prepare(
    `SELECT me.id, me.summary
     FROM memory_events me
     LEFT JOIN memory_event_embeddings mee ON mee.memory_event_id = me.id
     WHERE mee.memory_event_id IS NULL
     ORDER BY me.occurred_at DESC
     LIMIT ?`
  ).all(limit);
},
```

#### 4.3.3 保留旧方法但标记

**不要删除** `findRelevantMessages()`、`findRelevantMemoryEvents()`、`findRelevantProfileFacts()` 和 `rankByTokenOverlap()`。保留它们作为 fallback（当 embedding 不可用时）。在 retrieval.js 中做条件判断。

### 4.4 重写 retrieval.js

这是最核心的改动。

#### 4.4.1 新的 `buildRetrievalContext()`

```javascript
import { computeEmbeddings, cosineSimilarity } from "./embedding.js";

export async function buildRetrievalContext(repository, conversationId, userText, config) {
  const recentMessages = repository.listRecentMessages(conversationId, 6);

  // 如果没有 embedding 配置，fallback 到旧的 token-overlap 方式
  if (!config?.embeddingBaseUrl || !config?.embeddingApiKey) {
    return buildRetrievalContextLegacy(repository, conversationId, userText);
  }

  // 1. 计算用户消息的 embedding
  const [queryEmbedding] = await computeEmbeddings(config, userText);

  // 2. 语义搜索 messages
  const allMessageEmbeddings = repository.getAllMessageEmbeddings();
  const scoredMessages = allMessageEmbeddings
    .map((item) => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding)
        * (item.conversationId === conversationId ? 1.15 : 1.0),  // 同会话小幅加权
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8);

  const relatedMessages = dedupeById([
    ...recentMessages,
    ...scoredMessages.map((item) => ({
      id: item.messageId,
      conversationId: item.conversationId,
      role: item.role,
      text: item.text,
      createdAt: item.createdAt,
    })),
  ]).slice(-8);

  // 3. 语义搜索 memory events
  const allEventEmbeddings = repository.getAllMemoryEventEmbeddings();
  const scoredEvents = allEventEmbeddings
    .map((item) => ({
      ...item,
      similarity: cosineSimilarity(queryEmbedding, item.embedding) * (Number(item.score) || 1),
    }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5)
    .map((item) => ({
      id: item.memoryEventId,
      summary: item.summary,
      score: item.score,
      occurredAt: item.occurredAt,
    }));

  // 4. profile facts 仍然用旧方法（数量少，不需要 embedding）
  const profileFacts = repository.listProfileFacts(10);

  // 5. 最新反思
  const latestReflection = repository.getLatestReflection();

  return {
    recentMessages,
    relatedMessages,
    memoryEvents: scoredEvents,
    profileFacts,
    latestReflection,
  };
}
```

**注意事项：**
- 函数签名从 `(repository, conversationId, userText)` 变为 `(repository, conversationId, userText, config)`。这是 **breaking change**，需要同步修改 `chat-service.js` 中的调用。
- 函数从同步变为 **async**。同样需要调用方加 `await`。
- `profileFacts` 暂时不做 embedding 搜索——profile facts 数量通常很少（几十条），直接列出 top 10 即可。Phase 2 再优化。

#### 4.4.2 保留旧实现作为 fallback

```javascript
// 旧实现重命名为 buildRetrievalContextLegacy，保留不动
function buildRetrievalContextLegacy(repository, conversationId, userText) {
  const queryTokens = tokenize(userText);
  const recentMessages = repository.listRecentMessages(conversationId, 6);
  const relatedMessages = dedupeById([
    ...recentMessages,
    ...repository.findRelevantMessages(queryTokens, conversationId, 8),
  ]).slice(-8);
  const memoryEvents = repository.findRelevantMemoryEvents(queryTokens, 5);
  const profileFacts = repository.findRelevantProfileFacts(queryTokens, 5);
  const latestReflection = repository.getLatestReflection();
  return { recentMessages, relatedMessages, memoryEvents, profileFacts, latestReflection };
}
```

#### 4.4.3 修改 chat-service.js

在 `prepareResponse()` 中：

```javascript
// 旧代码：
const retrievalContext = buildRetrievalContext(repository, conversation.id, text);

// 新代码：
const retrievalContext = await buildRetrievalContext(repository, conversation.id, text, config);
```

`prepareResponse()` 需要变为 `async`。它的调用链：
- `prepareResponse()` ← `respond()` (已经是 async) ← server.js handler (已经是 async)
- `prepareResponse()` ← `respondToOpenAiChatCompletion()` (已经是 async) ← server.js handler

所以只需要把 `prepareResponse` 改为 `async` 并在调用处加 `await` 即可。

同时需要在 `createChatService()` 的参数中传入 `config`：

```javascript
// index.js 中：
const chatService = createChatService({ repository, modelProvider, config });
```

### 4.5 embedding 写入时机

在 `chat-service.js` 的 `completePreparedResponse()` 中，当前已有 `extractTurnArtifacts()` 调用。在此处追加 embedding 计算：

```javascript
completePreparedResponse(prepared, assistantText) {
  const assistantMessage = repository.createMessage(prepared.conversation.id, "assistant", assistantText);
  const artifacts = extractTurnArtifacts(prepared.userMessage, assistantMessage);

  for (const event of artifacts.memoryEvents) {
    repository.createMemoryEvent(event);
  }

  for (const fact of artifacts.profileFacts) {
    repository.upsertProfileFact(fact);
  }

  // ★ 新增：异步计算并保存 embedding（不阻塞响应）
  if (config?.embeddingBaseUrl && config?.embeddingApiKey) {
    computeAndSaveEmbeddings(config, repository, prepared.userMessage, assistantMessage, artifacts)
      .catch((err) => console.error("Embedding computation failed:", err));
  }

  // ... 后续 reflection 等不变
}
```

`computeAndSaveEmbeddings` 是一个新的 async helper：

```javascript
async function computeAndSaveEmbeddings(config, repository, userMessage, assistantMessage, artifacts) {
  const textsToEmbed = [userMessage.text, assistantMessage.text];
  const ids = [userMessage.id, assistantMessage.id];

  // 批量计算 message embeddings
  const embeddings = await computeEmbeddings(config, textsToEmbed);
  for (let i = 0; i < ids.length; i++) {
    repository.saveMessageEmbedding(ids[i], embeddings[i], config.embeddingModel);
  }

  // 计算 memory event embeddings
  const eventTexts = artifacts.memoryEvents.map((e) => e.summary);
  if (eventTexts.length > 0) {
    const eventEmbeddings = await computeEmbeddings(config, eventTexts);
    // 注意：需要先拿到 event ID，而 event 在 completePreparedResponse 中已经被 createMemoryEvent 创建了
    // 这里需要调整——把 event ID 记录下来传进来
  }
}
```

**注意**：memory event 的 ID 在 `createMemoryEvent()` 时返回。需要调整 `completePreparedResponse()` 中的循环来收集这些 ID：

```javascript
const eventIds = [];
for (const event of artifacts.memoryEvents) {
  const id = repository.createMemoryEvent(event);
  eventIds.push(id);
}

// 传给 embedding helper
computeAndSaveEmbeddings(config, repository, prepared.userMessage, assistantMessage, artifacts, eventIds)
  .catch((err) => console.error("Embedding computation failed:", err));
```

### 4.6 重写 extraction.js — LLM 替换正则

#### 4.6.1 新的 `extractTurnArtifacts()`

```javascript
/**
 * 用 LLM 从用户消息中提取 profile facts 和 memory event 摘要。
 * 
 * @param {object} userMessage - { id, conversationId, text }
 * @param {object} assistantMessage - { id, conversationId, text }
 * @param {object} config - 需要 extractionModel 或 openAiModel 配置
 * @returns {Promise<{ memoryEvents: array, profileFacts: array }>}
 */
export async function extractTurnArtifacts(userMessage, assistantMessage, config) {
  // 如果没有模型配置，fallback 到旧的正则方式
  if (!config?.openAiBaseUrl || !config?.openAiApiKey) {
    return extractTurnArtifactsLegacy(userMessage, assistantMessage);
  }

  const model = config.extractionModel || config.openAiModel;
  const userText = normalizeWhitespace(userMessage.text);
  const assistantText = normalizeWhitespace(assistantMessage.text);

  if (!userText) {
    return { memoryEvents: [], profileFacts: [] };
  }

  const extractionPrompt = `分析以下对话，提取两类信息。必须用 JSON 返回。

对话内容：
用户: ${userText}
助手: ${assistantText}

请提取：

1. profile_facts: 用户透露的稳定个人事实（姓名、身份、偏好、位置、健康、教育、工作、关系等）。
   格式: [{ "kind": "...", "value": "...", "confidence": 0.0-1.0 }]
   kind 可选值: name, self_description, preference, location, current_focus, health, education, work, relationship, value, hobby
   confidence 反映确定程度（直接陈述 > 间接暗示）

2. memory_events: 值得记住的事件或状态变化。不是每句话都值得记——只提取有长期价值的。
   格式: [{ "summary": "简短摘要（中文）", "score": 0.0-1.0 }]
   score 反映重要程度

返回格式（严格 JSON，不要 markdown 代码块）:
{"profile_facts": [...], "memory_events": [...]}

如果没有值得提取的内容，返回空数组。`;

  try {
    const response = await fetch(
      `${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.openAiApiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          messages: [
            { role: "system", content: "你是一个信息提取器。只输出 JSON，不要解释。" },
            { role: "user", content: extractionPrompt },
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error(`Extraction LLM failed: ${response.status}`);
      return extractTurnArtifactsLegacy(userMessage, assistantMessage);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content?.trim();
    const parsed = JSON.parse(content);

    const profileFacts = (parsed.profile_facts || []).map((fact) => ({
      kind: fact.kind,
      value: fact.value,
      confidence: Math.min(1, Math.max(0, Number(fact.confidence) || 0.6)),
      evidenceMessageId: userMessage.id,
    }));

    const memoryEvents = (parsed.memory_events || []).map((event) => ({
      summary: event.summary,
      score: Math.min(1, Math.max(0, Number(event.score) || 0.5)),
      sourceMessageId: userMessage.id,
      conversationId: userMessage.conversationId,
    }));

    // 助手消息也记一条 event
    if (assistantText) {
      memoryEvents.push({
        summary: `助手回复：${truncate(assistantText, 150)}`,
        score: 0.3,
        sourceMessageId: assistantMessage.id,
        conversationId: assistantMessage.conversationId,
      });
    }

    return { memoryEvents, profileFacts };
  } catch (err) {
    console.error("Extraction failed, falling back to regex:", err);
    return extractTurnArtifactsLegacy(userMessage, assistantMessage);
  }
}
```

#### 4.6.2 保留旧实现

把当前的 `extractTurnArtifacts()` 重命名为 `extractTurnArtifactsLegacy()`，保留所有旧代码不变。

#### 4.6.3 修改调用方

`chat-service.js` 中 `completePreparedResponse()` 需要：
1. `extractTurnArtifacts` 变为 async 调用
2. 传入 config

```javascript
// 旧：
const artifacts = extractTurnArtifacts(prepared.userMessage, assistantMessage);

// 新：
const artifacts = await extractTurnArtifacts(prepared.userMessage, assistantMessage, config);
```

`completePreparedResponse()` 因此也需要变为 `async`。检查调用链：
- `completePreparedResponse()` ← `respond()` 已经是 async ✓
- `completePreparedResponse()` ← `respondToOpenAiChatCompletion()` 已经是 async ✓
- ⚠️ 需要确认 streaming 路径是否也有调用——查看 server.js 的 streaming handler

### 4.7 修复 reflection-service.js 的 tokenize

这是一个附带修复。reflection-service.js 中的 `tokenize()` 也是英文 only，导致每日反思的"主题提取"完全忽略中文。

**最小修复**：用 `Intl.Segmenter` 做中文分词（Node.js 16+ 内建支持），或者更简单地——把每个 CJK 字符当作独立 token：

```javascript
function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  // 英文 token
  const englishTokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
  // CJK 字符（每个字作为 token）
  const cjkTokens = [...normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]/g)]
    .map((match) => match[0]);
  return [...englishTokens, ...cjkTokens];
}
```

这不完美（单字 token 粒度太细），但至少让中文不再不可见。Phase 2 可以用 embedding 替换这部分。

### 4.8 历史数据回填脚本

已有消息和 memory events 没有 embedding。需要写一个一次性回填脚本。

创建 `scripts/backfill-embeddings.js`：

```javascript
import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { computeEmbeddings } from "../src/embedding.js";

const config = readConfig();
const repository = createDatabase(config.databasePath);

async function backfill() {
  console.log("Backfilling message embeddings...");
  const BATCH_SIZE = 50;

  while (true) {
    const messages = repository.getMessagesWithoutEmbeddings(BATCH_SIZE);
    if (messages.length === 0) break;

    const texts = messages.map((m) => m.text);
    const embeddings = await computeEmbeddings(config, texts);

    for (let i = 0; i < messages.length; i++) {
      repository.saveMessageEmbedding(messages[i].id, embeddings[i], config.embeddingModel);
    }

    console.log(`  Embedded ${messages.length} messages`);
  }

  console.log("Backfilling memory event embeddings...");
  while (true) {
    const events = repository.getMemoryEventsWithoutEmbeddings(BATCH_SIZE);
    if (events.length === 0) break;

    const texts = events.map((e) => e.summary);
    const embeddings = await computeEmbeddings(config, texts);

    for (let i = 0; i < events.length; i++) {
      repository.saveMemoryEventEmbedding(events[i].id, embeddings[i], config.embeddingModel);
    }

    console.log(`  Embedded ${events.length} memory events`);
  }

  console.log("Backfill complete.");
}

backfill().catch(console.error);
```

在 `package.json` 中添加：
```json
"backfill-embeddings": "node --env-file-if-exists=.env scripts/backfill-embeddings.js"
```

### 4.9 执行顺序

```
Step 1: src/config.js — 新增 embedding/extraction 配置项
Step 2: src/embedding.js — 创建 embedding 计算模块
Step 3: src/database.js — 新增表和 repository 方法
Step 4: src/extraction.js — LLM extraction + 保留旧实现为 fallback
Step 5: src/retrieval.js — embedding 检索 + 保留旧实现为 fallback
Step 6: src/chat-service.js — 传入 config，处理 async 变更
Step 7: src/reflection-service.js — 修复 tokenize 中文问题
Step 8: .env.example — 新增配置项文档
Step 9: scripts/backfill-embeddings.js — 回填脚本
Step 10: 测试
```

每一步完成后应该能通过 `node --test` 的现有测试。Step 5 之后可以实际测试中文检索。

---

## 5. 数据库 Schema 变更汇总

### 新增表

```sql
CREATE TABLE IF NOT EXISTS message_embeddings (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  embedding_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_event_embeddings (
  memory_event_id TEXT PRIMARY KEY REFERENCES memory_events(id) ON DELETE CASCADE,
  embedding_blob BLOB NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

### 不修改的表

所有 9 个现有表保持不变：conversations, messages, memory_events, profile_facts, retrieval_logs, reflections, completion_requests, external_conversations, external_messages。

---

## 6. API 变更

### 外部 API（server.js 暴露的 HTTP 端点）

**无变更。** 所有改动在内部模块中，API 接口层完全不变。

### 内部接口变更

| 函数 | 变更 | 影响范围 |
|------|------|---------|
| `buildRetrievalContext()` | 新增 `config` 参数，变为 async | chat-service.js |
| `extractTurnArtifacts()` | 新增 `config` 参数，变为 async | chat-service.js |
| `prepareResponse()` | 变为 async | server.js（在 respond 和 stream handler 中） |
| `completePreparedResponse()` | 变为 async | server.js（在 respond 和 stream handler 中） |
| `createChatService()` | 新增 `config` 参数 | index.js |

---

## 7. 测试策略

### 7.1 现有测试

项目有两个测试文件：
- `test/chat-service.test.js` — 测试 chat service 的核心流程
- `test/server.test.js` — 测试 HTTP 端点

使用 Node.js 内建 test runner（`node --test`）。

### 7.2 需要新增的测试

1. **embedding.js 单元测试**：mock fetch，验证 `computeEmbeddings()` 正确解析 API 响应，验证 `cosineSimilarity()` 计算正确
2. **extraction.js 测试**：mock fetch，验证 LLM extraction 能解析 JSON 响应并正确映射到 profileFacts 和 memoryEvents
3. **retrieval.js 测试**：验证 embedding 路径和 legacy fallback 路径都能正确运行
4. **database.js 测试**：验证 embedding BLOB 的存取正确（Float32Array ↔ Buffer 转换）

### 7.3 中文检索验证

手动测试用例：
1. 发送中文消息 "我今天很累，在图书馆待了一天"
2. 稍后发送 "我上次说图书馆的事，你还记得吗？"
3. 验证 retrieval context 中包含第一条消息

---

## 8. 性能预估

| 操作 | 延迟 | 说明 |
|------|------|------|
| 用户消息 embedding 计算 | ~100ms | 单条文本，OpenAI API 调用 |
| 向量搜索（10000 条内存） | ~5ms | 纯 JS 循环，Float32 余弦相似度 |
| LLM extraction | ~500-1000ms | 可异步，不阻塞响应 |
| 回填 1000 条消息 | ~2min | 批量 50 条/次，约 20 次 API 调用 |

**对用户响应延迟的影响**：主链路新增约 100ms（embedding 计算）。extraction 和 embedding 存储异步进行，不影响响应速度。

---

## 9. 风险和注意事项

1. **embedding API 不稳定时**：通过 fallback 到 legacy token-overlap 确保系统不挂。所有新功能都有 `if (!config.embeddingBaseUrl)` 的条件判断。

2. **内存占用**：所有 embedding 在 `getAllMessageEmbeddings()` 时一次性加载到内存。10000 条消息 ≈ 60MB。如果消息超过 50000 条，应该改为分批加载 + 预筛选（比如先按时间窗口筛选最近 30 天的消息）。

3. **embedding 模型更换**：如果以后换模型（维度不同），需要重新回填所有 embedding。`message_embeddings.model` 字段就是为此预留的。可以在检索时检查 model 是否一致，不一致的跳过。

4. **`completePreparedResponse` 变为 async 的连锁影响**：这是最容易出错的地方。需要仔细检查 server.js 中所有调用 `completePreparedResponse` 的地方，确保都加了 `await`。特别注意 streaming 路径。

5. **`extractTurnArtifacts` 的 LLM 调用成本**：每轮对话一次额外 LLM 调用。如果用 gpt-4.1-nano，成本极低（约 $0.0001/次）。如果用主模型 gpt-4.1，成本约 $0.001-0.003/次。建议用独立的 `EXTRACTION_MODEL` 配置。

---

## 10. Phase 2 预览（不在本次执行范围内）

本次不做，但需要知道方向：

1. **Memory dedup（ADD/UPDATE/DELETE）**：参考 Mem0 的两阶段流程。每次提取新 memory event 后，跟向量库中 top-5 相似的已有 event 比较，LLM 决定是 ADD（新增）、UPDATE（合并更新）、DELETE（过时删除）还是 NOOP（不操作）。
2. **Sleep-time 反思**：改造现有的 `reflection-service.js`，在用户不活跃时异步运行，把最近对话经过更深度的 LLM 分析，生成更高质量的 memory events 和 profile facts。
3. **向量索引优化**：当数据量超过阈值时，引入 HNSW 索引或使用 sqlite-vec 扩展，替代全量遍历。
