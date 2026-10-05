#!/usr/bin/env bash
# Break (or fix) a demo service on purpose.
#   ./scripts/inject-fault.sh <service-a|service-b> <error|latency|memory|crash|none> [rate]
# rate is 0.0-1.0 (default 1.0). ADMIN_TOKEN is read from the environment or .env.
set -euo pipefail

usage() {
  echo "usage: $0 <service-a|service-b> <error|latency|memory|crash|none> [rate 0.0-1.0]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
service="$1"
mode="$2"
rate="${3:-1.0}"

case "$service" in
  service-a) port="${SERVICE_A_PORT:-8081}" ;;
  service-b) port="${SERVICE_B_PORT:-8082}" ;;
  *) usage ;;
esac

case "$mode" in
  error|latency|memory|crash|none) ;;
  *) usage ;;
esac

if ! [[ "$rate" =~ ^(0(\.[0-9]+)?|1(\.0+)?)$ ]]; then
  echo "rate must be between 0.0 and 1.0" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "${ADMIN_TOKEN:-}" ] && [ -f "$root/.env" ]; then
  # Read only ADMIN_TOKEN; strip quotes and Windows line endings. Never echoed.
  ADMIN_TOKEN="$(grep -E '^[[:space:]]*ADMIN_TOKEN[[:space:]]*=' "$root/.env" | tail -n1 \
    | cut -d= -f2- | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
fi
if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ADMIN_TOKEN not set (environment or .env)" >&2
  exit 1
fi

echo "setting $service fault: mode=$mode rate=$rate"
curl -sS --fail-with-body --max-time 5 \
  -X POST "http://localhost:${port}/admin/fault" \
  -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d "{\"mode\":\"${mode}\",\"rate\":${rate}}"
echo
