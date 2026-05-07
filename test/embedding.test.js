import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEmbeddingInput } from "../src/embedding.js";

test("embedding input is truncated before provider limits", () => {
  const input = "a".repeat(7000);
  const output = normalizeEmbeddingInput(input);

  assert.ok(output.length < input.length);
  assert.match(output, /\[truncated for embedding\]$/);
});

test("short embedding input is unchanged", () => {
  assert.equal(normalizeEmbeddingInput("hello"), "hello");
});
