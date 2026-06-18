#!/usr/bin/env bash
#
# One-shot local test environment for myopiaBackend.
#
#   ./setup-test.sh         start everything + print a ready-to-use token
#   ./setup-test.sh stop    stop the server + remove the docker containers
#
# It starts a Postgres DB and a Mailpit fake inbox in Docker, writes a .env if
# missing, runs the Prisma migration, boots the API server, then logs in via the
# dev endpoint and seeds a test patient + instrument so you can immediately POST
# measurements from Postman.

set -euo pipefail
cd "$(dirname "$0")"

# Native deps (bcrypt) are built for Node 18; fast-crc32c segfaults on newer
# Node here. Switch to an installed Node 18/20 LTS via nvm if available.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use 18 >/dev/null 2>&1 || nvm use 20 >/dev/null 2>&1 || true
fi
echo "Using Node $(node -v)"

DB_CONTAINER="eyelog-db"
MAIL_CONTAINER="eyelog-mailpit"
# Host port 5433 avoids clashing with any Postgres already on the default 5432.
DB_PORT="5433"
SERVER_PID_FILE=".test-server.pid"
SERVER_LOG=".test-server.log"
BASE_URL="http://localhost:3000"

# ---- stop mode -------------------------------------------------------------
if [ "${1:-}" = "stop" ]; then
  echo "Stopping server + containers..."
  [ -f "$SERVER_PID_FILE" ] && kill "$(cat "$SERVER_PID_FILE")" 2>/dev/null || true
  rm -f "$SERVER_PID_FILE"
  docker rm -f "$DB_CONTAINER" "$MAIL_CONTAINER" >/dev/null 2>&1 || true
  echo "Done. (Your data was in the DB container, so it's now gone — re-run ./setup-test.sh for a fresh start.)"
  exit 0
fi

command -v docker >/dev/null || { echo "Docker is required but not found. Install Docker Desktop first."; exit 1; }

# ---- 1. Postgres + Mailpit -------------------------------------------------
echo "==> Starting Postgres + Mailpit (Docker)..."
docker start "$DB_CONTAINER" >/dev/null 2>&1 || \
  docker run -d --name "$DB_CONTAINER" -e POSTGRES_PASSWORD=postgres -p "$DB_PORT":5432 postgres:16 >/dev/null
docker start "$MAIL_CONTAINER" >/dev/null 2>&1 || \
  docker run -d --name "$MAIL_CONTAINER" -p 1025:1025 -p 8025:8025 axllent/mailpit >/dev/null

# ---- 2. .env ---------------------------------------------------------------
if [ ! -f .env ]; then
  echo "==> Writing .env (test defaults)..."
  cat > .env <<EOF
DATABASE_URL=postgresql://postgres:postgres@localhost:${DB_PORT}/postgres
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_FROM=alerts@eyelog.test
EOF
fi

# ---- 3. wait for DB --------------------------------------------------------
echo "==> Waiting for Postgres to accept connections..."
until docker exec "$DB_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

# ---- 4. migrate ------------------------------------------------------------
echo "==> Applying database schema (prisma migrate)..."
npx prisma migrate dev --name add_audit_log >/dev/null

# ---- 5. start server -------------------------------------------------------
if [ -f "$SERVER_PID_FILE" ] && kill -0 "$(cat "$SERVER_PID_FILE")" 2>/dev/null; then
  echo "==> Server already running (pid $(cat "$SERVER_PID_FILE"))."
else
  echo "==> Starting API server (npm run dev)..."
  npm run dev > "$SERVER_LOG" 2>&1 &
  echo $! > "$SERVER_PID_FILE"
fi

echo "==> Waiting for $BASE_URL ..."
until curl -s -o /dev/null "$BASE_URL/auth/user" 2>/dev/null; do sleep 1; done

# ---- 6. dev login ----------------------------------------------------------
echo "==> Logging in via /auth/dev_login..."
TOKEN=$(curl -s -X POST "$BASE_URL/auth/dev_login" \
  | grep -o '"session_key":"[^"]*"' | sed 's/.*:"//;s/"//')

# ---- 7. seed patient + instrument -----------------------------------------
echo "==> Seeding test patient + instrument..."
SEED_OUT=$(node scripts/seed-test-data.cjs)
PATIENT_ID=$(echo "$SEED_OUT" | grep '^PATIENT_ID=' | cut -d= -f2)
INSTRUMENT_ID=$(echo "$SEED_OUT" | grep '^INSTRUMENT_ID=' | cut -d= -f2)

# ---- done ------------------------------------------------------------------
cat <<EOF

============================================================
 Test environment is READY
============================================================
 API base URL    : $BASE_URL
 Fake email inbox: http://localhost:8025   (open in browser)

 TOKEN       : $TOKEN
 PATIENT_ID  : $PATIENT_ID
 INSTRUMENT_ID: $INSTRUMENT_ID

 In Postman, set header:  Authorization: Bearer <TOKEN>

 Try it (this od:27.5 is over the 26.0 threshold -> sends an email):

 curl -X POST $BASE_URL/measurement \\
   -H "Authorization: Bearer $TOKEN" \\
   -H "Content-Type: application/json" \\
   -d '{"patient_id":"$PATIENT_ID","date":"2026-06-15","instrument_id":"$INSTRUMENT_ID","od":27.5,"os":24.0}'

 Then see the audit log:
 curl $BASE_URL/audit_log/patient/$PATIENT_ID -H "Authorization: Bearer $TOKEN"

 ...and check the email at  http://localhost:8025

 Server logs : tail -f $SERVER_LOG
 Stop everything: ./setup-test.sh stop
============================================================
EOF
