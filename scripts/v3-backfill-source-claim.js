#!/usr/bin/env node
/**
 * V3 Phase 2.1: Rule-based backfill of source / claim_type / salience_class
 * for existing profile_facts and memory_events.
 *
 * Lossy by design — we don't have provenance metadata on legacy data.
 * Rules use kind / value / summary text to assign reasonable defaults.
 *
 * Usage:
 *   node scripts/v3-backfill-source-claim.js [--db PATH] [--dry-run]
 *
 * Spec reference: docs/design/jarvis-v3-design-20260508.md Section 7.2.1, 5.5
 */

import { DatabaseSync } from "node:sqlite";

function parseArgs(argv) {
  const args = { db: "data/memory.db", dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) { args.db = argv[++i]; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
  }
  return args;
}

// ---- Rules ----

// Salience class by kind.
const SALIENCE_CLASS_BY_KIND = {
  name:             "identity",
  location:         "identity",
  education:        "identity",
  health:           "health",
  relationship:     "relationship_state",
  preference:       "preference",
  hobby:            "preference",
  current_focus:    "current_focus",
  value:            "general",
  self_description: "general",
  work:             "general",
};

// Claim type by kind — baseline assignment.
// Most kinds default to 'inferred' since LLM extraction layered judgment on top of utterances.
// Hard identity kinds with low ambiguity → 'observed'.
const CLAIM_TYPE_BY_KIND = {
  name:             "observed",
  location:         "observed",
  education:        "observed",
  health:           "observed",      // medical info user disclosed about themselves
  work:             "observed",
  hobby:            "observed",
  relationship:     "inferred",      // upgrade specific cases below
  preference:       "inferred",
  current_focus:    "inferred",
  value:            "inferred",
  self_description: "inferred",
};

// Memory event claim type heuristics (run on summary text).
function eventClaimType(summary) {
  const s = String(summary || "");
  // Pattern: "用户描述 X：..." / "用户提到 X：..." → reported (about someone else)
  if (/^用户(描述|提到|观察)/u.test(s)) return "reported";
  // Pattern: "Claude 判断..." / "Assistant replied..." → reported (AI claim about user)
  if (/^(Claude|Assistant|助手)/u.test(s)) return "reported";
  // Default: events observed during conversation
  return "observed";
}

function eventSalienceClass(summary) {
  const s = String(summary || "");
  // health-related keywords
  if (/(bipolar|ADHD|抑郁|焦虑|药|医生|医院|甲减|甲状腺|睡眠|失眠|健身)/iu.test(s)) {
    return "health";
  }
  // relationship-related keywords
  if (/(关系|分手|约会|恋爱|attachment|分离焦虑|喜欢|男友|女友|伴侣)/u.test(s)) {
    return "relationship_state";
  }
  // current focus / project-related
  if (/(capstone|presentation|求职|毕设|项目|Jarvis)/iu.test(s)) {
    return "current_focus";
  }
  return "general";
}

