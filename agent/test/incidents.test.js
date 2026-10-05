import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdate } from '../src/incidents.js';

test('jsonb columns are stringified (arrays must not become Postgres arrays)', () => {
  const { text, values } = buildUpdate('id1', { retrieved: [{ id: 1 }] });
  assert.equal(text, 'UPDATE incidents SET retrieved = $2 WHERE id = $1');
  assert.deepEqual(values, ['id1', '[{"id":1}]']);
});

test('status update never overwrites a resolved incident', () => {
  const { text } = buildUpdate('id1', { status: 'diagnosed' });
  assert.match(text, /status = CASE WHEN resolved_at IS NULL THEN \$2 ELSE status END/);
});

test('unknown or empty columns are rejected', () => {
  assert.throws(() => buildUpdate('id1', { fingerprint: 'x' }), /fingerprint/);
  assert.throws(() => buildUpdate('id1', {}));
});
