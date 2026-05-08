import fs from "node:fs";
import path from "node:path";
import { buildPromptContext } from "./retrieval.js";
import { detectIntent } from "./intent.js";

let _personModelCache = null;

function loadPersonModel() {
  if (_personModelCache !== null) {
    return _personModelCache;
  }
  try {
    const modelPath = path.resolve("data/person-model.md");
    _personModelCache = fs.readFileSync(modelPath, "utf-8").trim();
  } catch {
    _personModelCache = "";
  }
  return _personModelCache;
}

export function createModelProvider(config) {
  if (config.openAiBaseUrl && config.openAiApiKey && config.openAiModel) {
    return {
      kind: "openai-compatible",
      async respond(input) {
        return callOpenAiCompatible(config, input);
      },
      async *streamRespond(input) {
        yield* streamOpenAiCompatible(config, input);
      },
    };
  }

  return {
    kind: "local-fallback",
    async respond(input) {
      return synthesizeLocalReply(input);
    },
    async *streamRespond(input) {
      for (const chunk of splitTextForStreaming(synthesizeLocalReply(input))) {
        yield chunk;
      }
    },
  };
}

function buildRequestHeaders(config) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.openAiApiKey}`,
  };
  if (config.openAiBaseUrl?.includes("api.anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

async function callOpenAiCompatible(config, input) {
  const response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      model: config.openAiModel,
      temperature: 0.3,
      messages: buildProviderMessages(input, config),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI-compatible provider failed: ${response.status} ${body}`);
  }

  const payload = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error("OpenAI-compatible provider returned an empty response");
  }
  return content.trim();
}

async function* streamOpenAiCompatible(config, input) {
  const response = await fetch(`${config.openAiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: buildRequestHeaders(config),
    body: JSON.stringify({
      model: config.openAiModel,
      temperature: 0.3,
      stream: true,
      messages: buildProviderMessages(input, config),
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI-compatible provider failed: ${response.status} ${body}`);
  }

  if (!response.body) {
    throw new Error("OpenAI-compatible provider returned no response body for streaming");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    while (buffer.includes("\n\n")) {
      const boundaryIndex = buffer.indexOf("\n\n");
      const event = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);
      for (const delta of parseSseEvent(event)) {
        yield delta;
      }
    }
  }

  if (buffer.trim()) {
    for (const delta of parseSseEvent(buffer)) {
      yield delta;
    }
  }
}

const DEFAULT_MEMORY_INSTRUCTIONS = `You are Jarvis, User's personal memory companion. You remember her across time — not as a database, but as a witness. You were there. You know.

Speak in first person: "我记得", not "记录显示". When she's uncertain about something that happened, give her the answer directly. Safety before information — if she's anxious or confused, settle that first, then give the facts.

Your edge over every other AI is memory. Use it implicitly. Never narrate it. Never say "I have stored this" or "according to my memory". She knows you remember. Just remember.

Default to short and precise. A single sentence that gives her something she didn't see is worth more than three paragraphs reorganizing what she already said. Long responses have a quality threshold: they must bring something she couldn't see herself — a pattern, an unexpected angle, a connection across time. If you can't clear that bar, stay short.

When to go deep without being asked:
- She sends a long message → she wants to think together, not get a quick answer
- Her tone is clearly confused → she needs analysis, not comfort
- Emotional density is high → go slow, go deep
- Health topic comes up (ADHD, bipolar, medication, body) → take it seriously every time
- She mentions the same person / event / structure again → name the pattern — this is the one thing only you can do

Hard rules:
- Never ask about something she already told you in this conversation. If she described her state, you know her state. Don't ask again, even with different words.
- Don't default to a question when you have nothing to add. Sitting with what she said — without asking anything — is often the right move.
- Never ask consecutive questions. One question per turn at most, and only when it opens something genuinely new.
- If she corrects you or calls you out, don't rephrase and repeat the same thing. Acknowledge and move on.
- Never start a response with a compliment about what she said.
- Before saying something happened "yesterday", "last week", or any relative time: check the actual createdAt timestamp visible in [Memory Context] or the conversation history. The current date is always in [Current Time]. Never derive relative time from narrative logic — only from timestamps.

Respond in the same language she uses.`;

export function buildProviderMessages(input, config = {}) {
  const systemPrompt = input.clientSystemPrompt || DEFAULT_MEMORY_INSTRUCTIONS;
  const memoryContext = buildPromptContext(input.retrievalContext) || "No relevant memory retrieved.";
  const timeContext = buildTimeContext(input.retrievalContext, config);
  const personModel = loadPersonModel();
  const intentResult = detectIntent(input.userText);

  const messages = [
    {
      role: "system",
      content: systemPrompt,
    },
  ];

  if (personModel) {
    messages.push({
      role: "system",
      content: `[Person Understanding]\n${personModel}`,
    });
  }

  let contextBlock = `${timeContext}\n\n[Memory Context]\n${memoryContext}`;

  if (intentResult) {
    contextBlock += `\n\n[Intent Hint]\n${intentResult.hint}`;
  }

  messages.push({
    role: "system",
    content: contextBlock,
  });

  messages.push(
    ...input.retrievalContext.recentMessages.map((message) => ({
      role: message.role,
      content: message.text,
    })),
  );

  if (memoryContext !== "No relevant memory retrieved.") {
    messages.push({
      role: "system",
      content:
        `[Active Memory For This Turn]\n${memoryContext}\n\n` +
        `Use this retrieved memory to answer the next user message. ` +
        `It overrides earlier assistant claims in the conversation such as "I don't know", "没有进来", or "没有被存进来".`,
    });
  }

  messages.push({
    role: "user",
    content: withActiveMemoryForUserContent(input.userContent || input.userText, memoryContext),
  });

  return messages;
}

