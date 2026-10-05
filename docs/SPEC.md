# Specification

## 1. Flow
```
service-a/b --/metrics--> Prometheus --rule fires--> Alertmanager --webhook--> agent
agent: receive -> dedupe -> RAG retrieve -> LLM diagnose -> guardrail -> act | ticket -> audit
```

## 2. Demo services (`services/demo`)
One Express app, two containers (`SERVICE_NAME=service-a|service-b`).
- `GET /` normal endpoint. Fails with 500 at the current fault rate.
- `GET /metrics` Prometheus format via `prom-client`:
  `http_requests_total{service,status}`, `http_request_duration_seconds` histogram,
  `process_resident_memory_bytes` (default metrics).
- `GET /health` returns 200 unless the service is in `crash` mode.
- `POST /admin/fault` body `{ "mode": "error"|"latency"|"memory"|"none", "rate": 0.0-1.0 }`
  Requires header `x-admin-token`.
- `POST /admin/restart` resets fault state to `none`, clears leaked memory, returns
  `{ restarted: true, at }`. Requires `x-admin-token`. This simulates a pod restart.
- `POST /admin/scale` accepts `{ replicas }`, records it, and halves latency fault
  (simulated). Requires `x-admin-token`.
- A load generator container (or `scripts/load.sh`) hits `/` continuously so error
  rates are measurable.

## 3. Prometheus + Alertmanager
- `scrape_interval: 5s`, `evaluation_interval: 5s`.
- Alert rules (`prometheus/alert.rules.yml`):
  - `HighErrorRate`: 5xx ratio over 1m > 0.5, `for: 15s`, severity critical
  - `HighLatency`: p95 latency over 1m > 1s, `for: 30s`, severity warning
  - `HighMemory`: resident memory > 300MB, `for: 30s`, severity warning
  - Labels must include `service` so the agent knows what to act on.
- Alertmanager: `group_wait: 5s`, `group_interval: 30s`, `repeat_interval: 5m` for the
  demo, webhook receiver `http://agent:3000/webhook/alertmanager`, `send_resolved: true`.
  These are deliberately short for demos. Comment the production tradeoff in the file.

