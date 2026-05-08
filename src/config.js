export function readConfig(env = process.env) {
  const openAiBaseUrl = env.OPENAI_BASE_URL?.trim() || null;
  const openAiApiKey = env.OPENAI_API_KEY?.trim() || null;
  const openAiEmbeddingApiKey = env.OPENAI_API_KEY_GPT?.trim() || null;
  const explicitEmbeddingBaseUrl = env.EMBEDDING_BASE_URL?.trim() || null;
  const openAiBaseUrlSupportsEmbeddings = isOpenAiEmbeddingEndpoint(openAiBaseUrl);
  const embeddingBaseUrl =
    explicitEmbeddingBaseUrl
    || (openAiEmbeddingApiKey ? "https://api.openai.com/v1" : null)
    || (openAiBaseUrlSupportsEmbeddings ? openAiBaseUrl : null);
  const embeddingApiKey =
    env.EMBEDDING_API_KEY?.trim()
    || openAiEmbeddingApiKey
    || (openAiBaseUrlSupportsEmbeddings ? openAiApiKey : null);

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
    userTimezone: env.USER_TIMEZONE?.trim() || "UTC",
    embeddingBaseUrl,
    embeddingApiKey: embeddingBaseUrl ? embeddingApiKey : null,
    embeddingModel: env.EMBEDDING_MODEL?.trim() || "text-embedding-3-small",
    extractionModel: env.EXTRACTION_MODEL?.trim() || env.OPENAI_MODEL?.trim() || null,
  };
}

function parseInteger(raw, fallbackValue) {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isInteger(parsed) ? parsed : fallbackValue;
}

function isOpenAiEmbeddingEndpoint(baseUrl) {
  if (!baseUrl) {
    return false;
  }
  try {
    const url = new URL(baseUrl);
    return url.hostname === "api.openai.com";
  } catch {
    return false;
  }
}
