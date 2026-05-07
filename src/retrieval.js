import { computeEmbeddings, cosineSimilarity } from "./embedding.js";
import { detectEntityNames, getEntityDefinition } from "./entities.js";
import { detectIntent } from "./intent.js";

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
  const recentMessages = repository.listRecentMessages(conversationId, 200);
  const retrievalRoute = classifyRetrievalRoute(userText);
  const entityCards = buildEntityCardsForQuery(repository, userText, retrievalRoute);
  const timelineEvents = buildTimelineEventsForQuery(repository, userText, retrievalRoute);
  const correctionLimit = retrievalRoute.type === "correction" ? 20 : 10;

  if (!config?.embeddingBaseUrl || !config?.embeddingApiKey) {
    return buildRetrievalContextLegacy(
      repository,
      conversationId,
      userText,
      recentMessages,
      entityCards,
      timelineEvents,
      retrievalRoute,
      correctionLimit,
    );
  }

  try {
    const [queryEmbedding] = await computeEmbeddings(config, userText);

    // Semantic search: messages
    const recentIds = new Set(recentMessages.map((m) => m.id));
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
      .slice(0, 30);

    // Only keep semantically relevant messages that are NOT already in the recent window
    const relatedMessages = scoredMessages.filter((m) => !recentIds.has(m.id)).slice(0, 20);

    // Semantic search: memory events
    const allEventEmbeddings = repository.getAllMemoryEventEmbeddings();
    const memoryEventLimit = memoryEventLimitForRoute(retrievalRoute);
    const memoryEvents = allEventEmbeddings
      .map((item) => ({
        id: item.memoryEventId,
        summary: item.summary,
        score: item.score,
        occurredAt: item.occurredAt,
        similarity: cosineSimilarity(queryEmbedding, item.embedding) * (Number(item.score) || 0.5),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, memoryEventLimit)
      .map(({ id, summary, score, occurredAt }) => ({ id, summary, score, occurredAt }));

    // Profile facts: top-30 by confidence + keyword overlay for names/entities in user query
    const profileFactsTop = repository.listProfileFacts(profileFactLimitForRoute(retrievalRoute));
    const queryTokens = tokenize(userText);
    const profileFactsKeyword = queryTokens.length > 0
      ? repository.findRelevantProfileFacts(queryTokens, 20)
      : [];
    const profileFactTopIds = new Set(profileFactsTop.map((f) => f.id));
    const profileFacts = [
      ...profileFactsTop,
      ...profileFactsKeyword.filter((f) => !profileFactTopIds.has(f.id)),
    ];
    const latestReflection = repository.getLatestReflection();
    const corrections = repository.listRecentCorrections ? repository.listRecentCorrections(correctionLimit) : [];

    return {
      recentMessages,
      relatedMessages,
      memoryEvents,
      profileFacts,
      latestReflection,
      corrections,
      entityCards,
      timelineEvents,
      retrievalRoute,
    };
  } catch (err) {
    console.error("Embedding retrieval failed, falling back to token-overlap:", err.message);
    return buildRetrievalContextLegacy(
      repository,
      conversationId,
      userText,
      recentMessages,
      entityCards,
      timelineEvents,
      retrievalRoute,
      correctionLimit,
    );
  }
}

// ─── Legacy token-overlap implementation (fallback) ──────────────────────────

function buildRetrievalContextLegacy(
  repository,
  conversationId,
  userText,
  recentMessages,
  entityCards = [],
  timelineEvents = [],
  retrievalRoute = classifyRetrievalRoute(userText),
  correctionLimit = 10,
) {
  const queryTokens = tokenize(userText);
  const recentIds = new Set(recentMessages.map((m) => m.id));
  const legacyRelated = repository.findRelevantMessages(queryTokens, conversationId, 30);
  const relatedMessages = legacyRelated.filter((m) => !recentIds.has(m.id)).slice(0, 20);
  const memoryEvents = repository.findRelevantMemoryEvents(queryTokens, memoryEventLimitForRoute(retrievalRoute));
  const profileFacts = repository.findRelevantProfileFacts(queryTokens, profileFactLimitForRoute(retrievalRoute));
  const latestReflection = repository.getLatestReflection();
  const corrections = repository.listRecentCorrections ? repository.listRecentCorrections(correctionLimit) : [];
  return {
    recentMessages,
    relatedMessages,
    memoryEvents,
    profileFacts,
    latestReflection,
    corrections,
    entityCards,
    timelineEvents,
    retrievalRoute,
  };
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
    entityCards: context.entityCards || [],
    timelineEvents: context.timelineEvents || [],
    retrievalRoute: context.retrievalRoute || null,
  };
}

