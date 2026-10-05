-- Runs once, when the Postgres volume is first created (docker-entrypoint-initdb.d).
-- To re-run: docker compose down -v (deletes all data).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE knowledge (            -- runbooks + past incident reports
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('runbook','incident')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  recommended_action TEXT,
  embedding vector(768) NOT NULL,
  embedding_model TEXT,             -- which model made the vector; a change forces re-embed
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (kind, title)              -- lets scripts/seed-db.js upsert idempotently
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
CREATE INDEX ON incidents (fingerprint);
CREATE INDEX ON incidents (received_at DESC);

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
CREATE INDEX ON audit_log (incident_id);

CREATE TABLE action_history (       -- used for cooldown + circuit breaker
  id SERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  action TEXT NOT NULL,
  approved_by TEXT DEFAULT 'agent', -- agent|human
  at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON action_history (service, at DESC);
