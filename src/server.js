import http from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";

export function createServer(chatService, options = {}) {
  const authToken = options.authToken?.trim() || null;
  const rateLimitMaxRequests = Number.isInteger(options.rateLimitMaxRequests) ? options.rateLimitMaxRequests : 0;
  const rateLimitWindowMs = Number.isInteger(options.rateLimitWindowMs) ? options.rateLimitWindowMs : 60_000;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const startedAt = now();
  const logger = options.logger || console;
  const healthInfo = options.healthInfo || {};
  const rateLimitState = new Map();
  const metrics = {
    totalRequests: 0,
    authFailures: 0,
    rateLimitedRequests: 0,
    statusCounts: new Map(),
  };

  return http.createServer(async (request, response) => {
    const requestStartedAt = now();
    const requestId = randomUUID();
    metrics.totalRequests += 1;
    response.setHeader("x-request-id", requestId);
    response.on("finish", () => {
      incrementStatusCount(metrics.statusCounts, response.statusCode);
      const durationMs = Math.max(0, now() - requestStartedAt);
      if (typeof logger.info === "function") {
        logger.info(`${request.method || "UNKNOWN"} ${request.url || "/"} ${response.statusCode} request_id=${requestId} duration_ms=${durationMs}`);
      }
    });

    try {
      const url = new URL(request.url || "/", "http://localhost");
      const isHealthEndpoint = request.method === "GET" && url.pathname === "/health";
      const isMetricsEndpoint = request.method === "GET" && url.pathname === "/metrics";

      if (!isHealthEndpoint && !isMetricsEndpoint) {
        enforceAuthorization(request, authToken, metrics);
        enforceRateLimit(request, response, rateLimitState, {
          now,
          rateLimitMaxRequests,
          rateLimitWindowMs,
          metrics,
        });
      }

      if (isHealthEndpoint) {
        return sendJson(response, 200, {
          ok: true,
          auth_enabled: Boolean(authToken),
          rate_limit: {
            enabled: rateLimitMaxRequests > 0,
            max_requests: rateLimitMaxRequests,
            window_ms: rateLimitWindowMs,
          },
          ...healthInfo,
        });
      }

      if (isMetricsEndpoint) {
        return sendMetrics(response, buildMetricsPayload(metrics, { startedAt, now }));
      }

      if (request.method === "GET" && url.pathname === "/v1/conversations") {
        return sendJson(response, 200, { conversations: chatService.listConversations() });
      }

      if (request.method === "GET" && url.pathname === "/v1/client/state") {
        const conversationId = normalizeQueryValue(url.searchParams.get("conversationId"));
        const externalConversationKey =
          normalizeQueryValue(url.searchParams.get("conversationKey"))
          || normalizeQueryValue(url.searchParams.get("threadId"))
          || normalizeQueryValue(url.searchParams.get("clientConversationId"));

        if (!conversationId && !externalConversationKey) {
          return sendJson(response, 400, { error: "conversationId or conversationKey is required" });
        }

        return sendJson(response, 200, chatService.getConversationState({
          conversationId,
          externalConversationKey,
        }));
      }

      if (request.method === "POST" && url.pathname === "/v1/conversations") {
        const body = await readJson(request);
        const conversation = chatService.ensureConversation(body.conversationId, body.title);
        return sendJson(response, 201, { conversation });
      }

      if (url.pathname.startsWith("/v1/conversations/")) {
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments.length === 3 && request.method === "PATCH") {
          const conversationId = segments[2];
          const body = await readJson(request);
          const conversation = chatService.renameConversation(conversationId, body.title);
          return sendJson(response, 200, { conversation });
        }
        if (segments.length === 3 && request.method === "DELETE") {
          const conversationId = segments[2];
          chatService.deleteConversation(conversationId);
          response.writeHead(204, {
            "cache-control": "no-store, max-age=0, must-revalidate",
            pragma: "no-cache",
            expires: "0",
          });
          response.end();
          return;
        }
        if (segments.length === 4 && segments[3] === "messages") {
          const conversationId = segments[2];
          return sendJson(response, 200, {
            messages: chatService.listMessages(conversationId),
          });
        }
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/respond") {
        const body = await readJson(request);
        if (typeof body.text !== "string" || body.text.trim() === "") {
          return sendJson(response, 400, { error: "text is required" });
        }
        const result = await chatService.respond({
          conversationId: body.conversationId,
          text: body.text,
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJson(request);
        const requestKey = resolveRequestKey(body.metadata);
        const replay = chatService.getCompletionRequest(requestKey);
        const completionId = replay?.response?.assistantMessage?.id
          ? `chatcmpl_${replay.response.assistantMessage.id.replace(/-/g, "")}`
          : `chatcmpl_${randomUUID().replace(/-/g, "")}`;

        if (body.stream === true) {
          if (replay) {
            return sendOpenAiStream(response, body.model, completionId, replay.response.assistantMessage.text);
          }

          const prepared = await chatService.prepareOpenAiChatCompletion({
            conversationId: body.metadata?.conversationId,
            conversationTitle: body.metadata?.conversationTitle,
            externalConversationKey: resolveConversationKey(body.metadata),
            messages: body.messages,
          });

          return sendOpenAiProviderStream(response, {
            chatService,
            model: body.model,
            completionId,
            prepared,
            requestKey,
          });
        }

        const result = replay?.response ?? await chatService.respondToOpenAiChatCompletion({
          conversationId: body.metadata?.conversationId,
          conversationTitle: body.metadata?.conversationTitle,
          externalConversationKey: resolveConversationKey(body.metadata),
          requestKey,
          messages: body.messages,
        });

        return sendJson(response, 200, buildOpenAiCompletionResponse(body.model, result));
      }

      if (request.method === "GET" && url.pathname === "/v1/profile-facts") {
        return sendJson(response, 200, { profileFacts: chatService.listProfileFacts(50) });
      }

      if (request.method === "GET" && url.pathname === "/v1/memory-events") {
        return sendJson(response, 200, { memoryEvents: chatService.listMemoryEvents(50) });
      }

      if (request.method === "GET" && url.pathname === "/v1/reflections") {
        return sendJson(response, 200, { reflections: chatService.listAllReflections() });
      }

      if (request.method === "POST" && url.pathname === "/v1/reflections/daily") {
        const body = await readJson(request);
        const reflection = chatService.runDailyReflection(body.date);
        return sendJson(response, 200, { reflection });
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/reflections/")) {
        const reflectionDate = url.pathname.split("/").filter(Boolean)[2];
        const reflection = chatService.getReflection(reflectionDate);
        if (!reflection) {
          return sendJson(response, 404, { error: "reflection not found" });
        }
        return sendJson(response, 200, { reflection });
      }

      return sendJson(response, 404, { error: "not found" });
    } catch (error) {
      return sendJson(response, error.statusCode || 500, {
        error: error.message || "internal server error",
      });
    }
  });
}

function enforceAuthorization(request, authToken, metrics) {
  if (!authToken) {
    return;
  }

  const header = request.headers.authorization;
  const expected = `Bearer ${authToken}`;
  if (header === expected) {
    return;
  }

  metrics.authFailures += 1;

  const error = new Error("unauthorized");
  error.statusCode = 401;
  throw error;
}

function enforceRateLimit(request, response, state, options) {
  if (!options.rateLimitMaxRequests || options.rateLimitMaxRequests <= 0) {
    return;
  }

  const ip = request.socket.remoteAddress || "unknown";
  const currentTime = options.now();
  const existing = state.get(ip);
  if (!existing || currentTime >= existing.resetAt) {
    state.set(ip, { count: 1, resetAt: currentTime + options.rateLimitWindowMs });
    return;
  }

  if (existing.count >= options.rateLimitMaxRequests) {
    options.metrics.rateLimitedRequests += 1;
    response.setHeader("retry-after", String(Math.max(1, Math.ceil((existing.resetAt - currentTime) / 1000))));
    const error = new Error("rate limit exceeded");
    error.statusCode = 429;
    throw error;
  }

  existing.count += 1;
}

function incrementStatusCount(statusCounts, statusCode) {
  const key = String(statusCode || 0);
  statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
}

function buildMetricsPayload(metrics, options) {
  const uptimeSeconds = Math.max(0, Math.floor((options.now() - options.startedAt) / 1000));
  return {
    totalRequests: metrics.totalRequests,
    authFailures: metrics.authFailures,
    rateLimitedRequests: metrics.rateLimitedRequests,
    uptimeSeconds,
    statusCounts: Array.from(metrics.statusCounts.entries()).sort((left, right) => left[0].localeCompare(right[0])),
  };
}

function sendMetrics(response, payload) {
  const lines = [
    "# HELP personal_memory_requests_total Total HTTP requests handled by the server.",
    "# TYPE personal_memory_requests_total counter",
    `personal_memory_requests_total ${payload.totalRequests}`,
    "# HELP personal_memory_auth_failures_total Total requests rejected by bearer auth.",
    "# TYPE personal_memory_auth_failures_total counter",
    `personal_memory_auth_failures_total ${payload.authFailures}`,
    "# HELP personal_memory_rate_limited_total Total requests rejected by rate limiting.",
    "# TYPE personal_memory_rate_limited_total counter",
    `personal_memory_rate_limited_total ${payload.rateLimitedRequests}`,
    "# HELP personal_memory_uptime_seconds Process uptime in seconds.",
    "# TYPE personal_memory_uptime_seconds gauge",
    `personal_memory_uptime_seconds ${payload.uptimeSeconds}`,
  ];

  for (const [statusCode, count] of payload.statusCounts) {
    lines.push(`personal_memory_response_status_total{status_code="${statusCode}"} ${count}`);
  }

  response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  response.end(`${lines.join("\n")}\n`);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("invalid JSON body");
    error.statusCode = 400;
    throw error;
  }
}

