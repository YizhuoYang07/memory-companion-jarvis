/**
 * Embedding utilities: compute embeddings via OpenAI-compatible API
 * and calculate cosine similarity between vectors.
 */

/**
 * Compute embeddings for one or more texts.
 *
 * @param {object} config - { embeddingBaseUrl, embeddingApiKey, embeddingModel }
 * @param {string|string[]} input - Text(s) to embed
 * @returns {Promise<number[][]>} Array of embedding vectors, in input order
 */
export async function computeEmbeddings(config, input) {
  const texts = Array.isArray(input) ? input : [input];

  const response = await fetch(
    `${config.embeddingBaseUrl.replace(/\/$/, "")}/embeddings`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.embeddingApiKey}`,
      },
      body: JSON.stringify({
        model: config.embeddingModel,
        input: texts,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${body}`);
  }

  const payload = await response.json();
  // OpenAI format: { data: [{ embedding: [...], index: N }, ...] }
  return payload.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

/**
 * Cosine similarity between two equal-length vectors.
 * Returns 0 if either vector has zero magnitude.
 *
 * @param {ArrayLike<number>} vecA
 * @param {ArrayLike<number>} vecB
 * @returns {number} similarity in [-1, 1]
 */
export function cosineSimilarity(vecA, vecB) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