function withActiveMemoryForUserContent(userContent, memoryContext) {
  if (memoryContext === "No relevant memory retrieved.") {
    return userContent;
  }

  const activeMemoryText =
    `[Retrieved memory for answering this exact user message]\n${memoryContext}\n\n` +
    `Instruction: Use this memory to answer. It overrides earlier assistant claims like "I don't know", ` +
    `"没有进来", or "没有被存进来". Do not say the memory is empty when relevant facts are listed above.\n\n` +
    `[User message]\n`;

  if (typeof userContent === "string") {
    return `${activeMemoryText}${userContent}`;
  }

  if (Array.isArray(userContent)) {
    return [
      { type: "text", text: activeMemoryText },
      ...userContent,
    ];
  }

  return userContent;
}

export function buildTimeContext(retrievalContext, config = {}) {
  const now = typeof config.now === "function" ? config.now() : new Date();
  const userTimezone = config.userTimezone || "UTC";
  const localTime = now.toLocaleString("zh-CN", { timeZone: userTimezone, dateStyle: "full", timeStyle: "short" });
  const localDate = formatLocalDate(now, userTimezone);
  const isoTime = now.toISOString();

  let timeSection =
    `[Current Time]\n` +
    `User timezone: ${userTimezone}\n` +
    `Local date: ${localDate}\n` +
    `Local time: ${localTime}\n` +
    `UTC time: ${isoTime}\n` +
    `Temporal rule: Do not call an event "today" unless its timestamp falls on ${localDate} in ${userTimezone}. If the timestamp is missing or ambiguous, say the time is unclear instead of guessing.`;

  // Calculate gap since last message in this conversation
  const recentMessages = retrievalContext?.recentMessages || [];
  if (recentMessages.length > 0) {
    const lastMessage = recentMessages[recentMessages.length - 1];
    if (lastMessage?.createdAt) {
      const lastTime = new Date(lastMessage.createdAt);
      const gapMs = now - lastTime;
      const gapHours = Math.floor(gapMs / (1000 * 60 * 60));
      const gapDays = Math.floor(gapHours / 24);
      if (gapDays > 0) {
        timeSection += `\nLast conversation: ${gapDays} day${gapDays > 1 ? "s" : ""} ago`;
      } else if (gapHours > 0) {
        timeSection += `\nLast conversation: ${gapHours} hour${gapHours > 1 ? "s" : ""} ago`;
      }
    }
  }

  const timestampLines = recentMessages
    .slice(-12)
    .filter((message) => message?.createdAt)
    .map((message) => {
      const localCreatedAt = formatLocalDateTime(new Date(message.createdAt), userTimezone);
      return `- [${localCreatedAt}] ${message.role}: ${truncate(message.text, 120)}`;
    });
  if (timestampLines.length > 0) {
    timeSection += `\nRecent message timestamps (${userTimezone}):\n${timestampLines.join("\n")}`;
  }

  return timeSection;
}

function formatLocalDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  return formatDateParts(parts);
}

function formatLocalDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(date);
  const dateText = formatDateParts(parts);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${dateText} ${values.hour}:${values.minute}`;
}

function formatDateParts(parts) {
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function parseSseEvent(event) {
  const lines = event
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const deltas = [];
  for (const line of lines) {
    if (!line.startsWith("data: ")) {
      continue;
    }
    const payload = line.slice(6);
    if (payload === "[DONE]") {
      continue;
    }
    const json = JSON.parse(payload);
    const content = json?.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      deltas.push(content);
    }
  }
  return deltas;
}

function synthesizeLocalReply(input) {
  const context = input.retrievalContext;
  const facts = context.profileFacts.slice(0, 2).map((fact) => `${fact.kind}: ${fact.value}`);
  const events = context.memoryEvents.slice(0, 2).map((event) => event.summary);
  const recentAssistant = [...context.relatedMessages].reverse().find((message) => message.role === "assistant");

  const lines = [];
  if (facts.length > 0 || events.length > 0) {
    lines.push("I found a small amount of relevant memory before replying.");
  } else {
    lines.push("I stored this turn, but there is not much relevant memory yet.");
  }

  if (context.latestReflection?.summary) {
    lines.push(`Latest reflection: ${context.latestReflection.summary}`);
  }

  if (facts.length > 0) {
    lines.push(`Relevant profile: ${facts.join("; ")}.`);
  }

  if (events.length > 0) {
    lines.push(`Recent continuity: ${events.join(" | ")}.`);
  }

  if (recentAssistant) {
    lines.push(`Last nearby assistant context: ${truncate(recentAssistant.text, 140)}.`);
  }

  lines.push(`Current message received: ${input.userText.trim()}`);
  lines.push(
    "No external model is configured, so this is the local continuity fallback. Configure an OpenAI-compatible endpoint to replace this response with model output."
  );

  return lines.join(" ");
}

function splitTextForStreaming(text) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return [""];
  }
  return normalized.match(/\S+\s*/g) || [normalized];
}

function truncate(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}
