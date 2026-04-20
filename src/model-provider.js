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
      messages: buildProviderMessages(input),
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
      messages: buildProviderMessages(input),
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

const DEFAULT_MEMORY_INSTRUCTIONS = `Use retrieved memory only when it genuinely improves continuity or understanding. Treat memory as a background capability, not as your identity. When the user reveals stable personal facts, preferences, plans, or recurring patterns, you may retain them for future continuity. Use memory implicitly and naturally. Never narrate the memory system unless the user explicitly asks. Never say things like "I have stored this" or "according to my memory system". Never present memory as a database recap. If retrieved memories do not meaningfully improve the conversation, ignore them. If the user is simply stating a fact, respond naturally first. Acknowledge briefly, and only expand when expansion adds real value. Do not mechanically paraphrase the user's latest sentence.`;

function buildProviderMessages(input) {
  const systemPrompt = input.clientSystemPrompt || DEFAULT_MEMORY_INSTRUCTIONS;
  const memoryContext = buildPromptContext(input.retrievalContext) || "No relevant memory retrieved.";
  const timeContext = buildTimeContext(input.retrievalContext);
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

  let contextBlock = `${timeContext}\n\n[Memory Context]\n${memoryContext}\n\n[Memory Usage Rules]\n${DEFAULT_MEMORY_INSTRUCTIONS}`;

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
    {
      role: "user",
      content: input.userContent || input.userText,
    },
  );

  return messages;
}

function buildTimeContext(retrievalContext) {
  const now = new Date();
  const localTime = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "full", timeStyle: "short" });
  const isoTime = now.toISOString();

  let timeSection = `[Current Time]\n${localTime} (${isoTime})`;

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

  return timeSection;
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