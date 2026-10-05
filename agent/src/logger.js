// Structured JSON logs: one object per line, incident_id on every line (null if none).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(base = {}, { level = 'info', write = (s) => process.stdout.write(s) } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const bound = { incident_id: null, ...base };

  function emit(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < min) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...bound, ...fields };
    if (fields.err instanceof Error) line.err = { message: fields.err.message, name: fields.err.name };
    write(JSON.stringify(line) + '\n');
  }

  return {
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    child: (fields) => createLogger({ ...bound, ...fields }, { level, write }),
  };
}
