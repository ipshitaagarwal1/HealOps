# Runs scripts/seed-db.js inside the compose network (docker compose run --rm seed), so
# a production server doesn't need Node installed just to seed the database. Build
# context is the repo root, not scripts/, because it also needs db/seed/*.json.
#
#   docker compose build seed
#   docker compose run --rm seed            # embed + load runbooks (idempotent)
#   docker compose run --rm seed --force    # re-embed everything
FROM node:20-alpine

# psql: scripts/lib/psql.js uses it directly (no docker CLI inside this container).
RUN apk add --no-cache postgresql-client

WORKDIR /app
COPY scripts ./scripts
COPY db ./db

USER node
ENTRYPOINT ["node", "scripts/seed-db.js"]
