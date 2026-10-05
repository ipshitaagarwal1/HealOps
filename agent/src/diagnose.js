// Diagnosis: ask the LLM (Groq, OpenAI-compatible API) for a JSON verdict.
// Invalid JSON/shape -> retry once -> fallback "llm_invalid_output".
// Network, auth, HTTP error or timeout -> fallback "llm_error". Never throws.

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_CONTEXT_CHARS = 1500;

export const SYSTEM_PROMPT = `You are a senior site reliability engineer on call for a set of microservices.
You receive one firing Prometheus alert and up to three related runbooks or past incident reports.
Decide the most likely root cause and ONE remediation action.

Actions:
- restart_pod: restart the service. Fixes leaks and bad in-process state. Does not fix bad code, bad config, or broken dependencies.
- scale_up: add replicas. Fixes overload from high traffic.
- rollback_deploy: return to the previous release. Only when there is evidence a recent deploy caused it.
- escalate: hand to a human. Use when the cause is outside the service (dependency, config), unclear, or the context does not support an automated fix.

Rules:
- Base the decision on the alert and the provided context. Do not invent facts that are not given.
- confidence is your probability (0.0 to 1.0) that the chosen action fixes the problem. Lower it when the context is weak or does not match the alert.
- Reply with ONLY a JSON object, no markdown, with exactly these keys:
{"root_cause": string, "evidence": string, "action": "restart_pod"|"scale_up"|"rollback_deploy"|"escalate", "confidence": number, "reasoning": string}`;

export function buildUserMessage({ alert, service, retrieved }) {
  const labels = alert?.labels ?? {};
  const ann = alert?.annotations ?? {};
  const context = retrieved.length
    ? retrieved.map((r, i) => [
      `[${i + 1}] ${r.kind} "${r.title}" (similarity ${r.similarity}, recommended action: ${r.recommended_action ?? 'none'})`,
      r.content.slice(0, MAX_CONTEXT_CHARS),
    ].join('\n')).join('\n\n')
    : 'No related runbooks or past incidents were found.';
  return [
    'ALERT',
    `alertname: ${labels.alertname}`,
    `service: ${service}`,
    `severity: ${labels.severity ?? 'unknown'}`,
    `started: ${alert?.startsAt ?? 'unknown'}`,
    `summary: ${ann.summary ?? '-'}`,
    `description: ${ann.description ?? '-'}`,
    'No deploy or config change history is available for this service.',
    '',
    'CONTEXT',
    context,
  ].join('\n');
}

const stripFences = (s) => s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

// Shape check only. Whether the action is allowed is the guardrail's job, so an
// unknown action string passes here and is turned into a ticket there.
export function parseDiagnosis(text) {
  let obj;
  try {
    obj = JSON.parse(stripFences(String(text ?? '')));
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not a JSON object' };
  for (const key of ['root_cause', 'evidence', 'action', 'reasoning']) {
    if (typeof obj[key] !== 'string') return { ok: false, error: `${key} must be a string` };
  }
  if (!obj.action.trim()) return { ok: false, error: 'action is empty' };
  if (typeof obj.confidence !== 'number' || !(obj.confidence >= 0 && obj.confidence <= 1)) {
    return { ok: false, error: 'confidence must be a number between 0 and 1' };
  }
  const { root_cause, evidence, action, confidence, reasoning } = obj;
  return { ok: true, value: { root_cause, evidence, action: action.trim(), confidence, reasoning } };
}

export function fallbackDiagnosis(reason, detail) {
  return {
    root_cause: 'unknown: automated diagnosis unavailable',
    evidence: '',
    action: 'escalate',
    confidence: 0,
    reasoning: `${reason}: ${detail}`,
    fallback_reason: reason,
  };
}

class LlmError extends Error {}

async function callGroq(messages, { apiKey, model, timeoutMs, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        // Reasoning models (gpt-oss) count reasoning tokens here too; a typical
        // diagnosis uses ~350, so 2000 leaves room without risking a cut-off JSON.
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LlmError(err.name === 'TimeoutError' ? `timeout after ${timeoutMs}ms` : `request failed: ${err.message}`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Groq rejects unparseable JSON-mode output with 400 json_validate_failed: that is an
    // invalid-output case (retryable), not a transport error.
    if (json.error?.code === 'json_validate_failed') return { content: json.error.failed_generation ?? '' };
    throw new LlmError(`HTTP ${res.status}: ${json.error?.message ?? 'no message'}`);
  }
  return { content: json.choices?.[0]?.message?.content ?? '', usage: json.usage };
}

// Returns { diagnosis, attempts, error? }. diagnosis.fallback_reason is set on fallback.
export function createDiagnoser({ config, fetchImpl = fetch }) {
  const opts = { apiKey: config.groqApiKey, model: config.groqModel, timeoutMs: config.llmTimeoutMs, fetchImpl };

  return async function diagnose({ alert, service, retrieved }) {
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage({ alert, service, retrieved }) },
    ];
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let reply;
      try {
        reply = await callGroq(messages, opts);
      } catch (err) {
        return { diagnosis: fallbackDiagnosis('llm_error', err.message), attempts: attempt, error: err.message };
      }
      const parsed = parseDiagnosis(reply.content);
      if (parsed.ok) return { diagnosis: parsed.value, attempts: attempt, usage: reply.usage };
      lastError = parsed.error;
      messages.push(
        { role: 'assistant', content: reply.content },
        { role: 'user', content: `That reply was invalid (${parsed.error}). Reply with only the JSON object described.` },
      );
    }
    return { diagnosis: fallbackDiagnosis('llm_invalid_output', lastError), attempts: 2, error: lastError };
  };
}
