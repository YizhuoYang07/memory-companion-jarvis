import { readConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createChatService } from "./chat-service.js";
import { createModelProvider } from "./model-provider.js";
import { createServer } from "./server.js";

const config = readConfig();
const repository = createDatabase(config.databasePath);
const modelProvider = createModelProvider(config);
const chatService = createChatService({ repository, modelProvider, config });
const server = createServer(chatService, {
  authToken: config.apiAuthToken,
  rateLimitMaxRequests: config.rateLimitMaxRequests,
  rateLimitWindowMs: config.rateLimitWindowMs,
  healthInfo: {
    provider: modelProvider.kind,
    model: config.openAiModel || (modelProvider.kind === "local-fallback" ? "local-fallback" : "provider-default"),
    databasePath: config.databasePath,
  },
});

server.listen(config.port, config.host, () => {
  console.log(`personal-memory-system listening on http://${config.host}:${config.port}`);
  console.log(`model provider: ${modelProvider.kind}`);
  console.log(`database: ${config.databasePath}`);
  console.log(`auth: ${config.apiAuthToken ? "enabled" : "disabled"}`);
  if (config.rateLimitMaxRequests > 0) {
    console.log(`rate limit: ${config.rateLimitMaxRequests} requests / ${config.rateLimitWindowMs}ms`);
  }
});