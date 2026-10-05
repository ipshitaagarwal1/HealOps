// Retrieval: turn an alert into a search query, embed it with Gemini, and find the
// closest runbooks / past incidents in pgvector. Embedding failure is not fatal: the
// pipeline continues with no context (the guardrail then applies NO_CONTEXT_PENALTY).

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const TOP_K = 3;
const SKIP_LABELS = new Set(['alertname', 'service', 'severity', 'job', 'instance']);

// gemini-embedding-2 takes the task as a text prefix (docs/SPEC.md section 5.2).
// Must match scripts/lib/gemini.js, which embeds the documents.
export const queryText = (text) => `task: search result | query: ${text}`;

export function buildQuery(alert) {
  const labels = alert?.labels ?? {};
  const ann = alert?.annotations ?? {};
  const extra = Object.entries(labels)
    .filter(([k]) => !SKIP_LABELS.has(k))
    .map(([k, v]) => `${k}=${v}`);
  return [
    `${labels.alertname} alert on ${labels.service}`,
    labels.severity && `severity ${labels.severity}`,
    ann.summary,
    ann.description,
    extra.length && `labels: ${extra.join(', ')}`,
  ].filter(Boolean).map((s) => String(s).trim().replace(/[.\s]+$/, '')).join('. ');
}

export async function embedQuery(text, { apiKey, model, dim, timeoutMs, fetchImpl = fetch }) {
  let res;
  try {
    res = await fetchImpl(`${GEMINI_BASE}/models/${model}:embedContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        content: { parts: [{ text: queryText(text) }] },
        embedContentConfig: { outputDimensionality: dim },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(err.name === 'TimeoutError' ? `embedding timeout after ${timeoutMs}ms` : `embedding request failed: ${err.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`embedding HTTP ${res.status}: ${json.error?.message ?? 'no message'}`);
  const values = json.embedding?.values;
  if (!Array.isArray(values) || values.length !== dim || !values.every(Number.isFinite)) {
    throw new Error(`embedding has ${values?.length ?? 0} values, expected ${dim}`);
  }
  return values;
}

const SEARCH_SQL = `
SELECT id, kind, title, content, recommended_action,
       1 - (embedding <=> $1::vector) AS similarity
FROM knowledge
ORDER BY embedding <=> $1::vector
LIMIT $2`;

export async function searchKnowledge(pool, vector, limit = TOP_K) {
  const { rows } = await pool.query(SEARCH_SQL, [`[${vector.join(',')}]`, limit]);
  return rows.map((r) => ({ ...r, similarity: Number(Number(r.similarity).toFixed(4)) }));
}

// Returns { query, candidates, kept, error }. kept = candidates at or above the threshold.
export function createRetriever({ config, pool, fetchImpl = fetch }) {
  return async function retrieve(alert) {
    const query = buildQuery(alert);
    let vector;
    try {
      vector = await embedQuery(query, {
        apiKey: config.geminiApiKey, model: config.geminiEmbedModel, dim: config.embedDim,
        timeoutMs: config.embedTimeoutMs, fetchImpl,
      });
    } catch (err) {
      return { query, candidates: [], kept: [], error: err.message };
    }
    const candidates = await searchKnowledge(pool, vector);
    const kept = candidates.filter((c) => c.similarity >= config.ragMinSimilarity);
    return { query, candidates, kept, error: null };
  };
}
