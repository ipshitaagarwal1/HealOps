// Act: run a remediation against a demo service. Every attempt is recorded in
// action_history (cooldown + circuit breaker input) before the call is made, so a
// call that times out but still restarted the service is counted.
// Targets come from an allowlist, never from the alert's labels directly.
// actions.k8s.reference.js shows the equivalent Kubernetes calls.

const MAX_REPLICAS = 10;

const RECORD_SQL = 'INSERT INTO action_history (service, action, approved_by) VALUES ($1, $2, $3)';

class ActionError extends Error {}

export function createActor({ config, pool, fetchImpl = fetch }) {
  const timeoutMs = config.actionTimeoutMs;

  async function call(baseUrl, method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-admin-token': config.adminToken },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ActionError(err.name === 'TimeoutError' ? `${method} ${path} timed out after ${timeoutMs}ms` : `${method} ${path} failed: ${err.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ActionError(`${method} ${path} returned HTTP ${res.status}`);
    return json;
  }

  const handlers = {
    restart_pod: (baseUrl) => call(baseUrl, 'POST', '/admin/restart'),
    async scale_up(baseUrl) {
      const state = await call(baseUrl, 'GET', '/admin/state');
      const replicas = Math.min(MAX_REPLICAS, (Number(state.replicas) || 1) + 1);
      return call(baseUrl, 'POST', '/admin/scale', { replicas });
    },
    // Demo services have no releases, so rollback is simulated (recorded and logged).
    rollback_deploy: async () => ({ simulated: true, note: 'rollback simulated: no real deploy history' }),
  };

  // Returns a result object; never throws for an action failure.
  return async function execute({ action, service, approvedBy }) {
    const started = Date.now();
    const result = { action, service, approved_by: approvedBy };
    const fail = (error) => ({ ...result, ok: false, error, duration_ms: Date.now() - started });

    if (!Object.hasOwn(handlers, action)) return fail(`unsupported action "${action}"`);
    // Defense in depth: the guardrail already tickets rollbacks, but act refuses too.
    if (action === 'rollback_deploy' && approvedBy !== 'human') return fail('rollback_deploy requires human approval');
    const baseUrl = config.actionTargets[service];
    if (!baseUrl) return fail(`service "${service}" is not in ACTION_TARGETS`);

    await pool.query(RECORD_SQL, [service, action, approvedBy]);
    try {
      const response = await handlers[action](baseUrl);
      return { ...result, ok: true, response, duration_ms: Date.now() - started };
    } catch (err) {
      if (err instanceof ActionError) return fail(err.message);
      throw err;
    }
  };
}