function backfill(dbPath, dryRun) {
  const db = new DatabaseSync(dbPath);
  console.log(`Target DB: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log("");

  // ---- profile_facts ----
  const factsToBackfill = db.prepare(`
    SELECT id, kind, value, evidence_message_id, source, claim_type, salience_class
    FROM profile_facts
    WHERE source IS NULL OR claim_type IS NULL
  `).all();
  console.log(`profile_facts to backfill: ${factsToBackfill.length}`);

  let factSummary = { total: 0, byClaim: {}, bySource: {}, bySalClass: {} };
  let factUpdates = [];

  for (const row of factsToBackfill) {
    // source: if evidence_message_id is set, it came from a real message → 'extraction'
    //        otherwise, likely 'cold_start' (legacy seed-data) but we treat conservatively as 'extraction'
    const source = row.source || (row.evidence_message_id ? "extraction" : "cold_start");
    const claimType = row.claim_type || (CLAIM_TYPE_BY_KIND[row.kind] || "inferred");
    const salClass = (row.salience_class && row.salience_class !== "general")
      ? row.salience_class
      : (SALIENCE_CLASS_BY_KIND[row.kind] || "general");

    factSummary.total++;
    factSummary.byClaim[claimType] = (factSummary.byClaim[claimType] || 0) + 1;
    factSummary.bySource[source] = (factSummary.bySource[source] || 0) + 1;
    factSummary.bySalClass[salClass] = (factSummary.bySalClass[salClass] || 0) + 1;

    factUpdates.push({ id: row.id, source, claimType, salClass });
  }

  console.log(`  By source:    ${JSON.stringify(factSummary.bySource)}`);
  console.log(`  By claim_type: ${JSON.stringify(factSummary.byClaim)}`);
  console.log(`  By salience_class: ${JSON.stringify(factSummary.bySalClass)}`);

  // ---- memory_events ----
  const eventsToBackfill = db.prepare(`
    SELECT id, summary, source_message_id, source, claim_type, salience_class
    FROM memory_events
    WHERE source IS NULL OR claim_type IS NULL
  `).all();
  console.log(`\nmemory_events to backfill: ${eventsToBackfill.length}`);

  let evSummary = { total: 0, byClaim: {}, bySource: {}, bySalClass: {} };
  let evUpdates = [];

  for (const row of eventsToBackfill) {
    const source = row.source || (row.source_message_id ? "extraction" : "cold_start");
    const claimType = row.claim_type || eventClaimType(row.summary);
    const salClass = (row.salience_class && row.salience_class !== "general")
      ? row.salience_class
      : eventSalienceClass(row.summary);

    evSummary.total++;
    evSummary.byClaim[claimType] = (evSummary.byClaim[claimType] || 0) + 1;
    evSummary.bySource[source] = (evSummary.bySource[source] || 0) + 1;
    evSummary.bySalClass[salClass] = (evSummary.bySalClass[salClass] || 0) + 1;

    evUpdates.push({ id: row.id, source, claimType, salClass });
  }

  console.log(`  By source:    ${JSON.stringify(evSummary.bySource)}`);
  console.log(`  By claim_type: ${JSON.stringify(evSummary.byClaim)}`);
  console.log(`  By salience_class: ${JSON.stringify(evSummary.bySalClass)}`);

  // ---- Sample preview ----
  console.log("\n== Sample preview (first 5 of each) ==");
  console.log("\nfacts:");
  for (const f of factUpdates.slice(0, 5)) {
    const orig = factsToBackfill.find((r) => r.id === f.id);
    console.log(`  [${orig.kind}] ${String(orig.value).slice(0, 60)}`);
    console.log(`    → source=${f.source}, claim_type=${f.claimType}, salience_class=${f.salClass}`);
  }
  console.log("\nevents:");
  for (const e of evUpdates.slice(0, 5)) {
    const orig = eventsToBackfill.find((r) => r.id === e.id);
    console.log(`  ${String(orig.summary).slice(0, 80)}`);
    console.log(`    → source=${e.source}, claim_type=${e.claimType}, salience_class=${e.salClass}`);
  }

  if (dryRun) {
    console.log("\n[DRY-RUN] No writes. Total would be:");
    console.log(`  profile_facts: ${factUpdates.length}`);
    console.log(`  memory_events: ${evUpdates.length}`);
    db.close();
    return;
  }

  // ---- Apply ----
  console.log("\n== Applying ==");
  const factStmt = db.prepare(`
    UPDATE profile_facts
    SET source = ?, claim_type = ?, salience_class = ?
    WHERE id = ?
  `);
  const eventStmt = db.prepare(`
    UPDATE memory_events
    SET source = ?, claim_type = ?, salience_class = ?
    WHERE id = ?
  `);

  db.exec("BEGIN");
  try {
    for (const u of factUpdates) {
      factStmt.run(u.source, u.claimType, u.salClass, u.id);
    }
    for (const u of evUpdates) {
      eventStmt.run(u.source, u.claimType, u.salClass, u.id);
    }
    db.exec("COMMIT");
    console.log(`Updated ${factUpdates.length} facts and ${evUpdates.length} events.`);
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // ---- Post-verification ----
  const remainingFacts = db.prepare(
    `SELECT COUNT(*) as n FROM profile_facts WHERE source IS NULL OR claim_type IS NULL`
  ).get().n;
  const remainingEvents = db.prepare(
    `SELECT COUNT(*) as n FROM memory_events WHERE source IS NULL OR claim_type IS NULL`
  ).get().n;
  console.log(`\nRemaining unfilled: facts=${remainingFacts}, events=${remainingEvents}`);

  db.close();
}

const args = parseArgs(process.argv);
try {
  backfill(args.db, args.dryRun);
  process.exit(0);
} catch (err) {
  console.error("Backfill failed:", err.message);
  process.exit(1);
}
