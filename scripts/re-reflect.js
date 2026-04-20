#!/usr/bin/env node

/**
 * Re-generate daily reflections for all dates that have messages.
 * Uses the V2 reflection engine (statistical + LLM upgrade).
 *
 * Usage:
 *   OPENAI_BASE_URL=... OPENAI_API_KEY=... node scripts/re-reflect.js [--db path] [--dry-run]
 */

import { DatabaseSync } from "node:sqlite";
import { createDailyReflection } from "../src/reflection-service.js";

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
console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
console.log();

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

// Find all dates that have messages
const dates = db.prepare(
  `SELECT DISTINCT substr(created_at, 1, 10) AS date
   FROM messages
   ORDER BY date ASC`
).all().map((row) => row.date);

console.log(`Found ${dates.length} dates with messages`);
console.log();

// Build a minimal repository that wraps the raw db for reflection-service
const repository = {
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
              created_at AS createdAt, updated_at AS updatedAt
       FROM profile_facts
       WHERE substr(updated_at, 1, 10) = ?
       ORDER BY confidence DESC, updated_at DESC`
    ).all(date);
  },

  upsertReflection({ reflectionDate, summary, openLoops, profileCandidates }) {
    if (dryRun) {
      console.log(`  [would write] ${summary.slice(0, 120)}...`);
      return "dry-run";
    }

    const existing = db.prepare(
      `SELECT id FROM reflections WHERE reflection_date = ?`
    ).get(reflectionDate);

    const now = new Date().toISOString();
    const payload = [summary, JSON.stringify(openLoops), JSON.stringify(profileCandidates), now];

    if (existing) {
      db.prepare(
        `UPDATE reflections SET summary = ?, open_loops_json = ?, profile_candidates_json = ?, created_at = ? WHERE reflection_date = ?`
      ).run(...payload, reflectionDate);
      return existing.id;
    }

    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO reflections (id, reflection_date, summary, open_loops_json, profile_candidates_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, reflectionDate, ...payload);
    return id;
  },

  getReflection(reflectionDate) {
    return db.prepare(
      `SELECT id, reflection_date AS reflectionDate, summary,
              open_loops_json AS openLoopsJson,
              profile_candidates_json AS profileCandidatesJson,
              created_at AS createdAt
       FROM reflections WHERE reflection_date = ?`
    ).get(reflectionDate) || null;
  },
};

// Process each date
for (const date of dates) {
  const messages = repository.getMessagesForDate(date);
  console.log(`${date}: ${messages.length} messages`);

  if (messages.length === 0) continue;

  // createDailyReflection writes statistical sync, then fires LLM async
  const result = createDailyReflection(repository, date, config);

  if (result) {
    console.log(`  → ${result.summary.slice(0, 120)}`);
  }
}

// Wait for all async LLM upgrades to complete
console.log("\nWaiting for LLM reflection upgrades...");
await new Promise((resolve) => setTimeout(resolve, 15000));

// Print final state
console.log("\n=== Final reflections ===");
for (const date of dates) {
  const r = repository.getReflection(date);
  if (r) {
    console.log(`${date}: ${r.summary.slice(0, 150)}`);
  }
}

console.log("\nDone.");
