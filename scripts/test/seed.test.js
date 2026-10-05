import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ROOT } from '../lib/env.js';
import { documentText, parseEmbeddings, queryText } from '../lib/gemini.js';
import { sqlText, sqlVector } from '../lib/psql.js';
import { loadSeeds, planChanges, seedErrors } from '../lib/seeds.js';

const seed = (over = {}) => ({
  kind: 'runbook', title: 'T', content: 'C', recommended_action: 'restart_pod', ...over,
});

test('repo seed files are valid and cover every action', () => {
  const seeds = loadSeeds(join(ROOT, 'db', 'seed'));
  assert.ok(seeds.length >= 8, `need at least 8 seeds, got ${seeds.length}`);
  const actions = new Set(seeds.map((s) => s.recommended_action));
  for (const a of ['restart_pod', 'scale_up', 'rollback_deploy', 'escalate']) assert.ok(actions.has(a), a);
});

test('seedErrors rejects bad kind, empty fields and unknown action', () => {
  assert.deepEqual(seedErrors(seed()), []);
  assert.equal(seedErrors(seed({ recommended_action: null })).length, 0);
  assert.equal(seedErrors(seed({ kind: 'note' })).length, 1);
  assert.equal(seedErrors(seed({ title: ' ' })).length, 1);
  assert.equal(seedErrors(seed({ recommended_action: 'delete_db' })).length, 1);
});

test('planChanges skips unchanged rows and re-embeds on text, action or model change', () => {
  const stored = [{ ...seed(), embedding_model: 'm1' }];
  assert.equal(planChanges([seed()], stored, 'm1').unchanged.length, 1);
  assert.equal(planChanges([seed({ content: 'new' })], stored, 'm1').toEmbed.length, 1);
  assert.equal(planChanges([seed({ recommended_action: 'escalate' })], stored, 'm1').toEmbed.length, 1);
  assert.equal(planChanges([seed()], stored, 'm2').toEmbed.length, 1);
  assert.equal(planChanges([seed()], stored, 'm1', { force: true }).toEmbed.length, 1);
  const fresh = planChanges([seed({ title: 'Other' })], stored, 'm1');
  assert.equal(fresh.toEmbed[0].isNew, true);
  assert.equal(fresh.extra.length, 1);
});

test('task prefixes match the gemini-embedding-2 retrieval format', () => {
  assert.equal(queryText('x'), 'task: search result | query: x');
  assert.equal(documentText(seed()), 'title: T | text: C Recommended action: restart_pod.');
  assert.equal(documentText(seed({ recommended_action: null })), 'title: T | text: C');
});

test('parseEmbeddings checks count and dimensions', () => {
  const ok = { embeddings: [{ values: [0.1, 0.2] }] };
  assert.deepEqual(parseEmbeddings(ok, 1, 2), [[0.1, 0.2]]);
  assert.throws(() => parseEmbeddings(ok, 2, 2), /expected 2/);
  assert.throws(() => parseEmbeddings(ok, 1, 3), /expected 3/);
  assert.throws(() => parseEmbeddings({}, 1, 2));
});

test('sqlText escapes quotes and rejects NUL; sqlVector rejects non-finite', () => {
  assert.equal(sqlText("it's"), "'it''s'");
  assert.equal(sqlText(null), 'NULL');
  assert.throws(() => sqlText('a\0b'));
  assert.equal(sqlVector([1, 0.5]), "'[1,0.5]'::vector");
  assert.throws(() => sqlVector([1, NaN]));
});
