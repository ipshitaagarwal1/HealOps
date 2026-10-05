// Debug helper: show which knowledge rows a query retrieves, the same way the agent will.
//   node scripts/query-knowledge.js "memory leak high error rate" [limit]
import { loadEnv, requireEnv } from './lib/env.js';
import { embedTexts, queryText } from './lib/gemini.js';
import { dbFromUrl, runSql, sqlVector } from './lib/psql.js';

async function main() {
  const [text, limitArg = '5'] = process.argv.slice(2);
  const limit = Number(limitArg);
  if (!text || !Number.isInteger(limit) || limit < 1) {
    console.error('usage: node scripts/query-knowledge.js "<query text>" [limit]');
    process.exit(2);
  }
  loadEnv();
  const env = requireEnv(['GEMINI_API_KEY', 'GEMINI_EMBED_MODEL', 'EMBED_DIM', 'DATABASE_URL']);
  const [vector] = await embedTexts([queryText(text)], {
    apiKey: env.GEMINI_API_KEY, model: env.GEMINI_EMBED_MODEL, dim: Number(env.EMBED_DIM),
  });
  const vec = sqlVector(vector);
  // <=> is cosine distance; similarity = 1 - distance.
  const rows = runSql(`SELECT kind, round((1 - (embedding <=> ${vec}))::numeric, 4), title,
  coalesce(recommended_action, '-')
FROM knowledge ORDER BY embedding <=> ${vec} LIMIT ${limit};`, dbFromUrl(env.DATABASE_URL));

  console.log(`query: "${text}"`);
  rows.trim().split('\n').forEach((line, i) => {
    const [kind, sim, title, action] = line.split('|');
    console.log(`${i + 1}. ${sim}  ${kind.padEnd(8)} ${action.padEnd(15)} ${title}`);
  });
}

// exitCode rather than process.exit(): see seed-db.js.
main().catch((err) => {
  console.error(`query failed: ${err.message}`);
  process.exitCode = 1;
});
