#!/usr/bin/env node

/**
 * Migration script: Re-extract profile facts and memory events from existing messages
 * using the improved extraction prompt.
 *
 * Usage:
 *   OPENAI_BASE_URL=... OPENAI_API_KEY=... OPENAI_MODEL=... node scripts/re-extract.js [--db path/to/memory.db] [--dry-run]
 *
 * This script:
 * 1. Reads all user+assistant message pairs from the database
 * 2. Re-runs extraction with the improved prompt
 * 3. Optionally clears old auto-extracted facts/events and writes new ones
 *
 * Use --dry-run to preview what would be extracted without making changes.
 */

import { DatabaseSync } from "node:sqlite";
import { extractTurnArtifacts } from "../src/extraction.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dbIndex = args.indexOf("--db");
const dbPath = dbIndex >= 0 && args[dbIndex + 1] ? args[dbIndex + 1] : "data/memory.db";

const config = {
  openAiBaseUrl: process.env.OPENAI_BASE_URL,
  openAiApiKey: process.env.OPENAI_API_KEY,
  openAiModel: process.env.OPENAI_MODEL || "gpt-4.1",
  extractionModel: process.env.EXTRACTION_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
};

if (!config.openAiBaseUrl || !config.openAiApiKey) {
  console.error("Error: OPENAI_BASE_URL and OPENAI_API_KEY must be set");
  process.exit(1);
}

console.log(`Database: ${dbPath}`);
console.log(`Model: ${config.extractionModel}`);
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

// Get all message pairs (user + next assistant)
const allMessages = db.prepare(
  `SELECT id, conversation_id AS conversationId, role, text, sequence, created_at AS createdAt
   FROM messages
   ORDER BY conversation_id, sequence ASC`
).all();

// Group into user-assistant pairs
const pairs = [];
for (let i = 0; i < allMessages.length; i++) {
  const msg = allMessages[i];
  if (msg.role !== "user") continue;

  // Find the next assistant message in same conversation
  const nextAssistant = allMessages.slice(i + 1).find(
    (m) => m.conversationId === msg.conversationId && m.role === "assistant"
  );

  if (nextAssistant) {
    pairs.push({ user: msg, assistant: nextAssistant });
  }
}

console.log(`Found ${pairs.length} user-assistant pairs to process`);
console.log();

const stats = {
  processed: 0,
  profileFacts: 0,
  memoryEvents: 0,
  corrections: 0,
  errors: 0,
};

// Process with rate limiting
const BATCH_SIZE = 5;
const DELAY_MS = 1000;

for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
  const batch = pairs.slice(i, i + BATCH_SIZE);

  const results = await Promise.allSettled(
    batch.map(async ({ user, assistant }) => {
      try {
        const artifacts = await extractTurnArtifacts(user, assistant, config);
        return { user, artifacts };
      } catch (err) {
        console.error(`  Error processing message ${user.id}: ${err.message}`);
        stats.errors++;
        return null;
      }
    })
  );

  for (const result of results) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const { user, artifacts } = result.value;

    stats.processed++;
    stats.profileFacts += artifacts.profileFacts.length;
    stats.memoryEvents += artifacts.memoryEvents.length;
    stats.corrections += (artifacts.corrections || []).length;

    if (artifacts.profileFacts.length > 0 || artifacts.memoryEvents.length > 0 || (artifacts.corrections || []).length > 0) {
      console.log(`Message ${user.id} (${user.text.slice(0, 50)}...):`);
      for (const fact of artifacts.profileFacts) {
        console.log(`  [fact] ${fact.kind}: ${fact.value} (${fact.confidence})`);
      }
      for (const event of artifacts.memoryEvents) {
        console.log(`  [event] ${event.summary} (${event.score})`);
      }
      for (const correction of (artifacts.corrections || [])) {
        console.log(`  [correction] "${correction.originalText}" → "${correction.correctedText}"`);
      }
    }

    if (!dryRun) {
      const now = new Date().toISOString();

      for (const fact of artifacts.profileFacts) {
        const existing = db.prepare(
          `SELECT id, confidence FROM profile_facts WHERE kind = ? AND value = ?`
        ).get(fact.kind, fact.value);

        if (existing) {
          const nextConfidence = Math.max(Number(existing.confidence) || 0, fact.confidence);
          db.prepare(
            `UPDATE profile_facts SET confidence = ?, evidence_message_id = COALESCE(?, evidence_message_id), updated_at = ? WHERE id = ?`
          ).run(nextConfidence, fact.evidenceMessageId, now, existing.id);
        } else {
          db.prepare(
            `INSERT INTO profile_facts (id, kind, value, confidence, evidence_message_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(crypto.randomUUID(), fact.kind, fact.value, fact.confidence, fact.evidenceMessageId, now, now);
        }
      }

      for (const event of artifacts.memoryEvents) {
        const duplicate = db.prepare(
          `SELECT id FROM memory_events WHERE conversation_id = ? AND summary = ?`
        ).get(event.conversationId, event.summary);
        if (!duplicate) {
          db.prepare(
            `INSERT INTO memory_events (id, conversation_id, source_message_id, summary, score, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(crypto.randomUUID(), event.conversationId, event.sourceMessageId, event.summary, event.score, now, now);
        }
      }

      for (const correction of (artifacts.corrections || [])) {
        db.prepare(
          `INSERT INTO corrections (id, original_text, corrected_text, source_message_id, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(crypto.randomUUID(), correction.originalText, correction.correctedText, correction.sourceMessageId, correction.conversationId, now);
      }
    }
  }

  // Rate limit between batches
  if (i + BATCH_SIZE < pairs.length) {
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }

  process.stdout.write(`\rProgress: ${Math.min(i + BATCH_SIZE, pairs.length)}/${pairs.length}`);
}

console.log("\n");
console.log("=== Summary ===");
console.log(`Processed: ${stats.processed}/${pairs.length}`);
console.log(`Profile facts extracted: ${stats.profileFacts}`);
console.log(`Memory events extracted: ${stats.memoryEvents}`);
console.log(`Corrections detected: ${stats.corrections}`);
console.log(`Errors: ${stats.errors}`);
if (dryRun) {
  console.log("\n(Dry run — no changes written to database)");
}
