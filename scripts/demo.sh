#!/usr/bin/env bash
# Scripted end-to-end demo (docs/BUILD_PLAN.md Phase 8):
#   healthy -> memory fault (auto restart) -> second fault (cooldown ticket)
#   -> simulated bad deploy (rollback ticket, never auto)
#
# Requires the stack up (`docker compose up -d --build`) and the DB seeded
# (`node scripts/seed-db.js`). Uses only the public agent/demo-service APIs, the same
# ones the dashboard buttons call, so it doubles as a smoke test after a fresh clone.
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_URL="${AGENT_URL:-http://localhost:3000}"
SERVICE="${1:-service-a}"
case "$SERVICE" in
  service-a|service-b) ;;
  *) echo "usage: $0 [service-a|service-b]" >&2; exit 2 ;;
esac

# Same ADMIN_TOKEN lookup as inject-fault.sh: environment first, then .env.
if [ -z "${ADMIN_TOKEN:-}" ] && [ -f "$root/.env" ]; then
  ADMIN_TOKEN="$(grep -E '^[[:space:]]*ADMIN_TOKEN[[:space:]]*=' "$root/.env" | tail -n1 \
    | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN not set (environment or .env)" >&2
  exit 1
fi
export ADMIN_TOKEN AGENT_URL

step()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
ok()    { printf '  \033[1;32mOK\033[0m  %s\n' "$1"; }
bad()   { printf '  \033[1;31mFAIL\033[0m %s\n' "$1"; exit 1; }
now_iso() { node -e 'console.log(new Date().toISOString())'; }

wait_incident() { node "$root/scripts/demo-wait.js" incident "$@"; }
wait_ticket()   { node "$root/scripts/demo-wait.js" ticket "$@"; }

jfield() { node -e "const o=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(o?.[process.argv[1]] ?? '')" "$1"; }

port_a="${SERVICE_A_PORT:-8081}"
port_b="${SERVICE_B_PORT:-8082}"
service_port() { [ "$1" = service-a ] && echo "$port_a" || echo "$port_b"; }
# A real pod restart (not just clearing the fault mode): releases memory a 'memory'
# fault already leaked, the same way an actual restart would.
restart_service() {
  curl -sS --max-time 5 -X POST "http://localhost:$(service_port "$1")/admin/restart" -H "x-admin-token: ${ADMIN_TOKEN}" >/dev/null
}

step "0. Baseline: both services healthy"
for entry in "service-a:$port_a" "service-b:$port_b"; do
  svc="${entry%%:*}"; port="${entry##*:}"
  health="$(curl -sS --max-time 5 "http://localhost:${port}/health")" || bad "$svc unreachable on :$port"
  echo "$health" | grep -q '"status":"ok"' && ok "$svc healthy ($health)" || bad "$svc not healthy: $health"
done
agent_health="$(curl -sS --max-time 5 "${AGENT_URL}/health")" || bad "agent unreachable"
echo "$agent_health" | grep -q '"status":"ok"' && ok "agent healthy" || bad "agent not healthy: $agent_health"

step "1. Memory fault on $SERVICE -> expect auto restart_pod"
t1="$(now_iso)"
"$root/scripts/inject-fault.sh" "$SERVICE" memory 1.0 >/dev/null
echo "  fault injected at $t1; waiting for HighMemory to fire, diagnose, and act (up to 150s)..."
incident1="$(wait_incident "$SERVICE" "$t1" "acted,ticketed" 150)" || bad "no incident reached acted/ticketed in time"
status1="$(echo "$incident1" | jfield status)"
action1="$(echo "$incident1" | jfield action)"
if [ "$status1" = "acted" ] && [ "$action1" = "restart_pod" ]; then
  ok "incident $(echo "$incident1" | jfield id) auto-restarted $SERVICE"
else
  bad "expected status=acted action=restart_pod, got status=$status1 action=$action1: $incident1"
fi

