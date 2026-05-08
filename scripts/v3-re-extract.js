#!/usr/bin/env node
/**
 * V3 Phase 2.5: Re-extract facts/events from all user messages with V3 prompt
 * (outputs claim_type, salience_class).
 *
 * Strategy:
 *   - Use Haiku 4.5 (much cheaper than Sonnet, good enough for extraction)
 *   - Re-extract user message + following assistant message pairs
 *   - Insert new facts/events with V3 fields populated
 *   - Skip insertion if a near-identical item already exists (literal kind+value
 *     match for facts; literal summary match for events)
 *   - Don't touch existing facts/events that aren't duplicates — additive
 *
 * Usage:
 *   node scripts/v3-re-extract.js [--db PATH] [--dry-run] [--limit N] [--from MSG_ID]
 *
 * Env: OPENAI_BASE_URL, OPENAI_API_KEY (Haiku via Anthropic).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

function parseArgs(argv) {
  const args = { db: "data/memory.db", dryRun: false, limit: 0, from: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) { args.db = argv[++i]; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
    else if (argv[i] === "--limit" && argv[i + 1]) { args.limit = parseInt(argv[++i]); }
    else if (argv[i] === "--from" && argv[i + 1]) { args.from = argv[++i]; }
  }
  return args;
}

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

const VALID_FACT_KINDS = new Set([
  "name", "self_description", "preference", "location",
  "current_focus", "health", "education", "work", "relationship", "value", "hobby",
]);

const VALID_CLAIM_TYPES = new Set(["observed", "inferred", "reported", "interpretive"]);

const VALID_SAL_CLASSES = new Set([
  "identity", "health", "relationship_state", "preference", "current_focus", "general",
]);

// Mirrors extraction.js (V3 prompt with claim_type).
function buildExtractionPrompt(userText, assistantText, today) {
  return `分析以下对话，提取两类有长期价值的信息。必须用 JSON 返回。

对话内容：
用户: ${userText}
助手: ${assistantText}

## 提取规则

### 1. profile_facts: 仅提取用户透露的**稳定个人事实**
- 只从**用户发言**中提取，不要从助手回复中提取
- 只提取长期稳定的事实
- 不要提取：临时状态、对话管理、重复已知信息
- confidence: 直接陈述 0.85-0.95，间接暗示 0.5-0.7
- claim_type 必填，取值之一：
  - "observed" — 用户直接陈述的事实（如出生地、诊断、教育）
  - "inferred" — 从用户言行推断的特征/偏好（如审美、性格倾向）
  - "reported" — 用户转述他人的事实（不是关于用户自己的）
  - "interpretive" — 含强烈解读/抽象的描述（如"她追求极致"）
- salience_class 必填，取值之一：
  - "identity" — 身份级稳定事实（name/birthplace/education/diagnoses）
  - "health" — 医疗、用药、身体相关
  - "relationship_state" — 当前关系状态
  - "preference" — 偏好、喜好、品味
  - "current_focus" — 短期关注（capstone/求职/当前项目）
  - "general" — 默认
- kind 取值: name, self_description, preference, location, current_focus, health, education, work, relationship, value, hobby
- 格式: [{"kind": "...", "value": "...", "confidence": 0.0-1.0, "claim_type": "...", "salience_class": "..."}]

### 2. memory_events: 仅提取有**长期记忆价值**的事件
- 只从**用户发言**中提取
- 事件主角必须是用户本人。如转述他人，summary 写"用户描述 [某人]：..."
- score: 重大人生事件 0.8-1.0，有意义状态变化 0.5-0.7
- claim_type 必填：
  - "observed" — 用户直接陈述的当下事件
  - "reported" — 用户转述他人事件（"用户描述 X：..."）
  - "inferred" — 从言行推断的状态（少用）
- salience_class 同上
- occurred_at: YYYY-MM-DD 或 null（基于今天 ${today} 推算）
- 格式: [{"summary": "...", "score": 0.0-1.0, "occurred_at": "...", "claim_type": "...", "salience_class": "..."}]

### 3. corrections: 用户纠正助手的错误认知
- "不是...是..."、"你记错了"、"其实是" 等
- 格式: [{"original": "...", "corrected": "..."}]

返回严格 JSON（不要 markdown 包裹）：
{"profile_facts": [...], "memory_events": [...], "corrections": [...]}

闲聊/调试/无价值内容返回空数组。宁可漏提也不要错提。`;
}

async function callHaiku(prompt) {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 2000,
      temperature: 0,
      messages: [
        { role: "system", content: "你是一个精确的信息提取器。只输出 JSON，不要解释。" },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Haiku API error ${res.status}: ${await res.text()}`);
  }
  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content?.trim() || "";
  const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(jsonText);
}

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function truncate(t, n) { return t.length <= n ? t : t.slice(0, n - 1) + "…"; }

async function main() {
  const args = parseArgs(process.argv);
  const db = new DatabaseSync(args.db);
  console.log(`Target DB: ${args.db}`);
  console.log(`Mode: ${args.dryRun ? "DRY-RUN" : "APPLY"}`);

  // Get user messages with their following assistant message
  let pairs = db.prepare(`
    SELECT u.id as user_id, u.conversation_id, u.text as user_text, u.created_at as user_at, u.sequence,
           a.id as assistant_id, a.text as assistant_text
    FROM messages u
    LEFT JOIN messages a ON a.conversation_id = u.conversation_id
                          AND a.sequence = u.sequence + 1
                          AND a.role = 'assistant'
    WHERE u.role = 'user'
    ORDER BY u.created_at ASC
  `).all();

  if (args.from) {
    const idx = pairs.findIndex((p) => p.user_id === args.from);
    if (idx > 0) pairs = pairs.slice(idx);
  }
  if (args.limit > 0) pairs = pairs.slice(0, args.limit);

  console.log(`User messages to process: ${pairs.length}`);

  // Build set of existing facts and events for dedup
  const existingFactKeys = new Set(
    db.prepare(`SELECT kind, value FROM profile_facts WHERE status='active'`).all()
      .map((r) => `${r.kind}|${r.value}`)
  );
  const existingEventSummaries = new Set(
    db.prepare(`SELECT summary FROM memory_events WHERE status='active'`).all()
      .map((r) => r.summary)
  );
  console.log(`Existing active facts: ${existingFactKeys.size}, events: ${existingEventSummaries.size}`);

  let stats = { processed: 0, factsAdded: 0, factsSkipped: 0, eventsAdded: 0, eventsSkipped: 0, errors: 0, lowValue: 0 };

  const insertFact = db.prepare(`
    INSERT INTO profile_facts
      (id, kind, value, confidence, evidence_message_id, created_at, updated_at, status, source, claim_type, source_material, salience, salience_class)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'extraction', ?, NULL, 0.5, ?)
    ON CONFLICT(kind, value) DO UPDATE SET
      confidence = MAX(profile_facts.confidence, excluded.confidence),
      updated_at = excluded.updated_at,
      claim_type = COALESCE(profile_facts.claim_type, excluded.claim_type),
      salience_class = COALESCE(profile_facts.salience_class, excluded.salience_class)
  `);

  const insertEvent = db.prepare(`
    INSERT INTO memory_events
      (id, conversation_id, source_message_id, summary, score, occurred_at, created_at, status, source, claim_type, salience, salience_class, mention_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'extraction', ?, 0.5, ?, 1)
  `);

  const today = new Date().toISOString().slice(0, 10);

  for (const p of pairs) {
    stats.processed++;
    const userText = (p.user_text || "").trim();
    const assistantText = (p.assistant_text || "").trim();

    if (!userText || userText.length < 3) {
      stats.lowValue++;
      continue;
    }

    let parsed;
    try {
      const prompt = buildExtractionPrompt(userText, assistantText, today);
      parsed = await callHaiku(prompt);
    } catch (err) {
      stats.errors++;
      if (stats.errors <= 5) console.warn(`  [err msg=${p.user_id.slice(0,8)}] ${err.message}`);
      continue;
    }

    // Process facts
    for (const f of (parsed.profile_facts || [])) {
      if (!f || !VALID_FACT_KINDS.has(f.kind)) continue;
      if (typeof f.value !== "string" || !f.value.trim()) continue;
      const conf = clamp(Number(f.confidence) || 0.6, 0, 1);
      if (conf < 0.5) continue;
      const claim = VALID_CLAIM_TYPES.has(f.claim_type) ? f.claim_type : "inferred";
      const sal = VALID_SAL_CLASSES.has(f.salience_class) ? f.salience_class : "general";
      const key = `${f.kind}|${f.value.trim()}`;
      if (existingFactKeys.has(key)) {
        stats.factsSkipped++;
        continue;
      }
      if (!args.dryRun) {
        const now = new Date().toISOString();
        insertFact.run(randomUUID(), f.kind, f.value.trim(), conf, p.user_id, now, now, claim, sal);
        existingFactKeys.add(key);
      }
      stats.factsAdded++;
    }

    // Process events
    for (const e of (parsed.memory_events || [])) {
      if (!e || typeof e.summary !== "string" || !e.summary.trim()) continue;
      const score = clamp(Number(e.score) || 0.5, 0, 1);
      if (score < 0.5) continue;
      const summary = truncate(e.summary.trim(), 200);
      if (existingEventSummaries.has(summary)) {
        stats.eventsSkipped++;
        continue;
      }
      const claim = VALID_CLAIM_TYPES.has(e.claim_type) ? e.claim_type : "observed";
      const sal = VALID_SAL_CLASSES.has(e.salience_class) ? e.salience_class : "general";
      const occurredAt =
        typeof e.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.occurred_at)
          ? e.occurred_at
          : p.user_at;
      if (!args.dryRun) {
        const now = new Date().toISOString();
        insertEvent.run(randomUUID(), p.conversation_id, p.user_id, summary, score, occurredAt, now, claim, sal);
        existingEventSummaries.add(summary);
      }
      stats.eventsAdded++;
    }

    if (stats.processed % 20 === 0) {
      console.log(`  [${stats.processed}/${pairs.length}] facts +${stats.factsAdded}/-${stats.factsSkipped}, events +${stats.eventsAdded}/-${stats.eventsSkipped}, err ${stats.errors}`);
    }
  }

  console.log("\n== Summary ==");
  console.log(`Processed: ${stats.processed}`);
  console.log(`Low-value skipped: ${stats.lowValue}`);
  console.log(`Errors: ${stats.errors}`);
  console.log(`Facts: +${stats.factsAdded} new, -${stats.factsSkipped} duplicates`);
  console.log(`Events: +${stats.eventsAdded} new, -${stats.eventsSkipped} duplicates`);

  db.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error("Re-extract failed:", err.message); process.exit(1); });
