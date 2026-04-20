/**
 * One-time backfill script: compute and store embeddings for all existing
 * messages and memory events that do not yet have an embedding.
 *
 * Usage (local):
 *   node --env-file-if-exists=.env scripts/backfill-embeddings.js
 *
 * Usage (production):
 *   docker exec -it jarvis node scripts/backfill-embeddings.js
 */

import { readConfig } from "../src/config.js";
import { createDatabase } from "../src/database.js";
import { computeEmbeddings } from "../src/embedding.js";

const config = readConfig();

if (!config.embeddingBaseUrl || !config.embeddingApiKey) {
  console.error("EMBEDDING_BASE_URL and EMBEDDING_API_KEY (or OPENAI_BASE_URL / OPENAI_API_KEY) must be set.");
  process.exit(1);
}

const repository = createDatabase(config.databasePath);
const BATCH_SIZE = 50;

async function backfill() {
  // ── Messages ──────────────────────────────────────────────────────────────
  console.log("Backfilling message embeddings…");
  let totalMessages = 0;
  while (true) {
    const batch = repository.getMessagesWithoutEmbeddings(BATCH_SIZE);
    if (batch.length === 0) break;

    const embeddings = await computeEmbeddings(config, batch.map((m) => m.text));
    for (let i = 0; i < batch.length; i++) {
      repository.saveMessageEmbedding(batch[i].id, embeddings[i], config.embeddingModel);
    }
    totalMessages += batch.length;
    console.log(`  messages: ${totalMessages} done`);
  }
  console.log(`Messages done (${totalMessages} total).`);

  // ── Memory events ─────────────────────────────────────────────────────────
  console.log("Backfilling memory event embeddings…");
  let totalEvents = 0;
  while (true) {
    const batch = repository.getMemoryEventsWithoutEmbeddings(BATCH_SIZE);
    if (batch.length === 0) break;

    const embeddings = await computeEmbeddings(config, batch.map((e) => e.summary));
    for (let i = 0; i < batch.length; i++) {
      repository.saveMemoryEventEmbedding(batch[i].id, embeddings[i], config.embeddingModel);
    }
    totalEvents += batch.length;
    console.log(`  events: ${totalEvents} done`);
  }
  console.log(`Memory events done (${totalEvents} total).`);

  console.log("Backfill complete.");
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