step "2. Same fault on $SERVICE again, inside the cooldown window -> expect a ticket, not a second restart"
# Same fault as step 1 (not a different one): the diagnosis should land on restart_pod
# again, same as last time, so this isolates the cooldown rule instead of depending on
# which action the LLM happens to pick for a different kind of fault.
t2="$(now_iso)"
"$root/scripts/inject-fault.sh" "$SERVICE" memory 1.0 >/dev/null
echo "  fault injected at $t2; waiting for HighMemory to fire and the guardrail to ticket it (up to 150s)..."
incident2="$(wait_incident "$SERVICE" "$t2" "acted,ticketed" 150)" || bad "no incident reached acted/ticketed in time"
status2="$(echo "$incident2" | jfield status)"
reasons2="$(echo "$incident2" | jfield reasons)"
if [ "$status2" = "ticketed" ]; then
  ok "incident $(echo "$incident2" | jfield id) was ticketed instead of acted again: $reasons2"
else
  bad "expected status=ticketed (cooldown should block a second restart), got status=$status2: $incident2"
fi
restart_service "$SERVICE"
ticket2="$(wait_ticket "$SERVICE" "$t2" - 10)" || bad "incident was ticketed but no open ticket found"
curl -sS --max-time 5 -X POST "${AGENT_URL}/api/tickets/$(echo "$ticket2" | jfield id)/reject" -H "x-admin-token: ${ADMIN_TOKEN}" >/dev/null
ok "manually restarted $SERVICE (outside the guardrail) and rejected the ticket"

step "3. Simulated bad deploy on $SERVICE -> expect a ticket, never an automatic action"
# The demo services don't track real releases, so this isn't driven by inject-fault.sh /
# Prometheus like the steps above. It posts a synthetic Alertmanager webhook straight to
# the agent, shaped like the "error spike after a deploy" seed incident (db/seed), to
# show the one path the guardrail refuses to automate regardless of LLM confidence.
t3="$(now_iso)"
fingerprint="demo-bad-deploy-$(date +%s)"
payload=$(node -e '
const [service, fingerprint] = process.argv.slice(1);
const now = new Date().toISOString();
console.log(JSON.stringify({
  alerts: [{
    status: "firing",
    fingerprint,
    labels: { alertname: "HighErrorRate", service, severity: "critical" },
    annotations: {
      summary: `${service} 5xx ratio is 95%`,
      description: `More than 50% of requests to ${service} returned 5xx within minutes of release 2.4.0 going out. Traffic and dependencies are normal; errors are the same null-reference exception on every request.`,
    },
    startsAt: now,
    endsAt: "0001-01-01T00:00:00Z",
  }],
}));
' "$SERVICE" "$fingerprint")
curl -sS --max-time 5 -X POST "${AGENT_URL}/webhook/alertmanager" -H 'Content-Type: application/json' -d "$payload" >/dev/null
echo "  synthetic alert posted at $t3; waiting for diagnosis + guardrail (up to 60s)..."
incident3="$(wait_incident "$SERVICE" "$t3" "ticketed,acted" 60)" || bad "incident never reached a final status"
status3="$(echo "$incident3" | jfield status)"
action3="$(echo "$incident3" | jfield action)"
if [ "$status3" != "ticketed" ]; then
  bad "guardrail let a bad-deploy-shaped incident run automatically (status=$status3 action=$action3) - this must never happen"
fi
ok "incident $(echo "$incident3" | jfield id) was ticketed, not auto-acted (diagnosed action: $action3)"
ticket3="$(wait_ticket "$SERVICE" "$t3" - 10)" || bad "ticketed incident but no open ticket found"
ticket3_id="$(echo "$ticket3" | jfield id)"
ticket3_action="$(echo "$ticket3" | jfield recommended_action)"
case "$ticket3_action" in
  restart_pod|scale_up|rollback_deploy)
    curl -sS --max-time 5 -X POST "${AGENT_URL}/api/tickets/${ticket3_id}/approve" -H "x-admin-token: ${ADMIN_TOKEN}" >/dev/null
    ok "ticket $ticket3_id ($ticket3_action) approved by a human; action ran as approved_by=human"
    ;;
  *)
    curl -sS --max-time 5 -X POST "${AGENT_URL}/api/tickets/${ticket3_id}/reject" -H "x-admin-token: ${ADMIN_TOKEN}" >/dev/null
    ok "ticket $ticket3_id ($ticket3_action) rejected (nothing runnable to approve)"
    ;;
esac

step "Done"
echo "Live stats from this run:"
curl -sS --max-time 5 "${AGENT_URL}/api/stats"
echo
echo "Open the dashboard at ${AGENT_URL} to watch the next run live."
