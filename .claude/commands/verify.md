Verify the project is healthy. Don't change code unless something is broken.

1. `docker compose ps`: all containers up and healthy.
2. `npm test --prefix agent`.
3. Prometheus targets UP and Alertmanager config loaded.
4. Inject an error fault on service-a, wait up to 90s, show the newest incident with its
   audit trail and latency numbers, then clear the fault.
Report pass/fail per step. If something fails, explain the root cause before fixing.
