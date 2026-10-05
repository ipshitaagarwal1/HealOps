import pg from 'pg';

// Every query has a timeout so a stuck database can't hang the pipeline.
export function createPool(databaseUrl, logger) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    query_timeout: 10000,
    statement_timeout: 10000,
  });
  // An idle client losing its connection must not crash the process.
  pool.on('error', (err) => logger.error('postgres idle client error', { err }));
  return pool;
}

export async function pingDb(pool) {
  await pool.query('SELECT 1');
}
