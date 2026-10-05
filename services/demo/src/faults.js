// In-memory fault state for one demo service. Pure state + helpers, no HTTP.

export const MODES = ['error', 'latency', 'memory', 'crash', 'none'];

const BASE_LATENCY_MS = 2000;
const LEAK_CHUNK_BYTES = 10 * 1024 * 1024; // per tick at rate 1.0
const LEAK_TICK_MS = 1000;
const LEAK_CAP_BYTES = 420 * 1024 * 1024; // stay under the 512MB container limit

export function createFaults({ random = Math.random } = {}) {
  const state = {
    mode: 'none',
    rate: 0,
    latencyMs: BASE_LATENCY_MS,
    replicas: 1,
    leak: [],
    leakedBytes: 0,
  };
  let leakTimer = null;

  function stopLeak() {
    if (leakTimer) clearInterval(leakTimer);
    leakTimer = null;
  }

  function leakTick() {
    if (state.leakedBytes >= LEAK_CAP_BYTES) return;
    const size = Math.max(1024 * 1024, Math.floor(LEAK_CHUNK_BYTES * state.rate));
    // Fill with a non-zero byte so the pages are touched and count towards RSS.
    state.leak.push(Buffer.alloc(size, 1));
    state.leakedBytes += size;
  }

  function setFault(mode, rate) {
    state.mode = mode;
    state.rate = mode === 'none' ? 0 : rate;
    stopLeak();
    if (mode === 'memory') {
      leakTimer = setInterval(leakTick, LEAK_TICK_MS);
      leakTimer.unref();
    }
  }

  function restart() {
    setFault('none', 0);
    state.leak = [];
    state.leakedBytes = 0;
    state.latencyMs = BASE_LATENCY_MS;
    if (typeof globalThis.gc === 'function') globalThis.gc();
  }

  function scale(replicas) {
    state.replicas = replicas;
    state.latencyMs = Math.round(state.latencyMs / 2);
  }

  // What should GET / do right now? Returns { fail, delayMs }.
  function decide() {
    if (state.mode === 'crash') return { fail: true, delayMs: 0 };
    const hit = state.rate > 0 && random() < state.rate;
    if (state.mode === 'error' && hit) return { fail: true, delayMs: 0 };
    if (state.mode === 'latency' && hit) return { fail: false, delayMs: state.latencyMs };
    return { fail: false, delayMs: 0 };
  }

  function healthy() {
    return state.mode !== 'crash';
  }

  function snapshot() {
    const { leak, ...rest } = state;
    return { ...rest, leakChunks: leak.length };
  }

  return { setFault, restart, scale, decide, healthy, snapshot, stop: stopLeak };
}

// Validate a POST /admin/fault body. Returns { ok, mode, rate } or { ok:false, error }.
export function parseFaultBody(body) {
  const mode = body?.mode;
  if (!MODES.includes(mode)) {
    return { ok: false, error: `mode must be one of ${MODES.join('|')}` };
  }
  const rate = body.rate === undefined ? 1 : Number(body.rate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    return { ok: false, error: 'rate must be a number between 0 and 1' };
  }
  return { ok: true, mode, rate };
}

export function parseReplicas(body) {
  const replicas = Number(body?.replicas);
  if (!Number.isInteger(replicas) || replicas < 1 || replicas > 100) {
    return { ok: false, error: 'replicas must be an integer between 1 and 100' };
  }
  return { ok: true, replicas };
}
