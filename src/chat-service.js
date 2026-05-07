import { randomUUID } from "node:crypto";
import { extractTurnArtifacts } from "./extraction.js";
import { computeEmbeddings } from "./embedding.js";
import { createDailyReflection } from "./reflection-service.js";
import { buildRetrievalContext, describeRetrievalContext } from "./retrieval.js";

export function createChatService({ repository, modelProvider, config, now = () => new Date() }) {
  return {
    ensureConversation(conversationId, title = "main", externalKey = null) {
      if (conversationId) {
        const existing = repository.getConversation(conversationId);
        if (existing) {
          if (externalKey) {
            repository.linkConversationExternalKey(existing.id, externalKey);
          }
          return existing;
        }
      }
      if (externalKey) {
        const mapped = repository.getConversationByExternalKey(externalKey);
        if (mapped) {
          return mapped;
        }
      }
      const created = repository.createConversation(title);
      if (externalKey) {
        repository.linkConversationExternalKey(created.id, externalKey);
      }
      return created;
    },

    listConversations() {
      return repository.listConversations();
    },

    renameConversation(conversationId, title) {
      if (typeof title !== "string" || title.trim() === "") {
        const error = new Error("title is required");
        error.statusCode = 400;
        throw error;
      }
      const updated = repository.updateConversation(conversationId, title);
      if (!updated) {
        const error = new Error("conversation not found");
        error.statusCode = 404;
        throw error;
      }
      return updated;
    },

    deleteConversation(conversationId) {
      return repository.deleteConversation(conversationId);
    },

    listMessages(conversationId) {
      return repository.listMessages(conversationId);
    },

    listProfileFacts(limit) {
      return repository.listProfileFacts(limit);
    },

    upsertProfileFact(fact) {
      return repository.upsertProfileFact(fact);
    },

    deleteProfileFact(id) {
      return repository.deleteProfileFact(id);
    },

    listMemoryEvents(limit) {
      return repository.listMemoryEvents(limit);
    },

    getReflection(reflectionDate) {
      return repository.getReflection(reflectionDate);
    },

    getLatestReflection() {
      return repository.getLatestReflection();
    },

    listAllReflections() {
      return repository.listAllReflections();
    },

    runDailyReflection(reflectionDate = formatDate(now())) {
      return createDailyReflection(repository, reflectionDate);
    },

    getCompletionRequest(requestKey) {
      if (!requestKey) {
        return null;
      }
      return repository.getCompletionRequest(requestKey);
    },

    async prepareResponse({
      conversationId,
      text,
      providerUserContent = null,
      externalConversationKey = null,
      conversationTitle = "main",
      externalUserMessageKey = null,
      clientSystemPrompt = null,
    }) {
      const conversation = this.ensureConversation(conversationId, conversationTitle, externalConversationKey);
      const retrievalContext = await buildRetrievalContext(repository, conversation.id, text, config);
      const userMessage = repository.createMessage(conversation.id, "user", text);
      if (externalUserMessageKey) {
        repository.linkMessageExternalKey(userMessage.id, conversation.id, externalUserMessageKey);
      }

      repository.logRetrieval({
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        query: text,
        retrieved: describeRetrievalContext(retrievalContext),
      });

      return {
        conversation,
        userMessage,
        retrievalContext,
        modelInput: {
          conversationId: conversation.id,
          userText: text,
          userContent: providerUserContent || text,
          retrievalContext,
          clientSystemPrompt: clientSystemPrompt || null,
          traceId: randomUUID(),
        },
      };
    },

    syncOpenAiMessages(conversationId, normalizedMessages) {
      const historyMessages = normalizedMessages.slice(0, -1);
      const storedMessages = repository.listMessages(conversationId);

      for (const message of historyMessages) {
        if (message.role === "assistant") {
          continue;
        }

        if (message.externalMessageKey) {
          const existing = repository.getMessageByExternalKey(message.externalMessageKey);
          if (existing) {
            continue;
          }
          const created = repository.createMessage(conversationId, message.role, message.content);
          repository.linkMessageExternalKey(created.id, conversationId, message.externalMessageKey);
          continue;
        }

        if (storedMessages.length === 0) {
          repository.createMessage(conversationId, message.role, message.content);
        }
      }
    },

    getConversationState({ conversationId, externalConversationKey }) {
      const conversation = this.ensureConversation(conversationId, "openai-chat", externalConversationKey);
      return {
        conversation,
        messages: repository.listMessages(conversation.id),
        profileFacts: repository.listProfileFacts(50),
        latestReflection: repository.getLatestReflection(),
      };
    },

    async completePreparedResponse(prepared, assistantText) {
      const assistantMessage = repository.createMessage(prepared.conversation.id, "assistant", assistantText);

      // Async: extraction, memory events, profile facts, embeddings — non-blocking
      extractTurnArtifacts(prepared.userMessage, assistantMessage, config)
        .then((artifacts) => {
          const eventIds = [];
          for (const event of artifacts.memoryEvents) {
            const id = repository.createMemoryEvent(event);
            eventIds.push(id);
          }
          for (const fact of artifacts.profileFacts) {
            repository.upsertProfileFact(fact);
          }
          for (const correction of (artifacts.corrections || [])) {
            repository.createCorrection(correction);
          }
          if (config?.embeddingBaseUrl && config?.embeddingApiKey) {
            computeAndSaveEmbeddings(config, repository, prepared.userMessage, assistantMessage, artifacts.memoryEvents, eventIds)
              .catch((err) => console.error("[Embedding] save failed:", err.message));
          }
        })
        .catch((err) => console.error("[Extraction] background failed:", err.message));

      const reflectionDate = formatDate(now());
      createDailyReflection(repository, reflectionDate, config);

      return {
        conversation: prepared.conversation,
        userMessage: prepared.userMessage,
        assistantMessage,
        retrievalContext: describeRetrievalContext(prepared.retrievalContext),
        reflectionDate,
      };
    },

    async respond({
      conversationId,
      text,
      providerUserContent = null,
      externalConversationKey = null,
      externalUserMessageKey = null,
      clientSystemPrompt = null,
    }) {
      const prepared = await this.prepareResponse({
        conversationId,
        text,
        providerUserContent,
        externalConversationKey,
        clientSystemPrompt,
        externalUserMessageKey,
      });
      const assistantText = await modelProvider.respond(prepared.modelInput);
      return this.completePreparedResponse(prepared, assistantText);
    },

    async respondToOpenAiChatCompletion({ conversationId, conversationTitle, externalConversationKey, requestKey, messages }) {
      if (requestKey) {
        const existing = repository.getCompletionRequest(requestKey);
        if (existing) {
          return {
            ...existing.response,
            replayed: true,
          };
        }
      }

      const normalizedMessages = normalizeOpenAiMessages(messages);
      const latestUserMessage = [...normalizedMessages].reverse().find((message) => message.role === "user");
      if (!latestUserMessage || !latestUserMessage.hasUsableContent) {
        const error = new Error("at least one user message is required");
        error.statusCode = 400;
        throw error;
      }

      const clientSystemPrompt = extractClientSystemPrompt(normalizedMessages);

      const conversation = this.ensureConversation(
        conversationId,
        conversationTitle || "openai-chat",
        externalConversationKey,
      );
      this.syncOpenAiMessages(conversation.id, normalizedMessages);

      const result = await this.respond({
        conversationId: conversation.id,
        text: latestUserMessage.content,
        providerUserContent: latestUserMessage.providerContent,
        externalConversationKey,
        externalUserMessageKey: latestUserMessage.externalMessageKey,
        clientSystemPrompt,
      });

      if (requestKey) {
        repository.saveCompletionRequest({ requestKey, response: result });
      }

      return result;
    },

    prepareOpenAiChatCompletion({ conversationId, conversationTitle, externalConversationKey, messages }) {
      const normalizedMessages = normalizeOpenAiMessages(messages);
      const latestUserMessage = [...normalizedMessages].reverse().find((message) => message.role === "user");
      if (!latestUserMessage || !latestUserMessage.hasUsableContent) {
        const error = new Error("at least one user message is required");
        error.statusCode = 400;
        throw error;
      }

      const clientSystemPrompt = extractClientSystemPrompt(normalizedMessages);

      const conversation = this.ensureConversation(
        conversationId,
        conversationTitle || "openai-chat",
        externalConversationKey,
      );
      this.syncOpenAiMessages(conversation.id, normalizedMessages);

      return this.prepareResponse({
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        text: latestUserMessage.content,
        providerUserContent: latestUserMessage.providerContent,
        externalConversationKey,
        externalUserMessageKey: latestUserMessage.externalMessageKey,
        clientSystemPrompt,
      });
    },

    async saveCompletionRequest(requestKey, result) {
      if (!requestKey) {
        return;
      }
      repository.saveCompletionRequest({ requestKey, response: result });
    },

    streamModelResponse(modelInput) {
      return modelProvider.streamRespond(modelInput);
    },
  };
}

