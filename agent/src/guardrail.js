// Guardrail: decides whether a diagnosis may run automatically (docs/SPEC.md section 6).
// evaluateGuardrail is pure and deterministic: time and action history are arguments.
// The only I/O in this module is loadRecentActions, which reads the cooldown state.

const THRESHOLDS = { restart_pod: 'confRestart', scale_up: 'confScale' };
const HOUR_MS = 60 * 60 * 1000;

// Round to avoid floating point drift (0.95 - 0.15 = 0.7999999999999999).
const round = (n) => Math.round(n * 1e6) / 1e6;
const fmt = (n) => n.toFixed(2);
const minutesBetween = (later, earlier) => (later - earlier) / 60000;

// Returns { decision: 'execute'|'ticket', reasons: string[], effective_confidence }.
// Each reason is "<code>: <explanation>".
export function evaluateGuardrail({ diagnosis, service, retrieved, history, config, now }) {
  const action = diagnosis?.action;
  const confidence = diagnosis?.confidence;
  const ticket = (reasons, effective = 0) => ({ decision: 'ticket', reasons, effective_confidence: effective });

  // Actions that are never automated.
  if (action === 'escalate') {
    return ticket(['escalate: the diagnosis recommends human escalation']);
  }
  if (action === 'rollback_deploy') {
    return ticket(['high_risk_action: rollback_deploy is high risk and always needs human approval']);
  }
  if (!Object.hasOwn(THRESHOLDS, action)) {
    return ticket([`unknown_action: "${action}" is not an action the agent can run`]);
  }
  if (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1)) {
    return ticket([`invalid_confidence: confidence ${JSON.stringify(confidence)} is not a number between 0 and 1`]);
  }

  const reasons = [];

  // No supporting context: lower confidence before comparing to the threshold.
  let effective = confidence;
  const hasContext = (retrieved ?? []).some((r) => r.similarity >= config.ragMinSimilarity);
  if (!hasContext) {
    effective = Math.max(0, round(confidence - config.noContextPenalty));
    reasons.push(`no_context: no runbook or past incident with similarity >= ${config.ragMinSimilarity}; `
      + `confidence ${fmt(confidence)} - penalty ${fmt(config.noContextPenalty)} = ${fmt(effective)}`);
  }

  const threshold = config[THRESHOLDS[action]];
  const lowConfidence = effective < threshold;
  if (lowConfidence) {
    reasons.push(`low_confidence: ${action} needs confidence >= ${fmt(threshold)}, got ${fmt(effective)}`);
  }

  const mine = (history ?? [])
    .filter((h) => h.service === service)
    .map((h) => ({ ...h, at: new Date(h.at) }));

  // Cooldown: any automated (agent) action on this service in the last COOLDOWN_MIN.
  const cooldownMs = config.cooldownMin * 60000;
  const recent = mine
    .filter((h) => h.approved_by === 'agent' && now - h.at < cooldownMs)
    .sort((a, b) => b.at - a.at)[0];
  const cooldown = Boolean(recent);
  if (cooldown) {
    reasons.push(`cooldown_active: ${recent.action} ran on ${service} ${minutesBetween(now, recent.at).toFixed(1)} min ago `
      + `(cooldown ${config.cooldownMin} min)`);
  }

  // Circuit breaker: too many actions (agent or human) on this service in 60 minutes.
  const lastHour = mine.filter((h) => now - h.at < HOUR_MS).length;
  const breaker = lastHour >= config.maxActionsPerHour;
  if (breaker) {
    reasons.push(`too_many_actions: ${lastHour} actions on ${service} in the last 60 min `
      + `(limit ${config.maxActionsPerHour})`);
  }

  if (lowConfidence || cooldown || breaker) return ticket(reasons, effective);

  if (config.dryRun) {
    return ticket([...reasons, `dry_run: DRY_RUN is on, so ${action} was not executed`], effective);
  }
  return { decision: 'execute', reasons, effective_confidence: effective };
}

// Cooldown state for one service: its actions from the last hour (covers both windows).
export async function loadRecentActions(pool, service, now = new Date()) {
  const { rows } = await pool.query(
    `SELECT service, action, approved_by, at FROM action_history
     WHERE service = $1 AND at > $2 ORDER BY at DESC`,
    [service, new Date(now.getTime() - HOUR_MS)],
  );
  return rows;
}
