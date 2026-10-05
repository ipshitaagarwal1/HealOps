import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFaults, parseFaultBody, parseReplicas } from '../src/faults.js';

test('none mode never fails or delays', () => {
  const f = createFaults({ random: () => 0 });
  assert.deepEqual(f.decide(), { fail: false, delayMs: 0 });
  assert.equal(f.healthy(), true);
});

test('error mode fails when random < rate', () => {
  const f = createFaults({ random: () => 0.3 });
  f.setFault('error', 0.5);
  assert.equal(f.decide().fail, true);
  f.setFault('error', 0.2);
  assert.equal(f.decide().fail, false);
});

test('latency mode delays, scale halves the delay, restart resets it', () => {
  const f = createFaults({ random: () => 0 });
  f.setFault('latency', 1);
  assert.equal(f.decide().delayMs, 2000);
  f.scale(3);
  assert.equal(f.decide().delayMs, 1000);
  assert.equal(f.snapshot().replicas, 3);
  f.restart();
  assert.equal(f.snapshot().latencyMs, 2000);
  assert.equal(f.snapshot().mode, 'none');
});

test('crash mode fails every request and reports unhealthy until restart', () => {
  const f = createFaults({ random: () => 0.99 });
  f.setFault('crash', 0);
  assert.equal(f.decide().fail, true);
  assert.equal(f.healthy(), false);
  f.restart();
  assert.equal(f.healthy(), true);
});

test('memory mode leaks and restart clears it', async () => {
  const f = createFaults();
  f.setFault('memory', 0.1);
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(f.snapshot().leakedBytes > 0);
  f.restart();
  assert.equal(f.snapshot().leakedBytes, 0);
  assert.equal(f.snapshot().leakChunks, 0);
  f.stop();
});

test('parseFaultBody validates mode and rate', () => {
  assert.deepEqual(parseFaultBody({ mode: 'error' }), { ok: true, mode: 'error', rate: 1 });
  assert.equal(parseFaultBody({ mode: 'boom' }).ok, false);
  assert.equal(parseFaultBody({ mode: 'error', rate: 2 }).ok, false);
  assert.equal(parseFaultBody({ mode: 'error', rate: 'x' }).ok, false);
  assert.equal(parseFaultBody(undefined).ok, false);
});

test('parseReplicas validates', () => {
  assert.equal(parseReplicas({ replicas: 3 }).ok, true);
  assert.equal(parseReplicas({ replicas: 0 }).ok, false);
  assert.equal(parseReplicas({ replicas: 1.5 }).ok, false);
});
