import { computeEmbeddings, cosineSimilarity } from "./embedding.js";

const stopWords = new Set([
  "about", "after", "again", "also", "been", "being", "from", "have", "into", "just",
  "more", "than", "that", "them", "then", "they", "this", "what", "when", "where",
  "which", "while", "with", "would", "your", "there", "their", "were", "will", "still",
]);

/**
 * Build retrieval context for a user turn.
 * Uses embedding-based semantic search when config is available,
 * falls back to token-overlap when it is not.
 *
 * @param {object} repository
 * @param {string} conversationId
 * @param {string} userText
 * @param {object} [config] - { embeddingBaseUrl, embeddingApiKey, embeddingModel }
 * @returns {Promise<object>}
 */
export async function buildRetrievalContext(repository, conversationId, userText, config) {
  const recentMessages = repository.listRecentMessages(conversationId, 6);

  if (!config?.embeddingBaseUrl || !config?.embeddingApiKey) {
    return buildRetrievalContextLegacy(repository, conversationId, userText, recentMessages);
  }

  try {
    const [queryEmbedding] = await computeEmbeddings(config, userText);

    // Semantic search: messages
    const allMessageEmbeddings = repository.getAllMessageEmbeddings();
    const scoredMessages = allMessageEmbeddings
      .map((item) => ({
        id: item.messageId,
        conversationId: item.conversationId,
        role: item.role,
        text: item.text,
        createdAt: item.createdAt,
        similarity: cosineSimilarity(queryEmbedding, item.embedding)
          * (item.conversationId === conversationId ? 1.15 : 1.0),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);

    const relatedMessages = dedupeById([...recentMessages, ...scoredMessages]).slice(-8);

    // Semantic search: memory events
    const allEventEmbeddings = repository.getAllMemoryEventEmbeddings();
    const memoryEvents = allEventEmbeddings
      .map((item) => ({
        id: item.memoryEventId,
        summary: item.summary,
        score: item.score,
        occurredAt: item.occurredAt,
        similarity: cosineSimilarity(queryEmbedding, item.embedding) * (Number(item.score) || 0.5),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 5)
      .map(({ id, summary, score, occurredAt }) => ({ id, summary, score, occurredAt }));

    // Profile facts: still full list (small count, no embedding needed)
    const profileFacts = repository.listProfileFacts(10);
    const latestReflection = repository.getLatestReflection();
    const corrections = repository.listRecentCorrections ? repository.listRecentCorrections(5) : [];

    return { recentMessages, relatedMessages, memoryEvents, profileFacts, latestReflection, corrections };
  } catch (err) {
    console.error("Embedding retrieval failed, falling back to token-overlap:", err.message);
    return buildRetrievalContextLegacy(repository, conversationId, userText, recentMessages);
  }
}

// ─── Legacy token-overlap implementation (fallback) ──────────────────────────

function buildRetrievalContextLegacy(repository, conversationId, userText, recentMessages) {
  const queryTokens = tokenize(userText);
  const relatedMessages = dedupeById([
    ...recentMessages,
    ...repository.findRelevantMessages(queryTokens, conversationId, 8),
  ]).slice(-8);
  const memoryEvents = repository.findRelevantMemoryEvents(queryTokens, 5);
  const profileFacts = repository.findRelevantProfileFacts(queryTokens, 5);
  const latestReflection = repository.getLatestReflection();
  const corrections = repository.listRecentCorrections ? repository.listRecentCorrections(5) : [];
  return { recentMessages, relatedMessages, memoryEvents, profileFacts, latestReflection, corrections };
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

export function describeRetrievalContext(context) {
  return {
    recentMessages: context.recentMessages.map(projectMessage),
    relatedMessages: context.relatedMessages.map(projectMessage),
    memoryEvents: context.memoryEvents,
    profileFacts: context.profileFacts,
    latestReflection: context.latestReflection,
    corrections: context.corrections || [],
  };
}

export function buildPromptContext(context) {
  const sections = [];

  if (context.profileFacts.length > 0) {
    // Group facts by kind for better readability
    const grouped = new Map();
    for (const fact of context.profileFacts) {
      if (!grouped.has(fact.kind)) {
        grouped.set(fact.kind, []);
      }
      grouped.get(fact.kind).push(fact);
    }
    const lines = [];
    for (const [kind, facts] of grouped) {
      const values = facts.map((f) => f.value).join("; ");
      lines.push(`- ${kind}: ${values}`);
    }
    sections.push("Known facts about the user:\n" + lines.join("\n"));
  }

  if (context.memoryEvents.length > 0) {
    sections.push(
      "Relevant past events:\n" +
        context.memoryEvents.map((event) => {
          const timeStr = event.occurredAt ? `[${event.occurredAt.slice(0, 10)}] ` : "";
          return `- ${timeStr}${event.summary}`;
        }).join("\n")
    );
  }

  if (context.latestReflection) {
    const reflectionLines = [
      `Daily reflection (${context.latestReflection.reflectionDate}): ${context.latestReflection.summary}`,
    ];
    if (Array.isArray(context.latestReflection.openLoops) && context.latestReflection.openLoops.length > 0) {
      reflectionLines.push(
        "Open loops:\n" + context.latestReflection.openLoops.map((item) => `- ${item}`).join("\n")
      );
    }
    sections.push(reflectionLines.join("\n"));
  }

  if (context.relatedMessages.length > 0) {
    sections.push(
      "Related past conversations:\n" +
        context.relatedMessages
          .map((message) => {
            const timeStr = message.createdAt ? `[${message.createdAt.slice(0, 10)}] ` : "";
            return `- ${timeStr}${message.role}: ${truncate(message.text, 220)}`;
          })
          .join("\n")
    );
  }

  if (context.corrections && context.corrections.length > 0) {
    sections.push(
      "User corrections (IMPORTANT — do not repeat these mistakes):\n" +
        context.corrections
          .map((c) => `- Wrong: "${c.originalText}" → Correct: "${c.correctedText}"`)
          .join("\n")
    );
  }

  return sections.join("\n\n");
}

function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  const englishTokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !stopWords.has(token));
  const cjkTokens = [...normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]{2,}/g)]
    .map((match) => match[0]);
  return [...englishTokens, ...cjkTokens];
}

function dedupeById(rows) {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    if (!row || seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    output.push(row);
  }
  return output;
}

function projectMessage(message) {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
  };
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}