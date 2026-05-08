#!/usr/bin/env node
/**
 * V3 Phase 1: Schema migration.
 *
 * Additive only — adds columns and tables for V3 components.
 * Idempotent — safe to re-run.
 * Does NOT touch existing data.
 *
 * Usage:
 *   node scripts/v3-migrate-schema.js [--db PATH] [--dry-run]
 *
 * Defaults: --db data/memory.db
 *
 * Spec reference: docs/design/jarvis-v3-design-20260508.md Sections 5.1-5.6, 7.1
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { db: "data/memory.db", dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) { args.db = argv[++i]; }
    else if (argv[i] === "--dry-run") { args.dryRun = true; }
  }
  return args;
}

function columnExists(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((c) => c.name === column);
}

function tableExists(db, table) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(table);
  return Boolean(row);
}

function ensureColumn(db, table, column, definition, dryRun) {
  if (columnExists(db, table, column)) {
    console.log(`  [skip] ${table}.${column} already exists`);
    return false;
  }
  const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`;
  if (dryRun) {
    console.log(`  [DRY-RUN] would run: ${sql}`);
  } else {
    db.exec(sql);
    console.log(`  [add] ${table}.${column}`);
  }
  return true;
}

function ensureTable(db, name, schemaSql, dryRun) {
  if (tableExists(db, name)) {
    console.log(`  [skip] table ${name} already exists`);
    return false;
  }
  if (dryRun) {
    console.log(`  [DRY-RUN] would create table ${name}`);
  } else {
    db.exec(schemaSql);
    console.log(`  [create] table ${name}`);
  }
  return true;
}

function ensureIndex(db, name, schemaSql, dryRun) {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`
  ).get(name);
  if (row) {
    console.log(`  [skip] index ${name} already exists`);
    return false;
  }
  if (dryRun) {
    console.log(`  [DRY-RUN] would create index ${name}`);
  } else {
    db.exec(schemaSql);
    console.log(`  [create] index ${name}`);
  }
  return true;
}

const NEW_TABLES = {
  entities: `
    CREATE TABLE entities (
      id              TEXT PRIMARY KEY,
      canonical_name  TEXT NOT NULL UNIQUE,
      aliases_json    TEXT NOT NULL DEFAULT '[]',
      entity_type     TEXT NOT NULL DEFAULT 'person',
      tier            INTEGER,
      first_seen_at   TEXT NOT NULL,
      last_seen_at    TEXT NOT NULL,
      stable_summary  TEXT,
      current_status  TEXT,
      notes           TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `,
  entity_facts: `
    CREATE TABLE entity_facts (
      entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      fact_id    TEXT NOT NULL REFERENCES profile_facts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, fact_id)
    );
  `,
  entity_events: `
    CREATE TABLE entity_events (
      entity_id  TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      event_id   TEXT NOT NULL REFERENCES memory_events(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (entity_id, event_id)
    );
  `,
  relationship_state: `
    CREATE TABLE relationship_state (
      id                       TEXT PRIMARY KEY,
      entity_id                TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      label                    TEXT NOT NULL,
      confidence               REAL NOT NULL,
      guidance                 TEXT,
      effective_at             TEXT NOT NULL,
      superseded_at            TEXT,
      source_message_ids_json  TEXT NOT NULL DEFAULT '[]',
      created_at               TEXT NOT NULL
    );
  `,
  patterns: `
    CREATE TABLE patterns (
      id                       TEXT PRIMARY KEY,
      dimension                TEXT NOT NULL,
      summary                  TEXT NOT NULL,
      evidence_event_ids_json  TEXT NOT NULL DEFAULT '[]',
      first_observed_at        TEXT NOT NULL,
      last_observed_at         TEXT NOT NULL,
      confidence               REAL NOT NULL,
      status                   TEXT NOT NULL DEFAULT 'active',
      created_at               TEXT NOT NULL,
      updated_at               TEXT NOT NULL
    );
  `,
};

const INDEXES = {
  idx_entity_facts_fact:    `CREATE INDEX idx_entity_facts_fact ON entity_facts(fact_id);`,
  idx_entity_events_event:  `CREATE INDEX idx_entity_events_event ON entity_events(event_id);`,
  idx_relstate_entity_active:
    `CREATE INDEX idx_relstate_entity_active ON relationship_state(entity_id) WHERE superseded_at IS NULL;`,
  idx_patterns_dimension:   `CREATE INDEX idx_patterns_dimension ON patterns(dimension, status);`,
  idx_facts_consolidated:   `CREATE INDEX idx_facts_consolidated ON profile_facts(consolidated_into) WHERE consolidated_into IS NOT NULL;`,
  idx_events_consolidated:  `CREATE INDEX idx_events_consolidated ON memory_events(consolidated_into) WHERE consolidated_into IS NOT NULL;`,
};

function migrate(dbPath, dryRun) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`DB not found: ${dbPath}`);
  }
  const absPath = path.resolve(dbPath);
  console.log(`Target DB: ${absPath}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log("");

  const db = new DatabaseSync(absPath);
  db.exec("PRAGMA foreign_keys = ON;");

  let changes = 0;

  console.log("== Adding columns to profile_facts ==");
  changes += ensureColumn(db, "profile_facts", "source",          "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "profile_facts", "claim_type",      "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "profile_facts", "source_material", "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "profile_facts", "salience",        "REAL NOT NULL DEFAULT 0.5", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "profile_facts", "salience_class",  "TEXT NOT NULL DEFAULT 'general'", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "profile_facts", "consolidated_into", "TEXT REFERENCES profile_facts(id)", dryRun) ? 1 : 0;

  console.log("\n== Adding columns to memory_events ==");
  changes += ensureColumn(db, "memory_events", "source",          "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "claim_type",      "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "source_material", "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "salience",        "REAL NOT NULL DEFAULT 0.5", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "salience_class",  "TEXT NOT NULL DEFAULT 'general'", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "consolidated_into", "TEXT REFERENCES memory_events(id)", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "mention_count",   "INTEGER NOT NULL DEFAULT 1", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "first_mentioned_at", "TEXT", dryRun) ? 1 : 0;
  changes += ensureColumn(db, "memory_events", "last_mentioned_at",  "TEXT", dryRun) ? 1 : 0;

  console.log("\n== Creating new tables ==");
  for (const [name, sql] of Object.entries(NEW_TABLES)) {
    changes += ensureTable(db, name, sql, dryRun) ? 1 : 0;
  }

  console.log("\n== Creating indexes ==");
  for (const [name, sql] of Object.entries(INDEXES)) {
    changes += ensureIndex(db, name, sql, dryRun) ? 1 : 0;
  }

  console.log("\n== Verification ==");
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`
  ).all().map((r) => r.name);
  console.log("All tables:", tables.join(", "));
  const factCols = db.prepare("PRAGMA table_info(profile_facts)").all().map((c) => c.name);
  const eventCols = db.prepare("PRAGMA table_info(memory_events)").all().map((c) => c.name);
  console.log(`profile_facts columns (${factCols.length}):`, factCols.join(", "));
  console.log(`memory_events columns (${eventCols.length}):`, eventCols.join(", "));

  console.log(`\nTotal changes: ${changes}${dryRun ? " (DRY-RUN — nothing written)" : ""}`);
  db.close();
  return changes;
}

const args = parseArgs(process.argv);
try {
  const n = migrate(args.db, args.dryRun);
  process.exit(0);
} catch (err) {
  console.error("Migration failed:", err.message);
  process.exit(1);
}
