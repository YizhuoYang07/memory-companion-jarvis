/**
 * seed-data.js — Cold-start seeder
 *
 * Populates the database with an initial person model so the AI has context
 * from day one, before any conversations have happened.
 *
 * Usage:
 *   node scripts/seed-data.js
 *
 * This is a template. Replace the profile facts and memory events below
 * with your own. See docs/PERSON_MODEL.md for guidance on what to include.
 *
 * Run once on a fresh database. Re-running is safe (uses INSERT OR IGNORE).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readConfig } from "../src/config.js";

const config = readConfig();
const db = new DatabaseSync(config.databasePath);

// ──────────────────────────────────────────────────────────────────────────────
// PROFILE FACTS
// These are stable facts about you. The AI retrieves these to answer questions
// like "what do I do?", "where am I from?", "what are my interests?"
//
// Format: { kind: string, value: string, confidence: 0.0–1.0 }
// Common kinds: identity, location, occupation, education, health,
//               relationship, interest, personality, goal, skill
// ──────────────────────────────────────────────────────────────────────────────
const profileFacts = [
  // Replace these with your own facts:
  { kind: "identity",     value: "Your name is [Name].",                              confidence: 1.0 },
  { kind: "occupation",   value: "You work as a [role] at [company/field].",           confidence: 1.0 },
  { kind: "location",     value: "You currently live in [city, country].",             confidence: 1.0 },
  { kind: "education",    value: "You studied [field] at [university].",               confidence: 0.9 },
  { kind: "interest",     value: "You are interested in [topic].",                     confidence: 0.9 },
  { kind: "personality",  value: "You tend to be [trait]. You value [value].",         confidence: 0.8 },
  { kind: "goal",         value: "A current goal of yours is [goal].",                 confidence: 0.8 },
  { kind: "relationship", value: "You are [relationship status].",                     confidence: 0.9 },
  { kind: "health",       value: "You manage [condition] in your daily life.",         confidence: 0.9 },
  { kind: "skill",        value: "You have strong skills in [skill area].",            confidence: 0.9 },
];

// ──────────────────────────────────────────────────────────────────────────────
// MEMORY EVENTS
// Significant past events you want the AI to remember.
// These appear in retrieval context when relevant topics come up.
//
// Format: { summary: string, score: 0–10 }
// ──────────────────────────────────────────────────────────────────────────────
const memoryEvents = [
  // Replace these with your own events:
  { summary: "Started using this memory system on [date].",                  score: 5 },
  { summary: "Completed [project/milestone] after [duration] of work.",      score: 7 },
  { summary: "Made a major decision to [decision] because [reason].",         score: 8 },
  { summary: "Went through [experience] which changed how you think about [topic].", score: 7 },
];

// ──────────────────────────────────────────────────────────────────────────────
// Seeding logic — do not edit below this line
// ──────────────────────────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

const insertFact = db.prepare(`
  INSERT OR IGNORE INTO profile_facts (id, kind, value, confidence, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const insertEvent = db.prepare(`
  INSERT OR IGNORE INTO memory_events (id, summary, score, occurred_at, created_at)
  VALUES (?, ?, ?, ?, ?)
`);

console.log("Seeding profile facts…");
for (const fact of profileFacts) {
  const id = randomUUID();
  insertFact.run(id, fact.kind, fact.value, fact.confidence, nowIso(), nowIso());
  console.log(`  ✓ [${fact.kind}] ${fact.value.slice(0, 60)}…`);
}

console.log("\nSeeding memory events…");
const now = nowIso();
for (const event of memoryEvents) {
  const id = randomUUID();
  insertEvent.run(id, event.summary, event.score, now, now);
  console.log(`  ✓ ${event.summary.slice(0, 70)}…`);
}

db.close();
console.log("\nDone. Database seeded successfully.");
