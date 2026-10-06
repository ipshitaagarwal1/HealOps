import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPromClient } from '../src/promquery.js';

const jsonResponse = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body,
});

test('instant query returns the result vector on success', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return jsonResponse({ status: 'success', data: { result: [{ metric: {}, value: [1, '0.5'] }] } });
  };
  const prom = createPromClient({ baseUrl: 'http://prom:9090', fetchImpl });
  const result = await prom.instant('up');
  assert.equal(result[0].value[1], '0.5');
  assert.match(calls[0], /^http:\/\/prom:9090\/api\/v1\/query\?query=up$/);
});

test('range query hits query_range with start, end, step', async () => {
  let seenUrl;
  const fetchImpl = async (url) => { seenUrl = url; return jsonResponse({ status: 'success', data: { result: [] } }); };
  const prom = createPromClient({ baseUrl: 'http://prom:9090', fetchImpl });
  await prom.range('up', 100, 200, 15);
  assert.match(seenUrl, /\/api\/v1\/query_range\?/);
  assert.match(seenUrl, /start=100/);
  assert.match(seenUrl, /end=200/);
  assert.match(seenUrl, /step=15/);
});

test('throws when prometheus reports an error status', async () => {
  const fetchImpl = async () => jsonResponse({ status: 'error', error: 'bad query' });
  const prom = createPromClient({ baseUrl: 'http://prom:9090', fetchImpl });
  await assert.rejects(prom.instant('up'), /bad query/);
});

test('throws when prometheus is unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const prom = createPromClient({ baseUrl: 'http://prom:9090', fetchImpl });
  await assert.rejects(prom.instant('up'), /unreachable/);
});
