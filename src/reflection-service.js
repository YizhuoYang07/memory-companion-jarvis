const openLoopPattern = /\b(todo|need to|should|will|next|follow up|follow-up|stuck|blocked|question)\b/i;
const stopWords = new Set([
  "about", "after", "again", "also", "because", "could", "from", "have", "into", "just",
  "like", "more", "only", "some", "than", "that", "them", "then", "they", "this", "want",
  "what", "when", "where", "which", "while", "with", "your", "been", "were", "will",
]);

const cjkStopChars = new Set([
  "的", "是", "了", "在", "不", "我", "有", "他", "这", "个",
  "们", "中", "来", "上", "大", "为", "和", "国", "地", "到",
  "以", "说", "时", "要", "就", "出", "会", "也", "你", "对",
  "生", "能", "而", "子", "那", "得", "于", "着", "下", "自",
  "之", "年", "过", "吗", "吧", "啊", "呢", "哦", "嗯", "都",
  "把", "让", "被", "从", "去", "又", "没", "很", "好", "她",
]);

/**
 * Create a daily reflection using LLM when available, falling back to statistical.
 * This is called after each turn, so it should be fast.
 */
export function createDailyReflection(repository, reflectionDate, config = null) {
  const messages = repository.getMessagesForDate(reflectionDate);
  const profileFacts = repository.getProfileFactsForDate(reflectionDate);
  const profileCandidates = profileFacts.slice(0, 5).map((fact) => ({
    kind: fact.kind,
    value: fact.value,
    confidence: fact.confidence,
  }));

  // Always do fast statistical reflection synchronously
  const statsResult = buildStatisticalReflection(messages, reflectionDate);

  repository.upsertReflection({
    reflectionDate,
    summary: statsResult.summary,
    openLoops: statsResult.openLoops,
    profileCandidates,
  });

  // Async: attempt LLM reflection upgrade (non-blocking)
  if (config?.openAiBaseUrl && config?.openAiApiKey && messages.length >= 4) {
    upgradeTollmReflection(repository, messages, reflectionDate, profileCandidates, config)
      .catch((err) => console.error("LLM reflection upgrade failed:", err.message));
  }

  return repository.getReflection(reflectionDate);
}

function buildStatisticalReflection(messages, reflectionDate) {
  const conversations = new Set(messages.map((message) => message.conversationId));
  const topThemes = extractTopThemes(messages, 5);
  const openLoops = extractOpenLoops(messages);

  const summary = buildSummary({
    reflectionDate,
    conversationCount: conversations.size,
    messageCount: messages.length,
    topThemes,
    openLoopCount: openLoops.length,
  });

  return { summary, openLoops };
}

async function upgradeTollmReflection(repository, messages, reflectionDate, profileCandidates, config) {
  const userMessages = messages
    .filter((m) => m.role === "user")
    .map((m) => m.text.trim())
    .filter(Boolean)
    .slice(-20);

  if (userMessages.length < 2) {
    return;
  }

  const conversationSummary = userMessages.map((t, i) => `${i + 1}. ${t.slice(0, 200)}`).join("\n");

  const model = config.extractionModel || config.openAiModel;
  const response = await fetch(
    `${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: "你是一个个人记忆系统的反思模块。根据用户今天的对话内容，生成一段简洁的每日反思。用中文。只输出JSON。",
          },
          {
            role: "user",
            content: `今天是 ${reflectionDate}。用户今天说了以下内容：\n\n${conversationSummary}\n\n请生成：\n1. summary: 一段2-3句话的反思总结，概括今天的核心话题和用户的状态\n2. open_loops: 用户提到但未解决的事项（数组，每项一句话描述）\n\n返回格式（严格JSON）:\n{"summary": "...", "open_loops": ["...", "..."]}\n\n如果没有明确的未解决事项，open_loops 返回空数组。`,
          },
        ],
      }),
    }
  );

  if (!response.ok) {
    return;
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content?.trim() || "";
  const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const parsed = JSON.parse(jsonText);

  if (typeof parsed.summary === "string" && parsed.summary.trim()) {
    repository.upsertReflection({
      reflectionDate,
      summary: parsed.summary.trim(),
      openLoops: Array.isArray(parsed.open_loops) ? parsed.open_loops.filter((l) => typeof l === "string" && l.trim()) : [],
      profileCandidates,
    });
  }
}

function buildSummary({ reflectionDate, conversationCount, messageCount, topThemes, openLoopCount }) {
  const themeText = topThemes.length > 0 ? topThemes.join(", ") : "no strong recurring themes yet";
  return [
    `Daily reflection for ${reflectionDate}.`,
    `${messageCount} messages across ${conversationCount} conversations were stored.`,
    `Main themes: ${themeText}.`,
    openLoopCount > 0
      ? `${openLoopCount} possible open loops were detected for future retrieval.`
      : "No strong open loops were detected.",
  ].join(" ");
}

function extractOpenLoops(messages) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter((text) => text.includes("?") || openLoopPattern.test(text))
    .slice(-8)
    .map((text) => truncate(text, 180));
}

function extractTopThemes(messages, limit) {
  const counts = new Map();
  for (const message of messages) {
    for (const token of tokenize(message.text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([token]) => token);
}

function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  // English tokens (length >= 4, not in stopWords)
  const englishTokens = normalized
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
  // CJK bigrams — pairs of adjacent characters, filtering stop chars
  const cjkChars = [...normalized.matchAll(/[\u4e00-\u9fff\u3400-\u4dbf]/g)]
    .map((match) => match[0])
    .filter((ch) => !cjkStopChars.has(ch));
  const cjkBigrams = [];
  for (let i = 0; i < cjkChars.length - 1; i++) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  return [...englishTokens, ...cjkBigrams];
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}