import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUserMessage, createDiagnoser, parseDiagnosis } from '../src/diagnose.js';

const config = { groqApiKey: 'secret', groqModel: 'llama', llmTimeoutMs: 1000 };
const alert = { labels: { alertname: 'HighMemory', severity: 'warning' }, annotations: { summary: 'RSS 400MB' } };
const good = { root_cause: 'leak', evidence: 'RSS rising', action: 'restart_pod', confidence: 0.9, reasoning: 'runbook 1' };

const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const errorReply = (status, error) => new Response(JSON.stringify({ error }), { status });

// fetch stub that returns the queued responses in order and records the calls.
function stub(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init: { ...init, body: JSON.parse(init.body) } });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}
const run = (fetchImpl) => createDiagnoser({ config, fetchImpl })({ alert, service: 'service-a', retrieved: [] });

test('parseDiagnosis accepts the documented shape', () => {
  assert.deepEqual(parseDiagnosis(JSON.stringify(good)), { ok: true, value: good });
  assert.equal(parseDiagnosis('```json\n' + JSON.stringify(good) + '\n```').ok, true);
});

test('parseDiagnosis rejects bad JSON, missing keys and out-of-range confidence', () => {
  assert.equal(parseDiagnosis('not json').error, 'not valid JSON');
  assert.equal(parseDiagnosis('[1]').ok, false);
  assert.equal(parseDiagnosis(JSON.stringify({ ...good, evidence: undefined })).ok, false);
  assert.equal(parseDiagnosis(JSON.stringify({ ...good, confidence: 1.2 })).ok, false);
  assert.equal(parseDiagnosis(JSON.stringify({ ...good, confidence: '0.9' })).ok, false);
  assert.equal(parseDiagnosis(JSON.stringify({ ...good, action: ' ' })).ok, false);
});

test('unknown action passes shape check (the guardrail rejects it)', () => {
  assert.equal(parseDiagnosis(JSON.stringify({ ...good, action: 'delete_cluster' })).ok, true);
});

test('valid first reply: one call, bearer auth, JSON mode, model from config', async () => {
  const { fetchImpl, calls } = stub(reply(JSON.stringify(good)));
  const r = await run(fetchImpl);
  assert.deepEqual(r.diagnosis, good);
  assert.equal(r.attempts, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.body.model, 'llama');
  assert.deepEqual(calls[0].init.body.response_format, { type: 'json_object' });
});

test('invalid then valid: retries once and succeeds', async () => {
  const { fetchImpl, calls } = stub(reply('oops'), reply(JSON.stringify(good)));
  const r = await run(fetchImpl);
  assert.equal(r.attempts, 2);
  assert.equal(r.diagnosis.action, 'restart_pod');
  assert.match(calls[1].init.body.messages.at(-1).content, /invalid \(not valid JSON\)/);
});

test('invalid twice: escalate with confidence 0 and reason llm_invalid_output', async () => {
  const { fetchImpl, calls } = stub(reply('oops'), reply('{"action":1}'));
  const r = await run(fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(r.diagnosis.action, 'escalate');
  assert.equal(r.diagnosis.confidence, 0);
  assert.equal(r.diagnosis.fallback_reason, 'llm_invalid_output');
});

test('Groq json_validate_failed counts as invalid output and is retried', async () => {
  const { fetchImpl, calls } = stub(
    errorReply(400, { code: 'json_validate_failed', message: 'bad', failed_generation: 'oops' }),
    reply(JSON.stringify(good)),
  );
  const r = await run(fetchImpl);
  assert.equal(calls.length, 2);
  assert.equal(r.diagnosis.action, 'restart_pod');
});

test('auth error: no retry, escalate with reason llm_error', async () => {
  const { fetchImpl, calls } = stub(errorReply(401, { message: 'Invalid API Key' }));
  const r = await run(fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(r.diagnosis.fallback_reason, 'llm_error');
  assert.equal(r.diagnosis.action, 'escalate');
  assert.match(r.error, /HTTP 401: Invalid API Key/);
});

test('timeout and network errors fall back to llm_error', async () => {
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  assert.match((await run(stub(timeout).fetchImpl)).error, /timeout after 1000ms/);
  const net = (await run(stub(new TypeError('fetch failed')).fetchImpl));
  assert.equal(net.diagnosis.fallback_reason, 'llm_error');
});

test('user message includes alert facts and retrieved context, or says there is none', () => {
  const none = buildUserMessage({ alert, service: 'service-a', retrieved: [] });
  assert.match(none, /service: service-a/);
  assert.match(none, /No related runbooks/);
  const some = buildUserMessage({ alert, service: 'service-a', retrieved: [
    { kind: 'runbook', title: 'Memory leak', similarity: 0.8, recommended_action: 'restart_pod', content: 'restart it' },
  ] });
  assert.match(some, /runbook "Memory leak" \(similarity 0.8, recommended action: restart_pod\)/);
});