async function computeAndSaveEmbeddings(config, repository, userMessage, assistantMessage, memoryEvents, eventIds) {
  const messageTexts = [userMessage.text, assistantMessage.text];
  const messageIds = [userMessage.id, assistantMessage.id];
  const msgEmbeddings = await computeEmbeddings(config, messageTexts);
  for (let i = 0; i < messageIds.length; i++) {
    repository.saveMessageEmbedding(messageIds[i], msgEmbeddings[i], config.embeddingModel);
  }

  const eventSummaries = memoryEvents.map((e) => e.summary);
  if (eventSummaries.length > 0 && eventIds.length === eventSummaries.length) {
    const eventEmbeddings = await computeEmbeddings(config, eventSummaries);
    for (let i = 0; i < eventIds.length; i++) {
      repository.saveMemoryEventEmbedding(eventIds[i], eventEmbeddings[i], config.embeddingModel);
    }
  }
}

function formatDate(value) {
  return value.toISOString().slice(0, 10);
}

function extractClientSystemPrompt(normalizedMessages) {
  const systemMessages = normalizedMessages.filter((m) => m.role === "system");
  if (systemMessages.length === 0) {
    return null;
  }
  return systemMessages.map((m) => m.content).join("\n\n");
}

function normalizeOpenAiMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return [];
  }

  return messages
    .map((message) => {
      if (!message || typeof message.role !== "string") {
        return null;
      }
      const role = normalizeRole(message.role);
      const normalizedContent = normalizeMessageContent(message.content);
      if (!role || !normalizedContent.hasUsableContent) {
        return null;
      }
      return {
        role,
        content: normalizedContent.text,
        providerContent: normalizedContent.providerContent,
        hasUsableContent: normalizedContent.hasUsableContent,
        externalMessageKey: normalizeExternalMessageKey(message),
      };
    })
    .filter(Boolean);
}

