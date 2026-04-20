import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../src/database.js";
import { createChatService } from "../src/chat-service.js";
import { createServer } from "../src/server.js";

function createHarness(options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-system-server-"));
  const repository = createDatabase(path.join(tempDir, "memory.db"));
  const modelProvider = {
    kind: "test-double",
    async respond(input) {
      return `reply for: ${input.userText}`;
    },
    async *streamRespond(input) {
      yield "reply ";
      yield `for: ${input.userText}`;
    },
  };
  const service = createChatService({
    repository,
    modelProvider,
    now: () => new Date("2026-03-10T12:00:00.000Z"),
  });
  const server = createServer(service, options.serverOptions);
  return { service, server };
}

test("health endpoint exposes production readiness metadata", async () => {
  const { server } = createHarness({
    serverOptions: {
      authToken: "secret",
      rateLimitMaxRequests: 5,
      rateLimitWindowMs: 60_000,
      healthInfo: { provider: "test-double" },
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.auth_enabled, true);
    assert.equal(payload.rate_limit.enabled, true);
    assert.equal(payload.provider, "test-double");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("metrics endpoint exposes request counters in prometheus format", async () => {
  let currentTime = 2_000;
  const { server } = createHarness({
    serverOptions: {
      authToken: "secret",
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 60_000,
      now: () => currentTime,
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/conversations`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      headers: {
        authorization: "Bearer secret",
      },
    });
    assert.equal(authorized.status, 200);

    const rateLimited = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      headers: {
        authorization: "Bearer secret",
      },
    });
    assert.equal(rateLimited.status, 429);

    currentTime = 5_000;
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    const payload = await metrics.text();

    assert.equal(metrics.status, 200);
    assert.match(metrics.headers.get("content-type") || "", /text\/plain/);
    assert.match(payload, /personal_memory_requests_total 4/);
    assert.match(payload, /personal_memory_auth_failures_total 1/);
    assert.match(payload, /personal_memory_rate_limited_total 1/);
    assert.match(payload, /personal_memory_uptime_seconds 3/);
    assert.match(payload, /personal_memory_response_status_total\{status_code="200"\} 1/);
    assert.match(payload, /personal_memory_response_status_total\{status_code="401"\} 1/);
    assert.match(payload, /personal_memory_response_status_total\{status_code="429"\} 1/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("server enforces bearer auth when configured", async () => {
  const { server } = createHarness({
    serverOptions: {
      authToken: "secret-token",
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/v1/conversations`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      headers: {
        authorization: "Bearer secret-token",
      },
    });
    assert.equal(authorized.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("server applies rate limiting when configured", async () => {
  let currentTime = 0;
  const { server } = createHarness({
    serverOptions: {
      rateLimitMaxRequests: 2,
      rateLimitWindowMs: 1_000,
      now: () => currentTime,
    },
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const first = await fetch(`http://127.0.0.1:${port}/v1/conversations`);
    const second = await fetch(`http://127.0.0.1:${port}/v1/conversations`);
    const third = await fetch(`http://127.0.0.1:${port}/v1/conversations`);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);

    currentTime = 1_100;
    const fourth = await fetch(`http://127.0.0.1:${port}/v1/conversations`);
    assert.equal(fourth.status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("deleting an already-removed conversation stays idempotent", async () => {
  const { server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const created = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "delete-me" }),
    });
    assert.equal(created.status, 201);
    const payload = await created.json();
    const conversationId = payload.conversation.id;

    const firstDelete = await fetch(`http://127.0.0.1:${port}/v1/conversations/${conversationId}`, {
      method: "DELETE",
    });
    const secondDelete = await fetch(`http://127.0.0.1:${port}/v1/conversations/${conversationId}`, {
      method: "DELETE",
    });

    assert.equal(firstDelete.status, 204);
    assert.equal(secondDelete.status, 204);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint returns chat completion payload and stores conversation", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          conversationTitle: "native-client-thread",
        },
        messages: [
          { role: "system", content: "You are helpful." },
          { role: "user", content: "I prefer native Apple clients." },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.object, "chat.completion");
    assert.equal(payload.model, "gpt-test");
    assert.equal(payload.choices[0].message.role, "assistant");
    assert.match(payload.choices[0].message.content, /reply for:/);
    assert.ok(payload.conversation_id);
    assert.equal(payload.retrieval_context.latestReflection, null);

    const messages = service.listMessages(payload.conversation_id);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "user");
    assert.equal(messages[2].role, "assistant");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint includes latest reflection on later turns", async () => {
  const { server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "reflection-thread",
          requestId: "reflection-turn-1",
        },
        messages: [
          { role: "user", content: "I need to finish the retrieval layer next and I am stuck on ranking." },
        ],
      }),
    });
    assert.equal(firstResponse.status, 200);

    const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "reflection-thread",
          requestId: "reflection-turn-2",
        },
        messages: [
          { role: "user", content: "I need to finish the retrieval layer next and I am stuck on ranking." },
          { role: "assistant", content: "reply for: I need to finish the retrieval layer next and I am stuck on ranking." },
          { role: "user", content: "What should we continue tomorrow?" },
        ],
      }),
    });
    const payload = await secondResponse.json();

    assert.equal(secondResponse.status, 200);
    assert.ok(payload.retrieval_context.latestReflection);
    assert.equal(payload.retrieval_context.latestReflection.reflectionDate, "2026-03-10");
    assert.equal(payload.retrieval_context.latestReflection.openLoops.length > 0, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint supports SSE streaming", async () => {
  const { server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        messages: [{ role: "user", content: "Hello streaming world" }],
      }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);

    const raw = await response.text();
    assert.match(raw, /data: \[DONE\]/);

    const payloads = raw
      .split("\n\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("data: ") && entry !== "data: [DONE]")
      .map((entry) => JSON.parse(entry.slice(6)));

    assert.equal(payloads[0].object, "chat.completion.chunk");
    assert.equal(payloads[0].choices[0].delta.role, "assistant");
    assert.equal(payloads.at(-1).choices[0].finish_reason, "stop");
    assert.equal(
      payloads
        .flatMap((payload) => payload.choices)
        .map((choice) => choice.delta?.content || "")
        .join(""),
      "reply for: Hello streaming world"
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint persists streamed assistant replies", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        stream: true,
        metadata: {
          clientConversationId: "stream-persist-thread",
          requestId: "stream-req-1",
        },
        messages: [{ role: "user", content: "Persist streamed reply" }],
      }),
    });

    assert.equal(response.status, 200);
    await response.text();

    const conversations = service.listConversations();
    assert.equal(conversations.length, 1);
    const messages = service.listMessages(conversations[0].id);
    assert.equal(messages.length, 2);
    assert.equal(messages[1].text, "reply for: Persist streamed reply");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint accepts text plus image_url content arrays", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "vision-http-thread",
        },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Please look at the attached image." },
              { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZmFrZQ==" } },
            ],
          },
        ],
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.match(payload.choices[0].message.content, /reply for: Please look at the attached image\.\nAttached 1 image\./);

    const messages = service.listMessages(payload.conversation_id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].text, "Please look at the attached image.\nAttached 1 image.");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("conversation endpoints support rename and delete", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const created = await fetch(`http://127.0.0.1:${port}/v1/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Original title" }),
    });
    const createdPayload = await created.json();

    const renamed = await fetch(`http://127.0.0.1:${port}/v1/conversations/${createdPayload.conversation.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed title" }),
    });
    const renamedPayload = await renamed.json();

    assert.equal(renamed.status, 200);
    assert.equal(renamedPayload.conversation.title, "Renamed title");
    assert.equal(service.listConversations()[0].title, "Renamed title");

    const deleted = await fetch(`http://127.0.0.1:${port}/v1/conversations/${createdPayload.conversation.id}`, {
      method: "DELETE",
    });

    assert.equal(deleted.status, 204);
    assert.equal(service.listConversations().length, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint is idempotent for retried request metadata", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const requestBody = {
      model: "gpt-test",
      metadata: {
        conversationTitle: "retry-thread",
        requestId: "req-123",
      },
      messages: [
        { role: "user", content: "Remember that I prefer native Apple clients." },
      ],
    };

    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const firstPayload = await firstResponse.json();

    const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstPayload.id, secondPayload.id);
    assert.equal(firstPayload.choices[0].message.content, secondPayload.choices[0].message.content);
    assert.equal(firstPayload.conversation_id, secondPayload.conversation_id);

    const messages = service.listMessages(firstPayload.conversation_id);
    assert.equal(messages.length, 2);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint reuses the same internal conversation for external thread metadata", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          conversationTitle: "ios-thread",
          clientConversationId: "thread-42",
        },
        messages: [{ role: "user", content: "I am building a memory backend." }],
      }),
    });
    const firstPayload = await firstResponse.json();

    const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "thread-42",
        },
        messages: [{ role: "user", content: "Continue that same thread." }],
      }),
    });
    const secondPayload = await secondResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstPayload.conversation_id, secondPayload.conversation_id);

    const messages = service.listMessages(firstPayload.conversation_id);
    assert.equal(messages.length, 4);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[2].role, "user");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint deduplicates replayed history messages by external message key", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "restore-thread-1",
          requestId: "turn-1",
        },
        messages: [
          { role: "system", content: "You are helpful.", id: "sys-1" },
          { role: "user", content: "My name is Ricky.", id: "user-1" },
        ],
      }),
    });
    assert.equal(firstResponse.status, 200);

    const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "restore-thread-1",
          requestId: "turn-2",
        },
        messages: [
          { role: "system", content: "You are helpful.", id: "sys-1" },
          { role: "user", content: "My name is Ricky.", id: "user-1" },
          { role: "assistant", content: "reply for: My name is Ricky." },
          { role: "user", content: "I prefer native Apple clients.", id: "user-2" },
        ],
      }),
    });
    const secondPayload = await secondResponse.json();

    assert.equal(secondResponse.status, 200);

    const messages = service.listMessages(secondPayload.conversation_id);
    assert.equal(messages.length, 5);
    assert.equal(messages.filter((message) => message.externalMessageKey === "sys-1").length, 1);
    assert.equal(messages.filter((message) => message.externalMessageKey === "user-1").length, 1);
    assert.equal(messages.filter((message) => message.externalMessageKey === "user-2").length, 1);
    assert.equal(messages[0].text, "You are helpful.");
    assert.equal(messages[1].text, "My name is Ricky.");
    assert.equal(messages[2].text, "reply for: My name is Ricky.");
    assert.equal(messages[3].text, "I prefer native Apple clients.");
    assert.equal(messages[4].text, "reply for: I prefer native Apple clients.");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("openai-compatible endpoint does not re-import assistant history on later turns", async () => {
  const { service, server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const firstResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "assistant-history-thread",
          requestId: "assistant-turn-1",
        },
        messages: [
          { role: "user", content: "My name is Alex.", id: "assistant-history-user-1" },
        ],
      }),
    });
    const firstPayload = await firstResponse.json();
    assert.equal(firstResponse.status, 200);

    const firstMessages = service.listMessages(firstPayload.conversation_id);
    const priorAssistant = firstMessages.at(-1);
    assert.ok(priorAssistant);

    const secondResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "assistant-history-thread",
          requestId: "assistant-turn-2",
        },
        messages: [
          { role: "user", content: "My name is Alex.", id: "assistant-history-user-1" },
          { role: "assistant", content: "reply for: My name is Alex.", id: priorAssistant.id },
          { role: "user", content: "I study in Sydney.", id: "assistant-history-user-2" },
        ],
      }),
    });
    const secondPayload = await secondResponse.json();

    assert.equal(secondResponse.status, 200);

    const messages = service.listMessages(secondPayload.conversation_id);
    assert.equal(messages.length, 4);
    assert.equal(messages[0].text, "My name is Alex.");
    assert.equal(messages[1].text, "reply for: My name is Alex.");
    assert.equal(messages[2].text, "I study in Sydney.");
    assert.equal(messages[3].text, "reply for: I study in Sydney.");
    assert.equal(messages.filter((message) => message.text === "reply for: My name is Alex.").length, 1);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("client state endpoint restores conversation messages and latest reflection by external thread key", async () => {
  const { server } = createHarness();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    const completionResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-test",
        metadata: {
          clientConversationId: "restore-thread-2",
          requestId: "restore-turn-1",
        },
        messages: [
          { role: "user", content: "I am building a memory backend.", id: "restore-user-1" },
        ],
      }),
    });
    assert.equal(completionResponse.status, 200);

    const stateResponse = await fetch(`http://127.0.0.1:${port}/v1/client/state?clientConversationId=restore-thread-2`);
    assert.equal(stateResponse.status, 200);

    const payload = await stateResponse.json();
    assert.equal(payload.conversation.title, "openai-chat");
    assert.equal(payload.messages.length, 2);
    assert.equal(payload.messages[0].externalMessageKey, "restore-user-1");
    assert.equal(payload.profileFacts.some((fact) => fact.kind === "current_focus"), true);
    assert.equal(payload.latestReflection.reflectionDate, "2026-03-10");
    assert.match(payload.latestReflection.summary, /Main themes: building, memory, backend/i);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});