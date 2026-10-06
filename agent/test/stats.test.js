import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latenciesOf, percentile, summarize } from '../src/stats.js';

const at = (s) => new Date(Date.UTC(2026, 9, 6, 12, 0, 0) + s * 1000).toISOString();

test('latenciesOf computes the four SPEC section 7 latencies in seconds', () => {
  const inc = { fired_at: at(0), received_at: at(8.2), decided_at: at(11.2), acted_at: at(11.4), resolved_at: at(30) };
  assert.deepEqual(latenciesOf(inc), { detection_lag: 8.2, decision_time: 3, time_to_action: 11.4, time_to_recovery: 30 });
});

test('missing timestamps give null, not NaN or 0', () => {
  const l = latenciesOf({ fired_at: at(0), received_at: at(5), decided_at: null, acted_at: undefined, resolved_at: null });
  assert.equal(l.detection_lag, 5);
  assert.equal(l.decision_time, null);
  assert.equal(l.time_to_action, null);
  assert.equal(l.time_to_recovery, null);
});

test('percentile interpolates like Postgres percentile_cont', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 0.95), 19.05);
  assert.equal(percentile([], 0.5), null);
});

test('summarize counts each latency only where it exists', () => {
  const acted = { fired_at: at(0), received_at: at(8), decided_at: at(10), acted_at: at(11), resolved_at: at(30) };
  const ticketed = { fired_at: at(0), received_at: at(10), decided_at: at(13), acted_at: null, resolved_at: null };
  const s = summarize([acted, ticketed]);
  assert.equal(s.window, 2);
  assert.deepEqual(s.stats.detection_lag, { n: 2, median_s: 9, p95_s: 9.9 });
  assert.deepEqual(s.stats.time_to_action, { n: 1, median_s: 11, p95_s: 11 });
  assert.deepEqual(summarize([]).stats.time_to_recovery, { n: 0, median_s: null, p95_s: null });
});
