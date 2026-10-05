import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, redact } from '../src/config.js';

const valid = {
  GEMINI_API_KEY: 'g-key', GEMINI_EMBED_MODEL: 'gemini-embedding-2', EMBED_DIM: '768',
  GROQ_API_KEY: 'q-key', GROQ_MODEL: 'llama-3.3-70b-versatile',
  DATABASE_URL: 'postgres://agent:agent@postgres:5432/agent',
  ADMIN_TOKEN: 'a-long-random-admin-token', AGENT_PORT: '3000',
  CONF_RESTART: '0.80', CONF_SCALE: '0.75', COOLDOWN_MIN: '10', MAX_ACTIONS_PER_HOUR: '3',
  NO_CONTEXT_PENALTY: '0.15', RAG_MIN_SIMILARITY: '0.55', DRY_RUN: 'false',
  LLM_TIMEOUT_MS: '10000', ACTION_TIMEOUT_MS: '5000',
};

test('valid env parses into typed config', () => {
  const { config, errors } = loadConfig(valid);
  assert.deepEqual(errors, []);
  assert.equal(config.port, 3000);
  assert.equal(config.confRestart, 0.8);
  assert.equal(config.dryRun, false);
  assert.equal(config.embedDim, 768);
  assert.ok(Object.isFrozen(config));
});

test('every missing key is reported by name', () => {
  const { errors } = loadConfig({ ...valid, GROQ_API_KEY: '', DATABASE_URL: undefined });
  assert.deepEqual(errors, ['GROQ_API_KEY is required', 'DATABASE_URL is required']);
});

test('bad values are rejected without echoing them', () => {
  const { errors } = loadConfig({
    ...valid, CONF_RESTART: '1.5', MAX_ACTIONS_PER_HOUR: '2.5', DRY_RUN: 'yes', AGENT_PORT: 'abc',
  });
  assert.equal(errors.length, 4);
  assert.ok(errors.every((e) => !e.includes('1.5') && !e.includes('abc')));
});

test('example or short admin token is rejected', () => {
  assert.deepEqual(loadConfig({ ...valid, ADMIN_TOKEN: 'change-me' }).errors,
    ['ADMIN_TOKEN must be changed from the example value']);
  assert.equal(loadConfig({ ...valid, ADMIN_TOKEN: 'short' }).errors.length, 1);
});

test('DRY_RUN accepts true/false in any case', () => {
  assert.equal(loadConfig({ ...valid, DRY_RUN: 'TRUE' }).config.dryRun, true);
});

test('ACTION_TARGETS defaults to the two demo services and validates custom values', () => {
  assert.deepEqual(loadConfig(valid).config.actionTargets,
    { 'service-a': 'http://service-a:8080', 'service-b': 'http://service-b:8080' });
  assert.deepEqual(loadConfig({ ...valid, ACTION_TARGETS: 'x=http://x:1/' }).config.actionTargets, { x: 'http://x:1' });
  assert.equal(loadConfig({ ...valid, ACTION_TARGETS: 'x=ftp://x' }).errors.length, 1);
  assert.equal(loadConfig({ ...valid, ACTION_TARGETS: 'nonsense' }).errors.length, 1);
});

test('redact removes secrets', () => {
  const safe = JSON.stringify(redact(loadConfig(valid).config));
  for (const secret of ['g-key', 'q-key', 'a-long-random-admin-token', 'agent:agent']) {
    assert.ok(!safe.includes(secret), secret);
  }
});