function buildOpenAiCompletionResponse(model, result) {
  const created = Math.floor(Date.now() / 1000);
  const promptTokens = estimateTokensFromText(result.userMessage.text);
  const completionTokens = estimateTokensFromText(result.assistantMessage.text);

  return {
    id: `chatcmpl_${result.assistantMessage.id.replace(/-/g, "")}`,
    object: "chat.completion",
    created,
    model: model || "personal-memory-system",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: result.assistantMessage.text,
        },
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    conversation_id: result.conversation.id,
    retrieval_context: result.retrievalContext,
  };
}

function estimateTokensFromText(text) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return 0;
  }
  return normalized.split(/\s+/).length;
}

function resolveRequestKey(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const candidates = [
    metadata.idempotencyKey,
    metadata.requestId,
    metadata.messageId,
    metadata.clientMessageId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}

function resolveConversationKey(metadata) {
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const candidates = [
    metadata.clientConversationId,
    metadata.threadId,
    metadata.conversationKey,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }
  return null;
}

function normalizeQueryValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

async function sendOpenAiStream(response, model, completionId, text) {
  const created = Math.floor(Date.now() / 1000);
  const resolvedModel = model || "personal-memory-system";
  const chunks = splitStreamingContent(text);

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, no-transform, must-revalidate",
    pragma: "no-cache",
    expires: "0",
    connection: "keep-alive",
  });

  writeSse(response, {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: resolvedModel,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  });

  for (const chunk of chunks) {
    writeSse(response, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [
        {
          index: 0,
          delta: { content: chunk },
          finish_reason: null,
        },
      ],
    });
    await waitForNextTick();
  }

  writeSse(response, {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: resolvedModel,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
      },
    ],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

