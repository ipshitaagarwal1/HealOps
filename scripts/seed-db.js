// Embed db/seed/*.json with Gemini and upsert into the knowledge table.
// Idempotent: unchanged rows are skipped (no API call). --force re-embeds everything.
//   node scripts/seed-db.js [--force]
import { join } from 'node:path';
import { ROOT, loadEnv, requireEnv } from './lib/env.js';
import { documentText, embedTexts } from './lib/gemini.js';
import { dbFromUrl, runSql, sqlText, sqlVector } from './lib/psql.js';
import { loadSeeds, planChanges } from './lib/seeds.js';

const EXISTING_SQL = `SELECT coalesce(json_agg(json_build_object(
  'kind', kind, 'title', title, 'content', content,
  'recommended_action', recommended_action, 'embedding_model', embedding_model)), '[]')
FROM knowledge;`;

function upsertSql(rows, model) {
  const values = rows.map((r) => `(${[
    sqlText(r.kind), sqlText(r.title), sqlText(r.content),
    sqlText(r.recommended_action), sqlVector(r.embedding), sqlText(model),
  ].join(', ')})`);
  return `BEGIN;
INSERT INTO knowledge (kind, title, content, recommended_action, embedding, embedding_model)
VALUES
${values.join(',\n')}
ON CONFLICT (kind, title) DO UPDATE SET
  content = EXCLUDED.content,
  recommended_action = EXCLUDED.recommended_action,
  embedding = EXCLUDED.embedding,
  embedding_model = EXCLUDED.embedding_model;
COMMIT;`;
}

async function main() {
  loadEnv();
  const env = requireEnv(['GEMINI_API_KEY', 'GEMINI_EMBED_MODEL', 'EMBED_DIM', 'DATABASE_URL']);
  const dim = Number(env.EMBED_DIM);
  const model = env.GEMINI_EMBED_MODEL;
  const db = dbFromUrl(env.DATABASE_URL);
  const force = process.argv.includes('--force');

  const seeds = loadSeeds(join(ROOT, 'db', 'seed'));
  const existing = JSON.parse(runSql(EXISTING_SQL, db));
  const { toEmbed, unchanged, extra } = planChanges(seeds, existing, model, { force });

  console.log(`seeds: ${seeds.length} | to embed: ${toEmbed.length} | unchanged: ${unchanged.length}`);
  if (toEmbed.length) {
    const started = Date.now();
    const vectors = await embedTexts(toEmbed.map(documentText), {
      apiKey: env.GEMINI_API_KEY, model, dim,
    });
    console.log(`embedded ${vectors.length} with ${model} (${dim} dims) in ${Date.now() - started}ms`);
    runSql(upsertSql(toEmbed.map((r, i) => ({ ...r, embedding: vectors[i] })), model), db);
    for (const r of toEmbed) console.log(`  ${r.isNew ? 'inserted' : 'updated '} ${r.kind}: ${r.title}`);
  }
  for (const r of extra) console.log(`  note: ${r.kind} "${r.title}" is in the DB but not in db/seed (left as is)`);

  const total = runSql('SELECT count(*) FROM knowledge;', db).trim();
  console.log(`knowledge rows: ${total}`);
}

// exitCode rather than process.exit(): exiting while fetch sockets are closing
// trips a libuv assertion on Windows.
main().catch((err) => {
  console.error(`seed failed: ${err.message}`);
  process.exitCode = 1;
});
