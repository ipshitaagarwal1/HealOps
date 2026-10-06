import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutageSwitch, withOutageSwitch } from '../src/outage.js';

test('createOutageSwitch starts disarmed and consume is a no-op', () => {
  const sw = createOutageSwitch();
  assert.equal(sw.armed, false);
  assert.equal(sw.consume(), false);
  assert.equal(sw.armed, false);
});

test('arm() then consume() fires exactly once', () => {
  const sw = createOutageSwitch();
  sw.arm();
  assert.equal(sw.armed, true);
  assert.equal(sw.consume(), true);
  assert.equal(sw.armed, false);
  assert.equal(sw.consume(), false);
});

test('withOutageSwitch short-circuits the next call to an llm_error fallback, without calling the real diagnoser', async () => {
  const sw = createOutageSwitch();
  sw.arm();
  let realCalls = 0;
  const realDiagnose = async () => { realCalls += 1; return { diagnosis: { action: 'restart_pod', confidence: 0.9 }, attempts: 1 }; };
  const diagnose = withOutageSwitch(realDiagnose, sw);

  const result = await diagnose({ alert: {}, service: 's', retrieved: [] });
  assert.equal(realCalls, 0);
  assert.equal(result.diagnosis.action, 'escalate');
  assert.equal(result.diagnosis.confidence, 0);
  assert.equal(result.diagnosis.fallback_reason, 'llm_error');
  assert.match(result.diagnosis.reasoning, /simulated outage/);
  assert.match(result.error, /simulated outage/);
});

test('withOutageSwitch only affects the next call; later calls reach the real diagnoser', async () => {
  const sw = createOutageSwitch();
  sw.arm();
  let realCalls = 0;
  const realDiagnose = async () => { realCalls += 1; return { diagnosis: { action: 'restart_pod', confidence: 0.9 }, attempts: 1 }; };
  const diagnose = withOutageSwitch(realDiagnose, sw);

  await diagnose({});
  const second = await diagnose({});
  assert.equal(realCalls, 1);
  assert.equal(second.diagnosis.action, 'restart_pod');
});

test('withOutageSwitch is a pass-through when never armed', async () => {
  const sw = createOutageSwitch();
  const realDiagnose = async () => ({ diagnosis: { action: 'scale_up', confidence: 0.8 }, attempts: 1 });
  const diagnose = withOutageSwitch(realDiagnose, sw);
  const result = await diagnose({});
  assert.equal(result.diagnosis.action, 'scale_up');
});
