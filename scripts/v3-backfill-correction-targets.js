#!/usr/bin/env node
/**
 * V3 Phase 2.4: Backfill corrections.target_id using embedding-based candidate
 * retrieval + Haiku LLM judgment.
 *
 * The legacy findCorrectionTarget() in src/database.js uses token-overlap with
 * a 0.55 threshold, which never matches the user's actual corrections (39/39 NULL).
 * This script replaces it with:
 *   1. Embed correction's original_text + corrected_text
 *   2. Find top-K most similar active facts and events by cosine similarity
 *   3. For each candidate, ask Haiku: "is this correction targeting this fact/event?"
 *   4. If Haiku confirms with confidence >= 0.7, set target_type/target_id and
 *      mark the targeted fact/event as 'retracted'.
 *
 * Usage:
 *   node scripts/v3-backfill-correction-targets.js [--db PATH] [--dry-run]
 *
 * Requires env: EMBEDDING_BASE_URL, EMBEDDING_API_KEY, EMBEDDING_MODEL,
 *               OPENAI_BASE_URL, OPENAI_API_KEY (Haiku via Anthropic).
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

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const TOP_K_CANDIDATES = 8;
const MATCH_CONFIDENCE_THRESHOLD = 0.7;

// ---- Embedding ----

async function computeEmbedding(text) {
  // Match the fallback logic of config.js:
  //   EMBEDDING_API_KEY → OPENAI_API_KEY_GPT (with default openai.com endpoint)
  const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY_GPT;
  const baseUrl = process.env.EMBEDDING_BASE_URL
    || (process.env.OPENAI_API_KEY_GPT ? "https://api.openai.com/v1" : null);
  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  if (!apiKey || !baseUrl) {
    throw new Error("No embedding key/url available (need EMBEDDING_API_KEY or OPENAI_API_KEY_GPT)");
  }

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: text.slice(0, 6000) }),
  });
  if (!res.ok) {
    throw new Error(`Embedding API error ${res.status}: ${await res.text()}`);
  }
  const payload = await res.json();
  return payload.data[0].embedding;
}

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

// ---- Haiku judge ----

async function judgeMatch({ original, corrected, candidate }) {
  const baseUrl = process.env.OPENAI_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !baseUrl) throw new Error("OPENAI_BASE_URL / OPENAI_API_KEY not set");

  const prompt = `用户对 Jarvis 做了一次纠正：
- 错误的认知（被纠正的）："${original}"
- 正确的内容："${corrected}"

候选记忆条目（${candidate.kind}）：
"${candidate.text}"

判断：用户的纠正是否针对这条记忆条目？

如果是同一件事、同一个判断、同一个事实——即使措辞不同，也算 match。
如果只是话题相关但具体所指不同，不算 match。

只输出 JSON：
{"match": true|false, "confidence": 0.0-1.0, "reason": "<一句话>"}`;

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 200,
      temperature: 0,
      messages: [
        { role: "system", content: "你是一个精确的记忆匹配判官。只输出 JSON，不要解释。" },
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
  try {
    return JSON.parse(jsonText);
  } catch {
    console.warn(`  [judge] failed to parse: ${content}`);
    return { match: false, confidence: 0, reason: "parse error" };
  }
}

// ---- Main ----

async function backfill(dbPath, dryRun) {
  const db = new DatabaseSync(dbPath);
  console.log(`Target DB: ${dbPath}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log("");

  const corrections = db.prepare(`
    SELECT id, original_text, corrected_text, target_type, target_id, created_at
    FROM corrections
    WHERE target_id IS NULL
    ORDER BY created_at ASC
  `).all();
  console.log(`Corrections to process: ${corrections.length}`);
  if (corrections.length === 0) { db.close(); return; }

  // Load embeddings for active facts and events
  const factEmb = db.prepare(`
    SELECT pf.id, pf.kind, pf.value, me.embedding_blob
    FROM profile_facts pf
    LEFT JOIN message_embeddings me ON me.message_id = pf.evidence_message_id
    WHERE pf.status = 'active'
  `).all();

  const eventEmbRaw = db.prepare(`
    SELECT me.id, me.summary, mee.embedding_blob
    FROM memory_events me
    LEFT JOIN memory_event_embeddings mee ON mee.memory_event_id = me.id
    WHERE me.status = 'active'
  `).all();

  // Decode blobs into Float32Array
  const decode = (blob) => {
    if (!blob) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  };

  // Build pool of {type, id, text, vec}; many facts have NULL embeddings via this join — for those, skip
  const pool = [];
  for (const f of factEmb) {
    const vec = decode(f.embedding_blob);
    if (!vec) continue;
    pool.push({ type: "profile_fact", id: f.id, kind: f.kind, text: `${f.kind}: ${f.value}`, vec });
  }
  for (const e of eventEmbRaw) {
    const vec = decode(e.embedding_blob);
    if (!vec) continue;
    pool.push({ type: "memory_event", id: e.id, kind: "event", text: e.summary, vec });
  }
  console.log(`Pool size: ${pool.length} candidates with embeddings (out of ${factEmb.length} facts + ${eventEmbRaw.length} events)`);

  // Note: many profile_facts may not have embeddings if their evidence_message
  // doesn't have one. This is a known gap; we work with what we have.

  let matched = 0, unmatched = 0;
  const updates = [];

  for (let i = 0; i < corrections.length; i++) {
    const c = corrections[i];
    const queryText = `${c.original_text}\n${c.corrected_text}`;
    process.stdout.write(`\n[${i + 1}/${corrections.length}] ${c.original_text.slice(0, 60)}... \n`);

    let queryVec;
    try {
      queryVec = await computeEmbedding(queryText);
    } catch (err) {
      console.warn(`  [embed-fail] ${err.message}`);
      unmatched++;
      continue;
    }

    // Top-K candidates by cosine
    const scored = pool.map((p) => ({ ...p, sim: cosineSim(queryVec, p.vec) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, TOP_K_CANDIDATES);

    let bestMatch = null;
    for (const cand of scored) {
      try {
        const j = await judgeMatch({
          original: c.original_text,
          corrected: c.corrected_text,
          candidate: { kind: cand.kind, text: cand.text },
        });
        if (j.match && j.confidence >= MATCH_CONFIDENCE_THRESHOLD) {
          if (!bestMatch || j.confidence > bestMatch.confidence) {
            bestMatch = { ...cand, confidence: j.confidence, reason: j.reason };
          }
          // First high-confidence match wins (don't keep judging)
          if (j.confidence >= 0.85) break;
        }
      } catch (err) {
        console.warn(`  [judge-fail] ${err.message}`);
      }
    }

    if (bestMatch) {
      matched++;
      console.log(`  ✓ matched ${bestMatch.type} (conf=${bestMatch.confidence}): ${bestMatch.text.slice(0, 70)}`);
      console.log(`    reason: ${bestMatch.reason}`);
      updates.push({
        correction_id: c.id,
        target_type: bestMatch.type,
        target_id: bestMatch.id,
        confidence: bestMatch.confidence,
      });
    } else {
      unmatched++;
      console.log(`  - no match above threshold (top sim=${scored[0]?.sim.toFixed(3)})`);
    }
  }

  console.log(`\n\n== Summary ==`);
  console.log(`Matched: ${matched} / ${corrections.length}`);
  console.log(`Unmatched: ${unmatched}`);

  if (dryRun) {
    console.log("\n[DRY-RUN] No writes.");
    db.close();
    return;
  }

  if (updates.length > 0) {
    console.log("\n== Applying ==");
    const now = new Date().toISOString();
    const updCorr = db.prepare(`UPDATE corrections SET target_type=?, target_id=?, applied_at=? WHERE id=?`);
    const retractFact = db.prepare(`UPDATE profile_facts SET status='retracted', status_reason='superseded by user correction (V3 backfill)', status_updated_at=? WHERE id=? AND status='active'`);
    const retractEvent = db.prepare(`UPDATE memory_events SET status='retracted', status_reason='superseded by user correction (V3 backfill)', status_updated_at=? WHERE id=? AND status='active'`);

    db.exec("BEGIN");
    try {
      for (const u of updates) {
        updCorr.run(u.target_type, u.target_id, now, u.correction_id);
        if (u.target_type === "profile_fact") retractFact.run(now, u.target_id);
        else if (u.target_type === "memory_event") retractEvent.run(now, u.target_id);
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    console.log(`Updated ${updates.length} corrections + retracted same number of targets.`);
  }

  db.close();
}

const args = parseArgs(process.argv);
backfill(args.db, args.dryRun)
  .then(() => process.exit(0))
  .catch((err) => { console.error("Backfill failed:", err.message); process.exit(1); });
