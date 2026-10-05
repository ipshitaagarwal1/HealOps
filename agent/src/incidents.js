// SQL for the incidents table. "Open" means resolved_at IS NULL: an incident stays open
// through diagnosed/ticketed/acted until Alertmanager says the alert resolved.

// The partial unique index incidents_open_fingerprint_uniq makes dedupe atomic, even if
// two deliveries of the same alert are processed at the same time.
const INSERT_SQL = `
INSERT INTO incidents (id, fingerprint, service, alertname, status, alert_payload, fired_at)
VALUES ($1, $2, $3, $4, 'received', $5, $6)
ON CONFLICT (fingerprint) WHERE resolved_at IS NULL DO NOTHING
RETURNING id`;

const FIND_OPEN_SQL = `
SELECT id FROM incidents WHERE fingerprint = $1 AND resolved_at IS NULL LIMIT 1`;

const RESOLVE_SQL = `
UPDATE incidents SET status = 'resolved', resolved_at = $2
WHERE fingerprint = $1 AND resolved_at IS NULL
RETURNING id, fired_at`;

const UPDATABLE = ['retrieved', 'diagnosis', 'guardrail', 'action_result', 'status', 'decided_at', 'acted_at'];
const JSON_COLUMNS = new Set(['retrieved', 'diagnosis', 'guardrail', 'action_result']);

// Builds the UPDATE for a whitelisted set of columns. A status change never overwrites
// 'resolved': the alert may clear while the pipeline is still running.
export function buildUpdate(id, fields) {
  const cols = Object.keys(fields);
  const unknown = cols.filter((c) => !UPDATABLE.includes(c));
  if (unknown.length || !cols.length) throw new Error(`bad incident update columns: ${unknown.join(',') || 'none'}`);
  const sets = cols.map((c, i) => (c === 'status'
    ? `status = CASE WHEN resolved_at IS NULL THEN $${i + 2} ELSE status END`
    : `${c} = $${i + 2}`));
  const values = cols.map((c) => (JSON_COLUMNS.has(c) ? JSON.stringify(fields[c]) : fields[c]));
  return { text: `UPDATE incidents SET ${sets.join(', ')} WHERE id = $1`, values: [id, ...values] };
}

export function createIncidentStore(pool) {
  return {
    // Returns { created: true, id } or { created: false, id: <open incident id> }.
    async createIfNotOpen({ id, fingerprint, service, alertname, payload, firedAt }) {
      const params = [id, fingerprint, service, alertname, JSON.stringify(payload), firedAt];
      const { rows } = await pool.query(INSERT_SQL, params);
      if (rows.length) return { created: true, id: rows[0].id };
      const open = await pool.query(FIND_OPEN_SQL, [fingerprint]);
      return { created: false, id: open.rows[0]?.id ?? null };
    },

    async update(id, fields) {
      const { text, values } = buildUpdate(id, fields);
      await pool.query(text, values);
    },

    // Returns { id, firedAt } of the incident it resolved, or null if none was open.
    async resolveOpen({ fingerprint, resolvedAt }) {
      const { rows } = await pool.query(RESOLVE_SQL, [fingerprint, resolvedAt]);
      return rows[0] ? { id: rows[0].id, firedAt: rows[0].fired_at } : null;
    },
  };
}
