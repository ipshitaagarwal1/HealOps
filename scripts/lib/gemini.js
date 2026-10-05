// Gemini embeddings over REST. gemini-embedding-2 has no task_type parameter;
// the task goes in the text itself (see docs/SPEC.md section 5.2).

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MAX_BATCH = 100;

export function documentText({ title, content, recommended_action: action }) {
  const suffix = action ? ` Recommended action: ${action}.` : '';
  return `title: ${title} | text: ${content}${suffix}`;
}

export function queryText(text) {
  return `task: search result | query: ${text}`;
}

// Embed many texts. Returns an array of number[] in input order.
// Throws an Error with the HTTP status and Google's message; the key is never included.
export async function embedTexts(texts, { apiKey, model, dim, timeoutMs = 15000 }) {
  const out = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    out.push(...(await embedBatch(texts.slice(i, i + MAX_BATCH), { apiKey, model, dim, timeoutMs })));
  }
  return out;
}

async function embedBatch(texts, { apiKey, model, dim, timeoutMs }) {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${model}`,
      content: { parts: [{ text }] },
      embedContentConfig: { outputDimensionality: dim },
    })),
  };
  let res;
  try {
    res = await fetch(`${BASE}/models/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Gemini request failed: ${err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : err.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Gemini HTTP ${res.status}: ${json.error?.message ?? 'no error message'}`);
  }
  return parseEmbeddings(json, texts.length, dim);
}

export function parseEmbeddings(json, count, dim) {
  const embeddings = json?.embeddings;
  if (!Array.isArray(embeddings) || embeddings.length !== count) {
    throw new Error(`Gemini returned ${embeddings?.length ?? 0} embeddings, expected ${count}`);
  }
  return embeddings.map((e, i) => {
    const values = e?.values;
    if (!Array.isArray(values) || values.length !== dim || !values.every(Number.isFinite)) {
      throw new Error(`embedding ${i} has ${values?.length ?? 0} values, expected ${dim} numbers`);
    }
    return values;
  });
}
