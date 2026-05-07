const VALID_FACT_KINDS = new Set([
  "name", "self_description", "preference", "location",
  "current_focus", "health", "education", "work", "relationship", "value", "hobby",
]);

/**
 * LLM-based extraction of profile facts and memory events from one turn.
 * Falls back to regex-based extraction when config is missing or LLM fails.
 *
 * @param {object} userMessage    - { id, conversationId, text }
 * @param {object} assistantMessage - { id, conversationId, text }
 * @param {object} [config]       - { openAiBaseUrl, openAiApiKey, extractionModel?, openAiModel? }
 * @returns {Promise<{ memoryEvents: array, profileFacts: array }>}
 */
export async function extractTurnArtifacts(userMessage, assistantMessage, config) {
  if (!config?.openAiBaseUrl || !config?.openAiApiKey) {
    return extractTurnArtifactsLegacy(userMessage, assistantMessage);
  }

  const model = config.extractionModel || config.openAiModel;
  const userText = normalizeWhitespace(userMessage.text);
  const assistantText = normalizeWhitespace(assistantMessage.text);
  const today = new Date().toISOString().slice(0, 10);

  if (!userText) {
    return { memoryEvents: [], profileFacts: [], corrections: [] };
  }

  const extractionPrompt = `分析以下对话，提取两类有长期价值的信息。必须用 JSON 返回。

对话内容：
用户: ${userText}
助手: ${assistantText}

## 提取规则

### 1. profile_facts: 仅提取用户透露的**稳定个人事实**
- 只从**用户发言**中提取，不要从助手回复中提取
- 只提取长期稳定的事实（身份、偏好、价值观、关系、教育、工作等）
- 不要提取：临时状态（"我今天很累"）、对话管理（"帮我看看"）、重复已知信息
- 不要提取助手说的话当作用户的事实
- confidence: 直接陈述 0.85-0.95，间接暗示 0.5-0.7，不确定 < 0.5 则不提取
- 特别：健康/医疗诊断（心理诊断、正在服用的药物）即使间接提及（"医生说我有..."、"我在吃..."），也以 0.8+ confidence 提取为 health 类事实
- 特别：重要他人（伴侣、朋友）的稳定信息（姓名、职业、背景）也值得提取，kind 用 relationship，value 中注明该人物信息
- 格式: [{ "kind": "...", "value": "...", "confidence": 0.0-1.0 }]
- kind 可选值: name, self_description, preference, location, current_focus, health, education, work, relationship, value, hobby

### 2. memory_events: 仅提取有**长期记忆价值**的事件或状态变化
- 只从**用户发言**中提取
- 值得记住的标准：会影响未来对话的理解、标志生活阶段变化、重要决定或情感转折
- 不值得记住的：日常闲聊、打招呼、技术调试过程、对话管理
	- 事件的主角必须是用户本人。如果用户在转述他人的经历，在 summary 中注明"用户描述 [某人]：..."，不要以用户为主语
	- 严格主语保护：如果用户说"Ho发烧了/Ho被公司叫回/老金怎样/小陈怎样"，summary 不能写成"用户发烧/用户被公司叫回/用户经历..."。必须写"用户描述Ho：Ho发烧了"这类格式
- score: 重大人生事件 0.8-1.0，有意义的状态变化 0.5-0.7，一般性讨论 < 0.5 则不提取
- occurred_at: 如果用户提到事件发生时间（"昨天"、"上周"、"4月28日"等），根据今天（${today}）推算实际日期，格式 YYYY-MM-DD；无时间信息填 null
- 格式: [{ "summary": "简短摘要（中文）", "score": 0.0-1.0, "occurred_at": "YYYY-MM-DD或null" }]

## 返回格式（严格 JSON，不要 markdown 代码块）
{"profile_facts": [...], "memory_events": [...], "corrections": [...]}

### 3. corrections: 用户纠正助手/系统的错误认知
- 当用户说「不是...是...」「你记错了」「其实是」「那个不对」等纠正性表达时提取
- 格式: [{ "original": "被纠正的错误内容", "corrected": "正确内容" }]

如果对话是闲聊、调试、或没有值得提取的内容，返回空数组。宁可漏提也不要错提。`;

  try {
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
          temperature: 0,
          messages: [
            { role: "system", content: "你是一个信息提取器。只输出 JSON，不要解释。" },
            { role: "user", content: extractionPrompt },
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error(`Extraction LLM failed: ${response.status}`);
      return extractTurnArtifactsLegacy(userMessage, assistantMessage);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content?.trim() || "";
    // Strip optional markdown code block wrappers
    const jsonText = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(jsonText);

    const profileFacts = (parsed.profile_facts || [])
      .filter((fact) => fact && VALID_FACT_KINDS.has(fact.kind) && typeof fact.value === "string" && fact.value.trim())
      .filter((fact) => clamp(Number(fact.confidence) || 0, 0, 1) >= 0.5)
      .map((fact) => ({
        kind: fact.kind,
        value: fact.value.trim(),
        confidence: clamp(Number(fact.confidence) || 0.6, 0, 1),
        evidenceMessageId: userMessage.id,
      }));

    const memoryEvents = (parsed.memory_events || [])
      .filter((event) => event && typeof event.summary === "string" && event.summary.trim())
      .filter((event) => clamp(Number(event.score) || 0, 0, 1) >= 0.5)
      .filter((event) => !isLowValueMemoryEvent(event.summary, userText))
      .map((event) => ({
        summary: truncate(normalizeMemoryEventSubject(event.summary.trim(), userText), 200),
        score: clamp(Number(event.score) || 0.5, 0, 1),
        sourceMessageId: userMessage.id,
        conversationId: userMessage.conversationId,
        occurredAt: typeof event.occurred_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(event.occurred_at)
          ? event.occurred_at
          : null,
      }));

    const corrections = (parsed.corrections || [])
      .filter((c) => c && typeof c.original === "string" && typeof c.corrected === "string"
        && c.original.trim() && c.corrected.trim())
      .map((c) => ({
        originalText: truncate(c.original.trim(), 200),
        correctedText: truncate(c.corrected.trim(), 200),
        sourceMessageId: userMessage.id,
        conversationId: userMessage.conversationId,
      }));

    return { memoryEvents, profileFacts, corrections };
  } catch (err) {
    console.error("Extraction failed, falling back to regex:", err.message);
    return extractTurnArtifactsLegacy(userMessage, assistantMessage);
  }
}

// ─── Legacy regex-based implementation (fallback) ────────────────────────────

const profileMatchers = [
  { kind: "name", regex: /\bmy name is ([^.!?\n]+)/i },
  { kind: "self_description", regex: /\bi am ([^.!?\n]+)/i },
  { kind: "self_description", regex: /\bi'm ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi prefer ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi like ([^.!?\n]+)/i },
  { kind: "preference", regex: /\bi love ([^.!?\n]+)/i },
  { kind: "location", regex: /\bi live in ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi am working on ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi'm working on ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi am building ([^.!?\n]+)/i },
  { kind: "current_focus", regex: /\bi'm building ([^.!?\n]+)/i },
];

function extractTurnArtifactsLegacy(userMessage, assistantMessage) {
  const memoryEvents = [];
  const profileFacts = [];

  const normalizedUserText = normalizeWhitespace(userMessage.text);
  if (normalizedUserText && !isLowValueMemoryEvent(normalizedUserText, normalizedUserText)) {
    memoryEvents.push({
      summary: summarizeEvent(normalizedUserText),
      score: 0.6,
      sourceMessageId: userMessage.id,
      conversationId: userMessage.conversationId,
    });
  }

  for (const matcher of profileMatchers) {
    const match = matcher.regex.exec(normalizedUserText);
    if (!match) {
      continue;
    }
    const value = normalizeCapturedValue(match[1], matcher.kind);
    if (!value) {
      continue;
    }
    profileFacts.push({
      kind: matcher.kind,
      value,
      confidence: confidenceForKind(matcher.kind),
      evidenceMessageId: userMessage.id,
    });
  }

  return { memoryEvents, profileFacts, corrections: [] };
}

function summarizeEvent(text) {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() || text;
  if (/\b(stuck|blocked|can't|cannot|problem|issue)\b/i.test(text)) {
    return `User reported a blocker: ${truncate(firstSentence, 180)}`;
  }
  if (/\b(building|working on|planning|trying to|need to)\b/i.test(text)) {
    return `User discussed active work: ${truncate(firstSentence, 180)}`;
  }
  return `User discussed: ${truncate(firstSentence, 180)}`;
}

function summarizeAssistantContribution(text) {
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() || text;
  return `Assistant replied about: ${truncate(firstSentence, 180)}`;
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

const knownOtherPeople = [
  "Hunho", "Ho", "老金", "小陈", "Sky", "小申", "Tofu", "小泽", "小梁",
];

function normalizeMemoryEventSubject(summary, userText) {
  const subject = detectMentionedOtherPerson(userText);
  if (!subject || summary.includes(subject) || /^用户描述/.test(summary)) {
    return summary;
  }

  if (!looksLikeMisattributedOtherExperience(summary)) {
    return summary;
  }

  const stripped = summary
    .replace(/^用户/u, "")
    .replace(/^[，。；:：\s]*/u, "")
    .trim();
  const eventText = stripped || summary;
  return `用户描述${subject}：${eventText}`;
}

const lowValueUtterancePattern = /^(嗯+|呃+|啊+|哦+|噢+|好+|行+|可以+|漂亮|谢谢|谢了|讲完了|讲完|哈哈+|hhh+|ok|okay|yes|no|done)$/iu;

function isLowValueMemoryEvent(summary, userText) {
  const compactSummary = compactForNoiseCheck(summary);
  const compactUserText = compactForNoiseCheck(userText);
  if (!compactSummary) {
    return true;
  }

  if (lowValueUtterancePattern.test(compactSummary) || lowValueUtterancePattern.test(compactUserText)) {
    return true;
  }

  if (compactSummary.length <= 4 && !containsMemoryAnchor(summary) && !containsMemoryAnchor(userText)) {
    return true;
  }

  return false;
}

function compactForNoiseCheck(text) {
  return String(text || "")
    .trim()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function containsMemoryAnchor(text) {
  const normalized = String(text || "");
  if (detectMentionedOtherPerson(normalized)) {
    return true;
  }
  return /(\d{4}|\d{1,2}月\d{1,2}日|今天|昨天|前天|上周|下周|capstone|presentation|Truffles|Kings Cross|UNSW|UTS|Tinder)/iu.test(normalized);
}

function detectMentionedOtherPerson(text) {
  const normalized = String(text || "");
  return knownOtherPeople.find((name) => normalized.includes(name)) || null;
}

const otherExperienceTerms = [
  "发烧", "生病", "公司", "召回", "工作", "上班", "下班", "手机", "车行",
  "足球", "健身", "训练", "发热", "感冒", "被叫回", "临时", "经理", "老板",
];

function looksLikeMisattributedOtherExperience(summary) {
  if (!/^用户/.test(summary)) {
    return false;
  }
  if (/^用户(?:经历|被)/.test(summary)) {
    return true;
  }
  return otherExperienceTerms.some((term) => summary.includes(term));
}

function normalizeCapturedValue(value, kind) {
  let normalized = normalizeWhitespace(value)
    .replace(/^that\s+/i, "")
    .replace(/[.?!,;:]+$/, "")
    .trim();

  if (kind === "name") {
    normalized = normalized.split(/\b(?:and|but)\b/i)[0]?.trim() || normalized;
  }

  return normalized;
}

function confidenceForKind(kind) {
  switch (kind) {
    case "name":
      return 0.95;
    case "location":
      return 0.85;
    case "preference":
      return 0.8;
    case "current_focus":
      return 0.72;
    default:
      return 0.68;
  }
}

function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
