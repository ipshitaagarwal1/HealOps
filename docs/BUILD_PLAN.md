# Build Plan

One phase at a time. At the end of each phase run its checks and report. Don't start
the next phase until the checks pass.

## Phase 1: Demo services + monitoring
Build `services/demo`, `prometheus/`, `alertmanager/`, `scripts/inject-fault.sh`, and
`docker-compose.yml` with service-a, service-b, a load generator, Prometheus,
Alertmanager. Use real healthchecks (`wget -qO-` or `node -e`; slim images may lack
curl).
**Check:** both targets UP in Prometheus; `./scripts/inject-fault.sh service-a error`
makes `HighErrorRate` fire within ~30s and show in Alertmanager;
`./scripts/inject-fault.sh service-a none` clears it.

## Phase 2: Database + seed data
Postgres (`pgvector/pgvector:pg16`), `db/init.sql`, `db/seed/*.json`,
`scripts/seed-db.js` (Gemini embeddings, idempotent).
**Check:** `SELECT kind, title FROM knowledge;` lists all seeds; a similarity query for
"memory leak high error rate" ranks the restart runbook first.

## Phase 3: Agent skeleton + webhook + audit
Express server, config validation, DB pool, JSON logger, webhook with dedupe and
resolve handling, `incidents` + `audit_log` writes. Agent added to compose; Alertmanager
pointed at it.
**Check:** injected fault creates one incident (`received`) plus a `webhook` audit row;
repeats don't duplicate; clearing the fault marks it `resolved`.

## Phase 4: RAG + diagnosis
`rag.js`, `diagnose.js` with timeouts, validation, retry-once, fallbacks. Verify
current Gemini and Groq model IDs/endpoints in official docs first.
**Check:** incident gets `retrieved` + valid `diagnosis`. With a bad `GROQ_API_KEY` the
agent opens a ticket with `llm_error` and keeps running.

## Phase 5: Guardrail (test-first)
Write `agent/test/guardrail.test.js` for every rule in SPEC section 6, confirm they
fail, then implement `guardrail.js` until green.
**Check:** `npm test --prefix agent` passes; list the test names in the report.

## Phase 6: Act + tickets
`act.js`, `tickets.js`, `actions.k8s.reference.js`, action_history, approve/reject.
**Check:** error fault → auto restart → alert resolves. Second fault within 10 min →
`cooldown_active` ticket. `DRY_RUN=true` → `dry_run` ticket. Approving a ticket runs the
action and logs `approved_by=human`.

## Phase 7: Latency metrics + dashboard
SPEC sections 7 and 8.
**Check:** open `http://localhost:3000`, inject a fault, watch steps stream live;
`/api/stats` and the page show real latency numbers; agent `/metrics` has stage
histograms.

## Phase 8: Demo polish
`scripts/demo.sh`: healthy → memory fault (auto restart) → second fault (cooldown
ticket) → simulated bad deploy (rollback ticket, never auto). README with Mermaid
architecture diagram, setup, demo walkthrough, measured latency numbers, design
decisions, known limitations (simulated services, no real cluster).
**Check:** fresh clone + `.env` + `docker compose up -d --build` + `node scripts/seed-db.js`
+ `./scripts/demo.sh` works end to end.