## 4. Database (`db/init.sql`)
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge (            -- runbooks + past incident reports
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runbook','incident')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  recommended_action TEXT,
  embedding vector(768) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON knowledge USING hnsw (embedding vector_cosine_ops);

CREATE TABLE incidents (
  id UUID PRIMARY KEY,
  fingerprint TEXT NOT NULL,        -- from Alertmanager, used for dedupe
  service TEXT NOT NULL,
  alertname TEXT NOT NULL,
  status TEXT NOT NULL,             -- received|diagnosed|acted|ticketed|failed|resolved
  alert_payload JSONB NOT NULL,
  retrieved JSONB,                  -- [{id,title,similarity}]
  diagnosis JSONB,                  -- LLM output
  guardrail JSONB,                  -- {decision, reasons[]}
  action_result JSONB,
  fired_at TIMESTAMPTZ,             -- alert startsAt
  received_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  acted_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ
);

CREATE TABLE tickets (
  id SERIAL PRIMARY KEY,
  incident_id UUID REFERENCES incidents(id),
  service TEXT NOT NULL,
  root_cause TEXT, evidence TEXT, recommended_action TEXT,
  confidence REAL, reason_for_escalation TEXT,
  status TEXT DEFAULT 'open',       -- open|approved|rejected
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  incident_id UUID,
  step TEXT NOT NULL,               -- webhook|retrieve|diagnose|guardrail|act|ticket|resolve|error
  detail JSONB,
  duration_ms INT,
  at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE action_history (       -- used for cooldown + circuit breaker
  id SERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  approved_by TEXT DEFAULT 'agent', -- agent|human
  at TIMESTAMPTZ DEFAULT now()
);
```
Seed at least 8 runbooks/incidents in `db/seed/*.json`, covering: memory leak →
restart, error spike after deploy → rollback (human), traffic surge latency → scale_up,
dependency outage → escalate, config error → escalate, OOM crash loop → restart then
escalate if repeated.

## 5. Agent pipeline (`agent/src`)
Modules: `server.js`, `config.js`, `db.js`, `logger.js`, `webhook.js`, `rag.js`,
`diagnose.js`, `guardrail.js`, `act.js`, `tickets.js`, `audit.js`, `metrics.js`,
`dashboard.js`, `events.js` (SSE broadcaster).

1. **Webhook** `POST /webhook/alertmanager`: respond 202 immediately, process
   asynchronously. For each alert with `status: firing`: skip if an incident with the
   same fingerprint is still open. For `status: resolved`: mark the open incident
   resolved and set `resolved_at`.
2. **Retrieve**: build a query string from alertname, service, labels, annotations.
   Embed it (Gemini, 768 dims, query task type; documents use the document task type).
   Top 3 by cosine similarity; drop results below `RAG_MIN_SIMILARITY`.
3. **Diagnose**: call Groq with a system prompt that makes the model an SRE. It must
   return JSON only:
   ```json
   { "root_cause": "string", "evidence": "string",
     "action": "restart_pod|scale_up|rollback_deploy|escalate",
     "confidence": 0.0, "reasoning": "string" }
   ```
   Validate the shape. On invalid JSON retry once, then use
   `{action:"escalate", confidence:0}` with reason `llm_invalid_output`.
   On network/auth error or timeout (`LLM_TIMEOUT_MS`) use reason `llm_error`.
   If embedding fails, continue with no context (penalty applies) and audit it.
4. **Guardrail**: section 6. Returns `{ decision: "execute"|"ticket", reasons: [] }`.
5. **Act**: `restart_pod` → `POST http://<service>:<port>/admin/restart`;
   `scale_up` → `POST /admin/scale`. Timeout `ACTION_TIMEOUT_MS`. Record in
   `action_history`. On failure, open a ticket with reason `action_failed`.
   `agent/src/actions.k8s.reference.js` shows the equivalent Kubernetes calls (delete
   pod, patch replicas, rollout undo) with `@kubernetes/client-node`. Reference only,
   not wired in.
6. **Ticket**: insert into `tickets` with diagnosis fields and guardrail reasons.
7. **Audit**: every step writes an `audit_log` row with `duration_ms` and broadcasts
   an SSE event.

## 6. Guardrail rules (each needs a unit test)
Inputs: diagnosis, service, retrieved context, recent action_history, config, now.
- `escalate` → ticket.
- `rollback_deploy` → ticket always, regardless of confidence (high risk).
- Unknown action → ticket.
- No RAG result above threshold → subtract `NO_CONTEXT_PENALTY` from confidence first.
- `restart_pod` needs confidence ≥ `CONF_RESTART`.
- `scale_up` needs confidence ≥ `CONF_SCALE`.
- Cooldown: any automated action on the same service within `COOLDOWN_MIN` minutes →
  ticket, reason `cooldown_active`.
- Circuit breaker: ≥ `MAX_ACTIONS_PER_HOUR` actions on the service in the last 60
  minutes → ticket, reason `too_many_actions`.
- `DRY_RUN=true` downgrades `execute` to `ticket` with reason `dry_run`.
Each triggered rule appends a human-readable string to `reasons`. The function is pure:
it takes `now` and history as arguments so tests are deterministic.

## 7. Latency metrics (answers "how real-time is it?")
Per incident:
- detection lag: `received_at - fired_at`
- decision time: `decided_at - received_at`
- time to action: `acted_at - fired_at`
- time to recovery: `resolved_at - fired_at`
Agent `/metrics`: `agent_stage_duration_seconds{stage}` histogram,
`agent_decisions_total{action,decision}` counter.
`GET /api/stats` returns median and p95 of each latency over the last 50 incidents.

## 8. Dashboard
`GET /` on the agent serves one static HTML page (no build step). Live feed via
Server-Sent Events from `GET /events`. Shows: live pipeline steps, open tickets with
Approve / Reject buttons, last 20 incidents, latency stats.
API: `GET /api/incidents`, `GET /api/incidents/:id` (with audit trail),
`GET /api/tickets`, `POST /api/tickets/:id/approve` (runs the recommended action via
`act.js`, logged `approved_by=human`; rollback is simulated and logged),
`POST /api/tickets/:id/reject`, `GET /api/stats`.
Mutating endpoints require `x-admin-token`.

## 9. Config
All values in `.env` (see `.env.example`). Validate on startup; exit with a clear
message if a required key is missing.

## 10. Out of scope
Real Kubernetes cluster, user accounts, multi-tenancy, model fine-tuning.
