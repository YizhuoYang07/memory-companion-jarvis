import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { getEntityDefinition } from "./entities.js";

export function createDatabase(databasePath, { now = () => new Date() } = {}) {
  ensureParentDirectory(databasePath);
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schemaSql);
  migrateSchema(db);
  return createRepository(db, now);
}

function ensureParentDirectory(databasePath) {
  const parentDir = path.dirname(databasePath);
  fs.mkdirSync(parentDir, { recursive: true });
}

function migrateSchema(db) {
  ensureColumn(db, "profile_facts", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "profile_facts", "status_reason", "TEXT");
  ensureColumn(db, "profile_facts", "status_updated_at", "TEXT");
  ensureColumn(db, "memory_events", "status", "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, "memory_events", "status_reason", "TEXT");
  ensureColumn(db, "memory_events", "status_updated_at", "TEXT");
  ensureColumn(db, "corrections", "target_type", "TEXT");
  ensureColumn(db, "corrections", "target_id", "TEXT");
  ensureColumn(db, "corrections", "applied_at", "TEXT");
}

function ensureColumn(db, tableName, columnName, definition) {
  const existing = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (existing.some((column) => column.name === columnName)) {
    return;
  }
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
}

function createRepository(db, now) {
  return {
    createConversation(title) {
      const id = randomUUID();
      const normalizedTitle = title?.trim() || "main";
      db.prepare(
        `INSERT INTO conversations (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`
      ).run(id, normalizedTitle, nowIso(now), nowIso(now));
      return this.getConversation(id);
    },

    getConversation(id) {
      return db.prepare(
        `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
         FROM conversations
         WHERE id = ?`
      ).get(id) ?? null;
    },

    updateConversation(conversationId, title) {
      const normalizedTitle = title?.trim() || "main";
      const updatedAt = nowIso(now);
      const result = db.prepare(
        `UPDATE conversations
         SET title = ?, updated_at = ?
         WHERE id = ?`
      ).run(normalizedTitle, updatedAt, conversationId);
      if (result.changes === 0) {
        return null;
      }
      return this.getConversation(conversationId);
    },

    deleteConversation(conversationId) {
      const result = db.prepare(
        `DELETE FROM conversations WHERE id = ?`
      ).run(conversationId);
      return result.changes > 0;
    },

    getConversationByExternalKey(externalKey) {
      const row = db.prepare(
        `SELECT c.id, c.title, c.created_at AS createdAt, c.updated_at AS updatedAt
         FROM external_conversations ec
         JOIN conversations c ON c.id = ec.conversation_id
         WHERE ec.external_key = ?`
      ).get(externalKey);
      return row ?? null;
    },

    linkConversationExternalKey(conversationId, externalKey) {
      db.prepare(
        `INSERT OR REPLACE INTO external_conversations (external_key, conversation_id, created_at)
         VALUES (?, ?, ?)`
      ).run(externalKey, conversationId, nowIso(now));
    },

    listConversations() {
      return db.prepare(
        `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
         FROM conversations
         ORDER BY updated_at DESC, created_at DESC`
      ).all();
    },

    listMessages(conversationId) {
      return db.prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.sequence,
                m.created_at AS createdAt, em.external_key AS externalMessageKey
         FROM messages
         m LEFT JOIN external_messages em ON em.message_id = m.id
         WHERE m.conversation_id = ?
         ORDER BY m.sequence ASC`
      ).all(conversationId);
    },

    getMessageByExternalKey(externalKey) {
      const row = db.prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.sequence,
                m.created_at AS createdAt, em.external_key AS externalMessageKey
         FROM external_messages em
         JOIN messages m ON m.id = em.message_id
         WHERE em.external_key = ?`
      ).get(externalKey);
      return row ?? null;
    },

    createMessage(conversationId, role, text) {
      const id = randomUUID();
      const nextSequence =
        db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS nextSequence FROM messages WHERE conversation_id = ?")
          .get(conversationId).nextSequence;
      const createdAt = nowIso(now);
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, text, sequence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, conversationId, role, text, nextSequence, createdAt);
      db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(createdAt, conversationId);
      return db.prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.sequence,
                m.created_at AS createdAt, em.external_key AS externalMessageKey
         FROM messages
         m LEFT JOIN external_messages em ON em.message_id = m.id
         WHERE m.id = ?`
      ).get(id);
    },

    linkMessageExternalKey(messageId, conversationId, externalKey) {
      db.prepare(
        `INSERT OR REPLACE INTO external_messages (external_key, message_id, conversation_id, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(externalKey, messageId, conversationId, nowIso(now));
    },

    findRelevantMessages(queryTokens, conversationId, limit = 8) {
      const rows = db.prepare(
        `SELECT id, conversation_id AS conversationId, role, text, sequence, created_at AS createdAt
         FROM messages
         ORDER BY created_at DESC
         LIMIT 200`
      ).all();
      return rankByTokenOverlap(rows, (row) => row.text, queryTokens, limit, (row) => row.conversationId === conversationId ? 1.25 : 1);
    },

    listRecentMessages(conversationId, limit = 6) {
      return db.prepare(
        `SELECT id, conversation_id AS conversationId, role, text, sequence, created_at AS createdAt
         FROM messages
         WHERE conversation_id = ?
         ORDER BY sequence DESC
         LIMIT ?`
      ).all(conversationId, limit).reverse();
    },

    createMemoryEvent({ conversationId, sourceMessageId, summary, score = 0.5, occurredAt = null }) {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO memory_events (
           id, conversation_id, source_message_id, summary, score, occurred_at, created_at,
           status, status_reason, status_updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`
      ).run(id, conversationId, sourceMessageId, summary, score, occurredAt || nowIso(now), nowIso(now), nowIso(now));
      return id;
    },

    listMemoryEvents(limit = 50) {
      return db.prepare(
        `SELECT id, conversation_id AS conversationId, source_message_id AS sourceMessageId,
                summary, score, occurred_at AS occurredAt, created_at AS createdAt,
                status, status_reason AS statusReason, status_updated_at AS statusUpdatedAt
         FROM memory_events
         WHERE status = 'active'
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT ?`
      ).all(limit);
    },

    findRelevantMemoryEvents(queryTokens, limit = 6) {
      const rows = db.prepare(
        `SELECT id, conversation_id AS conversationId, source_message_id AS sourceMessageId,
                summary, score, occurred_at AS occurredAt, created_at AS createdAt,
                status, status_reason AS statusReason, status_updated_at AS statusUpdatedAt
         FROM memory_events
         WHERE status = 'active'
         ORDER BY occurred_at DESC, created_at DESC
         LIMIT 200`
      ).all();
      return rankByTokenOverlap(rows, (row) => row.summary, queryTokens, limit, (row) => Number(row.score) || 1);
    },

    upsertProfileFact({ kind, value, confidence = 0.6, evidenceMessageId = null }) {
      const existing = db.prepare(
        `SELECT id, confidence, status
         FROM profile_facts
         WHERE kind = ? AND value = ?`
      ).get(kind, value);
      const timestamp = nowIso(now);
      if (existing) {
        const nextConfidence = Math.max(Number(existing.confidence) || 0, confidence);
        db.prepare(
          `UPDATE profile_facts
           SET confidence = ?, evidence_message_id = COALESCE(?, evidence_message_id), updated_at = ?
           WHERE id = ?`
        ).run(nextConfidence, evidenceMessageId, timestamp, existing.id);
        return existing.id;
      }

      const id = randomUUID();
      db.prepare(
        `INSERT INTO profile_facts (
           id, kind, value, confidence, evidence_message_id, created_at, updated_at,
           status, status_reason, status_updated_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`
      ).run(id, kind, value, confidence, evidenceMessageId, timestamp, timestamp, timestamp);
      return id;
    },

    listProfileFacts(limit = 50) {
      return db.prepare(
        `SELECT id, kind, value, confidence, evidence_message_id AS evidenceMessageId,
                created_at AS createdAt, updated_at AS updatedAt,
                status, status_reason AS statusReason, status_updated_at AS statusUpdatedAt
         FROM profile_facts
         WHERE status = 'active'
         ORDER BY confidence DESC, updated_at DESC
         LIMIT ?`
      ).all(limit);
    },

    deleteProfileFact(id) {
      return db.prepare(`DELETE FROM profile_facts WHERE id = ?`).run(id);
    },

    findRelevantProfileFacts(queryTokens, limit = 6) {
      const rows = db.prepare(
        `SELECT id, kind, value, confidence, evidence_message_id AS evidenceMessageId,
                created_at AS createdAt, updated_at AS updatedAt,
                status, status_reason AS statusReason, status_updated_at AS statusUpdatedAt
         FROM profile_facts
         WHERE status = 'active'
         ORDER BY updated_at DESC
         LIMIT 200`
      ).all();
      return rankByTokenOverlap(rows, (row) => `${row.kind} ${row.value}`, queryTokens, limit, (row) => Number(row.confidence) || 1);
    },

    findEntityCards(entityNames, { factsLimit = 8, eventsLimit = 8 } = {}) {
      return entityNames
        .map((name) => buildEntityCard(db, name, { factsLimit, eventsLimit }))
        .filter(Boolean);
    },

    logRetrieval({ conversationId, userMessageId, query, retrieved }) {
      db.prepare(
        `INSERT INTO retrieval_logs (id, conversation_id, user_message_id, query, retrieved_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), conversationId, userMessageId, query, JSON.stringify(retrieved), nowIso(now));
    },

    getMessagesForDate(date) {
      return db.prepare(
        `SELECT id, conversation_id AS conversationId, role, text, sequence, created_at AS createdAt
         FROM messages
         WHERE substr(created_at, 1, 10) = ?
         ORDER BY created_at ASC, sequence ASC`
      ).all(date);
    },

    getProfileFactsForDate(date) {
      return db.prepare(
        `SELECT id, kind, value, confidence, evidence_message_id AS evidenceMessageId,
                created_at AS createdAt, updated_at AS updatedAt,
                status, status_reason AS statusReason, status_updated_at AS statusUpdatedAt
         FROM profile_facts
         WHERE status = 'active' AND substr(updated_at, 1, 10) = ?
         ORDER BY confidence DESC, updated_at DESC`
      ).all(date);
    },

    upsertReflection({ reflectionDate, summary, openLoops, profileCandidates }) {
      const existing = db.prepare(
        `SELECT id FROM reflections WHERE reflection_date = ?`
      ).get(reflectionDate);
      const payload = [summary, JSON.stringify(openLoops), JSON.stringify(profileCandidates), nowIso(now)];
      if (existing) {
        db.prepare(
          `UPDATE reflections
           SET summary = ?, open_loops_json = ?, profile_candidates_json = ?, created_at = ?
           WHERE reflection_date = ?`
        ).run(...payload, reflectionDate);
        return existing.id;
      }

      const id = randomUUID();
      db.prepare(
        `INSERT INTO reflections (id, reflection_date, summary, open_loops_json, profile_candidates_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, reflectionDate, ...payload);
      return id;
    },

    getReflection(reflectionDate) {
      const row = db.prepare(
        `SELECT id, reflection_date AS reflectionDate, summary,
                open_loops_json AS openLoopsJson,
                profile_candidates_json AS profileCandidatesJson,
                created_at AS createdAt
         FROM reflections
         WHERE reflection_date = ?`
      ).get(reflectionDate);
      return row ? deserializeReflection(row) : null;
    },

    getLatestReflection() {
      const row = db.prepare(
        `SELECT id, reflection_date AS reflectionDate, summary,
                open_loops_json AS openLoopsJson,
                profile_candidates_json AS profileCandidatesJson,
                created_at AS createdAt
         FROM reflections
         ORDER BY reflection_date DESC, created_at DESC
         LIMIT 1`
      ).get();
      return row ? deserializeReflection(row) : null;
    },

    listAllReflections() {
      const rows = db.prepare(
        `SELECT id, reflection_date AS reflectionDate, summary,
                open_loops_json AS openLoopsJson,
                profile_candidates_json AS profileCandidatesJson,
                created_at AS createdAt
         FROM reflections
         ORDER BY reflection_date DESC`
      ).all();
      return rows.map(deserializeReflection);
    },

    getCompletionRequest(requestKey) {
      const row = db.prepare(
        `SELECT request_key AS requestKey, response_json AS responseJson, created_at AS createdAt
         FROM completion_requests
         WHERE request_key = ?`
      ).get(requestKey);
      return row
        ? {
            requestKey: row.requestKey,
            response: JSON.parse(row.responseJson),
            createdAt: row.createdAt,
          }
        : null;
    },

    saveCompletionRequest({ requestKey, response }) {
      db.prepare(
        `INSERT OR REPLACE INTO completion_requests (request_key, response_json, created_at)
         VALUES (?, ?, ?)`
      ).run(requestKey, JSON.stringify(response), nowIso(now));
    },

    saveMessageEmbedding(messageId, embedding, model) {
      const buffer = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare(
        `INSERT OR REPLACE INTO message_embeddings (message_id, embedding_blob, model, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(messageId, buffer, model, nowIso(now));
    },

    saveMemoryEventEmbedding(memoryEventId, embedding, model) {
      const buffer = Buffer.from(new Float32Array(embedding).buffer);
      db.prepare(
        `INSERT OR REPLACE INTO memory_event_embeddings (memory_event_id, embedding_blob, model, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(memoryEventId, buffer, model, nowIso(now));
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
         WHERE me.status = 'active'
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
         WHERE me.status = 'active' AND mee.memory_event_id IS NULL
         ORDER BY me.occurred_at DESC
         LIMIT ?`
      ).all(limit);
    },

    createCorrection({ originalText, correctedText, sourceMessageId = null, conversationId = null }) {
      const id = randomUUID();
      const timestamp = nowIso(now);
      const target = findCorrectionTarget(db, originalText);
      db.prepare(
        `INSERT INTO corrections (
           id, original_text, corrected_text, source_message_id, conversation_id, created_at,
           target_type, target_id, applied_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        originalText,
        correctedText,
        sourceMessageId,
        conversationId,
        timestamp,
        target?.type ?? null,
        target?.id ?? null,
        target ? timestamp : null,
      );

      if (target) {
        markMemoryItemStatus(db, target.type, target.id, "retracted", correctedText, timestamp);
      }

      return id;
    },

    listRecentCorrections(limit = 10) {
      return db.prepare(
        `SELECT id, original_text AS originalText, corrected_text AS correctedText,
                source_message_id AS sourceMessageId, conversation_id AS conversationId,
                created_at AS createdAt, target_type AS targetType, target_id AS targetId,
                applied_at AS appliedAt
         FROM corrections
         ORDER BY created_at DESC
         LIMIT ?`
      ).all(limit);
    },
  };
}

function deserializeReflection(row) {
  return {
    id: row.id,
    reflectionDate: row.reflectionDate,
    summary: row.summary,
    openLoops: JSON.parse(row.openLoopsJson || "[]"),
    profileCandidates: JSON.parse(row.profileCandidatesJson || "[]"),
    createdAt: row.createdAt,
  };
}

function buildEntityCard(db, canonicalName, { factsLimit, eventsLimit }) {
  const definition = getEntityDefinition(canonicalName);
  if (!definition) {
    return null;
  }

  const factRows = db.prepare(
    `SELECT id, kind, value, confidence, evidence_message_id AS evidenceMessageId,
            created_at AS createdAt, updated_at AS updatedAt
     FROM profile_facts
     WHERE status = 'active'
     ORDER BY confidence DESC, updated_at DESC
     LIMIT 500`
  ).all();
  const eventRows = db.prepare(
    `SELECT id, summary, score, occurred_at AS occurredAt, created_at AS createdAt
     FROM memory_events
     WHERE status = 'active'
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT 500`
  ).all();

  const facts = factRows
    .filter((row) => textMentionsAnyAlias(`${row.kind} ${row.value}`, definition.aliases))
    .slice(0, factsLimit);
  const events = eventRows
    .filter((row) => textMentionsAnyAlias(row.summary, definition.aliases))
    .slice(0, eventsLimit);

  if (facts.length === 0 && events.length === 0) {
    return null;
  }

  return {
    name: definition.canonicalName,
    aliases: definition.aliases,
    relationshipState: deriveRelationshipState(definition.canonicalName, facts, events),
    facts,
    events,
  };
}

function textMentionsAnyAlias(text, aliases) {
  const normalized = String(text || "");
  return aliases.some((alias) => normalized.includes(alias));
}

function deriveRelationshipState(canonicalName, facts, events) {
  const evidence = [
    ...facts.map((fact) => fact.value),
    ...events.map((event) => event.summary),
  ].filter(Boolean);
  const joined = evidence.join("\n");
  const signals = [];

  const hasEndedSignal = /(已结束|分手|断联|删除|拉黑|nice fold|不回应|切断联系|放下)/i.test(joined);
  const hasActiveSignal = /(恋爱|女朋友|男友|伴侣|亲密|性关系|发生过性|发展关系|好感|暧昧|在一起|牵挂|attachment|lets see where it goes)/i.test(joined);
  const hasUncertainSignal = /(变化|未定义|探索|不确定|暧昧|早期|lets see|仍在变化)/i.test(joined);
  const hasUnknownSignal = /(未知|细节还没有展开|之后会详细说明|暂时搁置)/i.test(joined);

  if (hasEndedSignal) signals.push("ended_or_past_signal");
  if (hasActiveSignal) signals.push("active_or_intimate_signal");
  if (hasUncertainSignal) signals.push("uncertain_or_changing_signal");
  if (hasUnknownSignal) signals.push("unknown_details_signal");

  if (hasUnknownSignal && !hasActiveSignal) {
    return {
      label: "unknown",
      confidence: 0.55,
      guidance: `${canonicalName} 的关系细节不足。不要补全关系类型，只说明已知信息和未知部分。`,
      signals,
    };
  }

  if (hasEndedSignal && hasActiveSignal) {
    return {
      label: "conflicting_or_changing",
      confidence: 0.6,
      guidance: `${canonicalName} 的关系证据存在冲突或处于变化中。不要直接说“已经结束”“正在恋爱”这类单一状态，除非用户最新明确表述支持。`,
      signals,
    };
  }

  if (hasUncertainSignal) {
    return {
      label: "uncertain_or_changing",
      confidence: 0.68,
      guidance: `${canonicalName} 的关系状态应表达为未定义/变化中，不要写死成男友、前任或分手。`,
      signals,
    };
  }

  if (hasEndedSignal) {
    return {
      label: "past_or_ended",
      confidence: 0.7,
      guidance: `${canonicalName} 看起来主要属于过往关系/已处理连接；如要判断当前状态，仍需看最新明确证据。`,
      signals,
    };
  }

  if (hasActiveSignal) {
    return {
      label: "active_or_important",
      confidence: 0.7,
      guidance: `${canonicalName} 是当前或长期重要关系对象；避免从单条行为过度推断精确关系标签。`,
      signals,
    };
  }

  return {
    label: "insufficient_evidence",
    confidence: 0.4,
    guidance: `${canonicalName} 的关系状态证据不足。只回答 facts/events 中明确出现的内容。`,
    signals,
  };
}

function rankByTokenOverlap(rows, textSelector, queryTokens, limit, weightSelector = () => 1) {
  const uniqueQueryTokens = Array.from(new Set(queryTokens));
  return rows
    .map((row) => {
      const rowTokens = tokenize(textSelector(row));
      let overlap = 0;
      for (const token of uniqueQueryTokens) {
        if (rowTokens.has(token)) {
          overlap += 1;
        }
      }
      return {
        row,
        score: overlap * weightSelector(row),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.row);
}

function findCorrectionTarget(db, originalText) {
  const original = normalizeCorrectionText(originalText);
  if (!original) {
    return null;
  }

  const factRows = db.prepare(
    `SELECT id, kind, value, confidence, updated_at AS updatedAt
     FROM profile_facts
     WHERE status = 'active'
     ORDER BY updated_at DESC
     LIMIT 200`
  ).all();
  const eventRows = db.prepare(
    `SELECT id, summary, score, occurred_at AS occurredAt
     FROM memory_events
     WHERE status = 'active'
     ORDER BY occurred_at DESC, created_at DESC
     LIMIT 200`
  ).all();

  const candidates = [
    ...factRows.map((row) => ({
      type: "profile_fact",
      id: row.id,
      text: `${row.kind} ${row.value}`,
      weight: 1.1 * (Number(row.confidence) || 0.5),
    })),
    ...eventRows.map((row) => ({
      type: "memory_event",
      id: row.id,
      text: row.summary,
      weight: Number(row.score) || 0.5,
    })),
  ];

  let best = null;
  for (const candidate of candidates) {
    const score = scoreCorrectionCandidate(original, candidate.text) * candidate.weight;
    if (!best || score > best.score) {
      best = { ...candidate, score };
    }
  }

  // Conservative threshold: corrections should retire old memories only when
  // the original text clearly points at an existing fact/event.
  if (!best || best.score < 0.55) {
    return null;
  }

  return { type: best.type, id: best.id };
}

function scoreCorrectionCandidate(originalNormalized, candidateText) {
  const candidateNormalized = normalizeCorrectionText(candidateText);
  if (!candidateNormalized) {
    return 0;
  }

  if (candidateNormalized.includes(originalNormalized) && originalNormalized.length >= 4) {
    return 1;
  }

  if (originalNormalized.includes(candidateNormalized) && candidateNormalized.length >= 8) {
    return 0.95;
  }

  const originalTokens = correctionTokens(originalNormalized);
  const candidateTokens = correctionTokens(candidateNormalized);
  if (originalTokens.size === 0 || candidateTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of originalTokens) {
    if (candidateTokens.has(token)) {
      overlap += 1;
    }
  }

  if (overlap < 3) {
    return 0;
  }

  return overlap / Math.min(originalTokens.size, candidateTokens.size);
}

function markMemoryItemStatus(db, targetType, targetId, status, reason, timestamp) {
  if (targetType === "profile_fact") {
    db.prepare(
      `UPDATE profile_facts
       SET status = ?, status_reason = ?, status_updated_at = ?
       WHERE id = ? AND status = 'active'`
    ).run(status, reason, timestamp, targetId);
    return;
  }

  if (targetType === "memory_event") {
    db.prepare(
      `UPDATE memory_events
       SET status = ?, status_reason = ?, status_updated_at = ?
       WHERE id = ? AND status = 'active'`
    ).run(status, reason, timestamp, targetId);
  }
}

function normalizeCorrectionText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function correctionTokens(text) {
  const normalized = String(text || "").toLowerCase();
  const tokens = new Set(
    normalized
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 2)
  );
  const cjkChars = [...normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]/g)].map((match) => match[0]);
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.add(cjkChars[i] + cjkChars[i + 1]);
  }
  return tokens;
}

function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  const englishTokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
  const cjkTokens = [...normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)]
    .map((match) => match[0]);
  return new Set([...englishTokens, ...cjkTokens]);
}

function nowIso(now) {
  return now().toISOString();
}

const schemaSql = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  text TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_sequence
  ON messages (conversation_id, sequence);

CREATE TABLE IF NOT EXISTS memory_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  score REAL NOT NULL DEFAULT 0.5,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  status_reason TEXT,
  status_updated_at TEXT
);

CREATE TABLE IF NOT EXISTS profile_facts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  status_reason TEXT,
  status_updated_at TEXT,
  UNIQUE(kind, value)
);

CREATE TABLE IF NOT EXISTS retrieval_logs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  retrieved_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reflections (
  id TEXT PRIMARY KEY,
  reflection_date TEXT NOT NULL UNIQUE,
  summary TEXT NOT NULL,
  open_loops_json TEXT NOT NULL,
  profile_candidates_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS completion_requests (
  request_key TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_conversations (
  external_key TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_messages (
  external_key TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_external_messages_conversation
  ON external_messages (conversation_id);

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

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  original_text TEXT NOT NULL,
  corrected_text TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  applied_at TEXT
);
`;