async function sendOpenAiProviderStream(response, { chatService, model, completionId, prepared, requestKey }) {
  const created = Math.floor(Date.now() / 1000);
  const resolvedModel = model || "personal-memory-system";
  const streamedChunks = [];

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-cache, no-transform, must-revalidate",
    pragma: "no-cache",
    expires: "0",
    connection: "keep-alive",
  });

  writeSse(response, {
    id: completionId,
    object: "chat.completion.chunk",
    created,
    model: resolvedModel,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", content: "" },
        finish_reason: null,
      },
    ],
  });

  try {
    for await (const chunk of chatService.streamModelResponse(prepared.modelInput)) {
      streamedChunks.push(chunk);
      writeSse(response, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: resolvedModel,
        choices: [
          {
            index: 0,
            delta: { content: chunk },
            finish_reason: null,
          },
        ],
      });
    }

    const finalText = streamedChunks.join("");
    const result = await chatService.completePreparedResponse(prepared, finalText);
    if (requestKey) {
      await chatService.saveCompletionRequest(requestKey, result);
    }

    writeSse(response, {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model: resolvedModel,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    });
    response.write("data: [DONE]\n\n");
    response.end();
  } catch (error) {
    response.write(`event: error\ndata: ${JSON.stringify({ message: error.message || "streaming failed" })}\n\n`);
    response.end();
  }
}

function writeSse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function splitStreamingContent(text) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
    return [""];
  }

  const parts = [];
  const tokens = normalized.match(/\S+\s*/g) || [normalized];
  for (const token of tokens) {
    parts.push(token);
  }
  return parts;
}

function waitForNextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store, max-age=0, must-revalidate",
    pragma: "no-cache",
    expires: "0",
  });
  response.end(JSON.stringify(payload, null, 2));
}