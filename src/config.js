export function readConfig(env = process.env) {
  const openAiBaseUrl = env.OPENAI_BASE_URL?.trim() || null;
  const openAiApiKey = env.OPENAI_API_KEY?.trim() || null;
  return {
    host: env.HOST?.trim() || env.BIND_HOST?.trim() || "0.0.0.0",
    port: parseInteger(env.PORT, 3030),
    databasePath: env.MEMORY_DB_PATH?.trim() || "data/memory.db",
    openAiBaseUrl,
    openAiApiKey,
    openAiModel: env.OPENAI_MODEL?.trim() || null,
    apiAuthToken: env.API_AUTH_TOKEN?.trim() || null,
    rateLimitMaxRequests: parseInteger(env.RATE_LIMIT_MAX_REQUESTS, 0),
    rateLimitWindowMs: parseInteger(env.RATE_LIMIT_WINDOW_MS, 60_000),
    embeddingBaseUrl: env.EMBEDDING_BASE_URL?.trim() || openAiBaseUrl,
    embeddingApiKey: env.EMBEDDING_API_KEY?.trim() || openAiApiKey,
    embeddingModel: env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    extractionModel: env.EXTRACTION_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null,
  };
}

function parseInteger(raw, fallbackValue) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) ? parsed : fallbackValue;
}