export function buildPromptContext(context) {
  const sections = [
    [
      "Evidence packet rules:",
      "- Use active facts/events, entity cards, timeline context, and user corrections as grounding evidence.",
      "- User corrections override older facts/events and earlier assistant claims.",
      "- Treat relationship labels and motives as inferences unless they are explicitly stated by the user.",
      "- If evidence conflicts or is missing, state the uncertainty instead of collapsing it into a confident answer.",
    ].join("\n"),
  ];

  if (context.latestReflection) {
    const reflectionLines = [
      `Pattern understanding (${context.latestReflection.reflectionDate}): ${context.latestReflection.summary}`,
    ];
    if (Array.isArray(context.latestReflection.openLoops) && context.latestReflection.openLoops.length > 0) {
      reflectionLines.push(
        "Open loops:\n" + context.latestReflection.openLoops.map((item) => `- ${item}`).join("\n")
      );
    }
    sections.push(reflectionLines.join("\n"));
  }

  if (context.retrievalRoute) {
    sections.push(formatRetrievalRoute(context.retrievalRoute));
    const valueCheck = formatValueExecutionCheck(context.retrievalRoute);
    if (valueCheck) {
      sections.push(valueCheck);
    }
  }

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

  if (Array.isArray(context.entityCards) && context.entityCards.length > 0) {
    sections.push(
      "Entity cards for this turn:\n" +
        context.entityCards.map(formatEntityCard).join("\n\n")
    );
  }

  if (Array.isArray(context.timelineEvents) && context.timelineEvents.length > 0) {
    sections.push(
      "Timeline context for this time-sensitive turn:\n" +
        "Use these dates before using narrative order. If the relevant event is not listed, say the time is unclear.\n" +
        context.timelineEvents.map((event) => {
          const timeStr = event.occurredAt ? `[${event.occurredAt.slice(0, 10)}] ` : "[time unclear] ";
          return `- ${timeStr}${event.summary}`;
        }).join("\n")
    );
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

  if (context.relatedMessages.length > 0) {
    sections.push(
      "Related past conversations:\n" +
        context.relatedMessages
          .map((message) => {
            const timeStr = message.createdAt ? `[${message.createdAt.slice(0, 10)}] ` : "";
            return `- ${timeStr}${message.role}: ${truncate(message.text, 400)}`;
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

export function classifyRetrievalRoute(userText) {
  const text = String(userText || "").trim();
  const entityNames = detectEntityNames(text);
  const intentResult = detectIntent(text);

  if (matchesAny(text, CORRECTION_PATTERNS) || intentResult?.intent === "correction") {
    return {
      type: "correction",
      entityNames,
      strategy: ["recent_corrections", "active_facts", "active_events"],
      guidance: "Treat the user's correction as authoritative for future turns. Do not defend the older claim; update the answer around the corrected wording.",
    };
  }

  if (matchesAny(text, HEALTH_RISK_PATTERNS)) {
    return {
      type: "health_risk",
      entityNames,
      strategy: ["health_facts", "recent_events", "uncertainty_guardrail"],
      guidance: "Separate known facts, medical uncertainty, and practical next steps. Do not diagnose, do not over-reassure, and do not use anxiety reduction as evidence.",
    };
  }

  if (intentResult?.intent === "time_query") {
    return {
      type: "timeline_query",
      entityNames,
      strategy: ["timeline_events", "message_timestamps", "entity_cards_if_named"],
      guidance: "Answer from explicit timestamps first. Use 'today', 'yesterday', or 'last time' only when the timestamp supports it; otherwise say the time is unclear.",
    };
  }

  if (entityNames.length > 0 && matchesAny(text, RELATIONSHIP_PATTERNS)) {
    return {
      type: "relationship_reasoning",
      entityNames,
      strategy: ["entity_cards", "relationship_state", "corrections", "recent_events"],
      guidance: "Keep facts, user feelings, and Jarvis inferences separate. Do not collapse changing relationship evidence into a fixed label.",
    };
  }

  if (entityNames.length > 0 && matchesAny(text, ENTITY_QUERY_PATTERNS)) {
    return {
      type: "entity_query",
      entityNames,
      strategy: ["entity_cards", "active_facts", "key_events", "corrections"],
      guidance: "Answer from the named entity card first. If the card is thin or conflicting, say what is known and what is still uncertain.",
    };
  }

  if (intentResult?.intent === "memory_query") {
    return {
      type: "memory_lookup",
      entityNames,
      strategy: ["semantic_memory", "active_events", "profile_facts", "corrections"],
      guidance: "Use retrieved memory as evidence and include concrete details when available. If memory is absent or conflicting, say that plainly.",
    };
  }

  if (intentResult?.intent === "thinking" || intentResult?.intent === "emotional") {
    return {
      type: "open_thinking",
      entityNames,
      strategy: ["recent_context", "relevant_patterns", "active_memory"],
      guidance: "Use memory to sharpen the user's thinking, not to force a conclusion. Name uncertainty and alternative explanations when evidence is thin.",
    };
  }

  return {
    type: "casual_chat",
    entityNames,
    strategy: ["recent_context", "light_memory"],
    guidance: "Keep memory use light and implicit. Do not overfit a casual turn into a large life pattern.",
  };
}

function buildEntityCardsForQuery(repository, userText, retrievalRoute = classifyRetrievalRoute(userText)) {
  const entityNames = retrievalRoute.entityNames || detectEntityNames(userText);
  if (entityNames.length === 0 || typeof repository.findEntityCards !== "function") {
    return [];
  }
  return repository.findEntityCards(entityNames, { factsLimit: 8, eventsLimit: 8 });
}

function buildTimelineEventsForQuery(repository, userText, retrievalRoute = classifyRetrievalRoute(userText)) {
  if (retrievalRoute.type !== "timeline_query" || typeof repository.listMemoryEvents !== "function") {
    return [];
  }

  const entityNames = retrievalRoute.entityNames || detectEntityNames(userText);
  const aliases = entityNames
    .flatMap((name) => getEntityDefinition(name)?.aliases || [])
    .filter(Boolean);
  const events = repository.listMemoryEvents(60);
  const filtered = aliases.length > 0
    ? events.filter((event) => aliases.some((alias) => event.summary.includes(alias)))
    : events;
  return filtered.slice(0, 30);
}

function formatRetrievalRoute(route) {
  return [
    "Retrieval route for this turn:",
    `- Route: ${route.type}`,
    route.entityNames?.length > 0 ? `- Named entities: ${route.entityNames.join(", ")}` : null,
    `- Strategy: ${route.strategy.join(", ")}`,
    `- Guidance: ${route.guidance}`,
  ].filter(Boolean).join("\n");
}

function formatValueExecutionCheck(route) {
  if (!HIGH_STAKES_ROUTES.has(route.type)) {
    return null;
  }

  const lines = [
    "Value execution check (诚实 / 好奇 / 求真):",
    "- 诚实: Do not state an inference as a fact. If evidence is missing, old, or conflicting, say that directly.",
    "- 好奇: Look for the question behind the question, but do not invent motives or hidden meanings without evidence.",
    "- 求真: User corrections and explicit timestamps override older memories, person-model impressions, and earlier assistant claims.",
    "- Before answering, check whether you are over-reassuring, ignoring a correction, skipping timestamps, or collapsing uncertainty into confidence.",
  ];

  if (route.type === "health_risk") {
    lines.push(
      "- Health risk: separate known facts, general risk, unknowns, and reasonable next steps. Never imply zero risk from incomplete evidence."
    );
  }

  if (route.type === "relationship_reasoning") {
    lines.push(
      "- Relationship reasoning: separate behavior facts, the user's feelings, Jarvis's inference, alternative explanations, and what cannot be known yet."
    );
  }

  if (route.type === "timeline_query") {
    lines.push(
      "- Time reasoning: relative-time words must be anchored to explicit timestamps, not narrative closeness."
    );
  }

  if (route.type === "correction") {
    lines.push(
      "- Correction handling: accept the corrected claim as the active ground truth unless later evidence explicitly changes it."
    );
  }

  if (route.type === "entity_query") {
    lines.push(
      "- Entity query: distinguish stable identity facts from relationship status, recent events, and uncertain impressions."
    );
  }

  return lines.join("\n");
}

const HIGH_STAKES_ROUTES = new Set([
  "correction",
  "entity_query",
  "timeline_query",
  "relationship_reasoning",
  "health_risk",
  "memory_lookup",
]);

function memoryEventLimitForRoute(route) {
  if (route.type === "timeline_query" || route.type === "relationship_reasoning") {
    return 24;
  }
  if (route.type === "health_risk") {
    return 18;
  }
  return 20;
}

function profileFactLimitForRoute(route) {
  if (route.type === "entity_query" || route.type === "relationship_reasoning") {
    return 35;
  }
  if (route.type === "health_risk" || route.type === "correction") {
    return 25;
  }
  return 20;
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

const CORRECTION_PATTERNS = [
  /不是.*是/, /你[搞弄]错/, /其实是/, /那个不对/, /错了/, /纠正/, /应该是/,
  /不对.*应该/, /你说错/, /wrong/i, /actually/i, /correct.*is/i,
];

const HEALTH_RISK_PATTERNS = [
  /HIV/i, /艾滋/, /性病/, /STD/i, /STI/i, /感染/, /发烧/, /安全套/, /无套/,
  /怀孕/, /验孕/, /检测/, /药物/, /副作用/, /ADHD/i, /bipolar/i, /躁郁/,
  /抑郁/, /焦虑症/, /医生/, /医院/, /窗口期/,
];

const RELATIONSHIP_PATTERNS = [
  /关系/, /喜欢/, /爱/, /暧昧/, /男友/, /女友/, /伴侣/, /约会/, /分手/, /断联/,
  /attachment/i, /分离焦虑/, /牵挂/, /想他/, /想她/, /吃醋/, /忠贞/, /安全感/,
  /为什么.*他/, /为什么.*她/, /他.*怎么想/, /她.*怎么想/,
];

const ENTITY_QUERY_PATTERNS = [
  /是谁/, /谁是/, /什么人/, /你记得.*吗/, /还记得.*吗/, /介绍/, /讲讲/,
  /who is/i, /tell me about/i, /remember.*\?/i,
];

function formatEntityCard(card) {
  const lines = [`- ${card.name} (aliases: ${card.aliases.join(", ")})`];
  if (card.relationshipState) {
    lines.push(
      `  Relationship state: ${card.relationshipState.label} ` +
      `(confidence ${card.relationshipState.confidence})`
    );
    lines.push(`  Relationship guidance: ${card.relationshipState.guidance}`);
  }
  if (Array.isArray(card.facts) && card.facts.length > 0) {
    lines.push("  Facts:");
    for (const fact of card.facts.slice(0, 8)) {
      lines.push(`  - ${fact.kind}: ${fact.value}`);
    }
  }
  if (Array.isArray(card.events) && card.events.length > 0) {
    lines.push("  Key events:");
    for (const event of card.events.slice(0, 8)) {
      const timeStr = event.occurredAt ? `[${event.occurredAt.slice(0, 10)}] ` : "";
      lines.push(`  - ${timeStr}${event.summary}`);
    }
  }
  return lines.join("\n");
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
