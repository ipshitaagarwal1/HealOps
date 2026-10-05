// Load and validate settings from the environment (docs/SPEC.md section 9).
// loadConfig is pure so it can be tested; loadConfigOrExit is the startup wrapper.

const str = (v) => (v && v.trim() ? { value: v.trim() } : { error: 'is required' });

const num = (min, max, { integer = false } = {}) => (v) => {
  if (v === undefined || v.trim() === '') return { error: 'is required' };
  const n = Number(v);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
    return { error: `must be ${integer ? 'an integer' : 'a number'}` };
  }
  if (n < min || n > max) return { error: `must be between ${min} and ${max}` };
  return { value: n };
};

const bool = (v) => {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'true') return { value: true };
  if (s === 'false') return { value: false };
  return { error: 'must be true or false' };
};

const url = (v) => {
  const s = str(v);
  if (s.error) return s;
  try {
    new URL(s.value);
    return s;
  } catch {
    return { error: 'must be a valid URL' };
  }
};

const token = (v) => {
  const s = str(v);
  if (s.error) return s;
  if (s.value === 'change-me') return { error: 'must be changed from the example value' };
  if (s.value.length < 16) return { error: 'must be at least 16 characters' };
  return s;
};

const fraction = num(0, 1);

// env var -> [config key, parser]
const SCHEMA = {
  GEMINI_API_KEY: ['geminiApiKey', str],
  GEMINI_EMBED_MODEL: ['geminiEmbedModel', str],
  EMBED_DIM: ['embedDim', num(1, 4096, { integer: true })],
  GROQ_API_KEY: ['groqApiKey', str],
  GROQ_MODEL: ['groqModel', str],
  DATABASE_URL: ['databaseUrl', url],
  ADMIN_TOKEN: ['adminToken', token],
  AGENT_PORT: ['port', num(1, 65535, { integer: true })],
  CONF_RESTART: ['confRestart', fraction],
  CONF_SCALE: ['confScale', fraction],
  COOLDOWN_MIN: ['cooldownMin', num(0, 1440)],
  MAX_ACTIONS_PER_HOUR: ['maxActionsPerHour', num(1, 1000, { integer: true })],
  NO_CONTEXT_PENALTY: ['noContextPenalty', fraction],
  RAG_MIN_SIMILARITY: ['ragMinSimilarity', fraction],
  DRY_RUN: ['dryRun', bool],
  LLM_TIMEOUT_MS: ['llmTimeoutMs', num(100, 120000, { integer: true })],
  ACTION_TIMEOUT_MS: ['actionTimeoutMs', num(100, 120000, { integer: true })],
};

// Returns { config, errors }. Error messages name the variable, never its value.
export function loadConfig(env) {
  const config = { logLevel: (env.LOG_LEVEL || 'info').toLowerCase() };
  const errors = [];
  // Optional: the query embedding is a small call, so it gets a shorter default timeout.
  const embedTimeout = num(100, 120000, { integer: true })(env.EMBED_TIMEOUT_MS || '5000');
  if (embedTimeout.error) errors.push(`EMBED_TIMEOUT_MS ${embedTimeout.error}`);
  else config.embedTimeoutMs = embedTimeout.value;
  for (const [name, [key, parse]] of Object.entries(SCHEMA)) {
    const { value, error } = parse(env[name]);
    if (error) errors.push(`${name} ${error}`);
    else config[key] = value;
  }
  return { config: Object.freeze(config), errors };
}

export function loadConfigOrExit(env = process.env) {
  const { config, errors } = loadConfig(env);
  if (errors.length) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(), level: 'error', incident_id: null,
      msg: 'invalid configuration, check .env', errors,
    }));
    process.exit(1);
  }
  return config;
}

// Safe to log: secrets removed.
export function redact(config) {
  const { geminiApiKey, groqApiKey, adminToken, databaseUrl, ...rest } = config;
  return rest;
}
