# Self-Healing Microservices Agent

## What this project is
An event-driven, near-real-time incident response agent. Prometheus watches two demo
services. When an alert fires, Alertmanager sends a webhook to a Node.js agent. The agent
retrieves similar past incidents (RAG over Postgres + pgvector), asks an LLM to diagnose
the problem, runs the result through a guardrail layer, and then either auto-remediates
or opens a ticket for a human. Every step is written to an audit trail.

The guardrail layer is the core of the project. It matters more than the LLM call.

Full spec: `docs/SPEC.md`. Build order: `docs/BUILD_PLAN.md`. Read both before writing code.

## Tech stack (do not swap without asking)
- Node.js 20+, plain JavaScript (ES modules), Express
- Postgres 16 + pgvector extension
- Prometheus + Alertmanager
- Embeddings: Google Gemini embedding API (768-dim output)
- Diagnosis LLM: Groq (Llama model), OpenAI-compatible chat completions API
- Docker Compose for everything
- Tests: Node built-in test runner (`node --test`)

## Repo layout
```
agent/            Node.js agent (webhook, rag, diagnose, guardrail, act, audit, dashboard)
services/demo/    One Express app, run twice as service-a and service-b
prometheus/       prometheus.yml, alert.rules.yml
alertmanager/     alertmanager.yml
db/               init.sql (schema), seed/ (runbooks + past incidents as JSON)
scripts/          inject-fault.sh, seed-db.js, demo.sh
docs/             SPEC.md, BUILD_PLAN.md
```

## Commands
- `docker compose up -d --build`   start everything
- `docker compose logs -f agent`   watch the agent
- `npm test --prefix agent`        unit tests
- `node scripts/seed-db.js`        embed + load runbooks (idempotent; `--force` re-embeds)
- `node scripts/query-knowledge.js "text"`   show what RAG retrieves for a query
- `npm test --prefix scripts`      seed/script unit tests
- `./scripts/inject-fault.sh service-a error`   break a service on purpose

## Rules for working in this repo
- Build one phase from BUILD_PLAN.md at a time. Stop at the end of each phase, run its
  verification steps, and report results before starting the next.
- External model names and API formats change. Before writing any Gemini or Groq call,
  check the current official docs for the model ID, endpoint, and auth header. Put model
  names in `.env`, never hardcode them.
- Never commit `.env` or API keys.
- All external calls (Gemini, Groq, service endpoints) need a timeout and a handled
  failure path. If the LLM fails, the agent must escalate to a ticket, never crash and
  never act.
- The guardrail is pure, deterministic code with no I/O except reading cooldown state.
  It must have unit tests covering every rule in SPEC.md section 6.
- Log structured JSON (one object per line) with an `incident_id` on every line.
- Keep functions small. No framework beyond Express. No TypeScript unless asked.
