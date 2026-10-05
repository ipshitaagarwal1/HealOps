import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, createRetriever, embedQuery, queryText } from '../src/rag.js';
import { queryText as seedQueryText } from '../../scripts/lib/gemini.js';

const alert = {
  labels: { alertname: 'HighErrorRate', service: 'service-a', severity: 'critical', job: 'demo', team: 'payments' },
  annotations: { summary: 'service-a 5xx ratio is 100%', description: 'More than 50% failed.' },
};
const config = {
  geminiApiKey: 'k', geminiEmbedModel: 'm', embedDim: 3, embedTimeoutMs: 1000, ragMinSimilarity: 0.6,
};
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('query prefix matches the one the seed script used for documents', () => {
  assert.equal(queryText('x'), seedQueryText('x'));
});

test('buildQuery uses alertname, service, severity, annotations and extra labels', () => {
  assert.equal(buildQuery(alert),
    'HighErrorRate alert on service-a. severity critical. service-a 5xx ratio is 100%. More than 50% failed. labels: team=payments');
});

test('embedQuery sends the key as a header and checks dimensions', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return jsonResponse({ embedding: { values: [1, 2, 3] } }); };
  assert.deepEqual(await embedQuery('q', { apiKey: 'secret', model: 'm', dim: 3, timeoutMs: 100, fetchImpl }), [1, 2, 3]);
  assert.ok(!seen.url.includes('secret'));
  assert.equal(seen.init.headers['x-goog-api-key'], 'secret');
  assert.equal(JSON.parse(seen.init.body).embedContentConfig.outputDimensionality, 3);
  const wrong = async () => jsonResponse({ embedding: { values: [1] } });
  await assert.rejects(embedQuery('q', { apiKey: 'k', model: 'm', dim: 3, timeoutMs: 100, fetchImpl: wrong }), /expected 3/);
});

test('retriever keeps only results at or above the threshold', async () => {
  const pool = { query: async () => ({ rows: [
    { id: 1, title: 'a', similarity: 0.8 }, { id: 2, title: 'b', similarity: 0.6 }, { id: 3, title: 'c', similarity: 0.59 },
  ] }) };
  const fetchImpl = async () => jsonResponse({ embedding: { values: [1, 2, 3] } });
  const r = await createRetriever({ config, pool, fetchImpl })(alert);
  assert.equal(r.error, null);
  assert.equal(r.candidates.length, 3);
  assert.deepEqual(r.kept.map((k) => k.id), [1, 2]);
});

test('embedding failure returns no context with the error instead of throwing', async () => {
  const pool = { query: async () => { throw new Error('should not be called'); } };
  const fetchImpl = async () => jsonResponse({ error: { message: 'API key not valid' } }, 400);
  const r = await createRetriever({ config, pool, fetchImpl })(alert);
  assert.deepEqual(r.kept, []);
  assert.match(r.error, /HTTP 400: API key not valid/);
});

test('embedding timeout is reported as a timeout', async () => {
  const fetchImpl = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  const r = await createRetriever({ config, pool: {}, fetchImpl })(alert);
  assert.match(r.error, /timeout after 1000ms/);
});