function normalizeRole(role) {
  const normalized = role.trim().toLowerCase();
  if (normalized === "assistant" || normalized === "user" || normalized === "system") {
    return normalized;
  }
  return null;
}

function normalizeMessageContent(content) {
  if (typeof content === "string") {
    const text = content.trim();
    return {
      text,
      providerContent: text,
      hasUsableContent: text !== "",
    };
  }
  if (!Array.isArray(content)) {
    return {
      text: "",
      providerContent: "",
      hasUsableContent: false,
    };
  }

  const providerParts = [];
  const textParts = [];
  let imageCount = 0;

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }

    if (part.type === "text" && typeof part.text === "string") {
      const trimmed = part.text.trim();
      if (!trimmed) {
        continue;
      }
      textParts.push(trimmed);
      providerParts.push({ type: "text", text: trimmed });
      continue;
    }

    const imageUrl = normalizeImageUrlPart(part);
    if (imageUrl) {
      imageCount += 1;
      providerParts.push({ type: "image_url", image_url: { url: imageUrl } });
    }
  }

  const summaryParts = [...textParts];
  if (imageCount > 0) {
    summaryParts.push(`Attached ${imageCount} image${imageCount === 1 ? "" : "s"}.`);
  }

  const text = summaryParts.join("\n").trim();
  return {
    text,
    providerContent: providerParts.length === 0
      ? text
      : (providerParts.length === 1 && providerParts[0].type === "text" ? providerParts[0].text : providerParts),
    hasUsableContent: text !== "" || providerParts.length > 0,
  };
}

function normalizeImageUrlPart(part) {
  const candidate = part.image_url?.url || part.imageUrl?.url || part.url;
  if (typeof candidate !== "string") {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeExternalMessageKey(message) {
  if (!message || typeof message !== "object") {
    return null;
  }

  const candidates = [
    message.id,
    message.messageId,
    message.clientMessageId,
    message.metadata?.messageId,
    message.metadata?.clientMessageId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") {
      return candidate.trim();
    }
  }

  return null;
}