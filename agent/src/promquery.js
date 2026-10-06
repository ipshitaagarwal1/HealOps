// Thin client for Prometheus's HTTP API. The browser never talks to Prometheus: the
// dashboard's health endpoint (health.js) calls this server-side and reshapes the result.

class PromQueryError extends Error {}

export function createPromClient({ baseUrl, fetchImpl = fetch, timeoutMs = 5000 }) {
  async function get(path, params) {
    const qs = new URLSearchParams(params);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new PromQueryError(err.name === 'TimeoutError' ? `prometheus timed out after ${timeoutMs}ms` : `prometheus unreachable: ${err.message}`);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.status !== 'success') {
      throw new PromQueryError(json?.error || `prometheus returned HTTP ${res.status}`);
    }
    return json.data.result;
  }

  return {
    // Instant query -> vector of { metric, value: [ts, value] }.
    instant: (query) => get('/api/v1/query', { query }),
    // Range query -> matrix of { metric, values: [[ts, value], ...] }.
    range: (query, start, end, step) => get('/api/v1/query_range', { query, start, end, step }),
  };
}

export { PromQueryError };
