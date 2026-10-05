// One JSON object per line. Demo services have no incidents, so incident_id is null.
export function log(level, msg, fields = {}) {
  const line = {
    ts: new Date().toISOString(),
    level,
    service: process.env.SERVICE_NAME || 'demo',
    incident_id: null,
    msg,
    ...fields,
  };
  process.stdout.write(JSON.stringify(line) + '\n');
}
