#!/bin/bash
# Runs the real Umami and PostgreSQL images from host/images.env (through host/compose.local.yaml) and checks
# what the server and the editor's sender rely on. infra-check.yml runs it; so can anyone with Docker.
#   1. the host files are valid (Compose, Caddyfile)
#   2. a text/plain batch with a browser User-Agent is stored, with its data; a bot User-Agent is not
#   3. nightly.sh's clean empties region and city
#   4. a dump restores into a fresh PostgreSQL with the same row counts
#   5. every saved query runs, and prints the rows the batch produces
# Needs docker, curl and jq.
set -euo pipefail

EVENTS=$(cd "$(dirname "$0")" && pwd)/contract-events.json
cd "$(dirname "$0")/../host"
COMPOSE="docker compose --env-file images.env -f compose.local.yaml"
dc() { $COMPOSE "$@"; }
# shellcheck disable=SC1091
. ./images.env
BROWSER='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

cleanup() {
    dc down -v > /dev/null 2>&1 || true
    docker rm -f nse-contract-restore > /dev/null 2>&1 || true
    rm -f /tmp/nse-contract.dump /tmp/nse-contract.headers
}
trap cleanup EXIT

step() { echo "== $*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
sql() { dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 -tA "$@"; }

step "host files"
POSTGRES_PASSWORD=x APP_SECRET=x STATS_HOSTNAME=stats.example.test docker compose --env-file images.env -f compose.yaml config --quiet
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e STATS_HOSTNAME=stats.example.test "$CADDY_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

step "start Umami"
dc up -d --wait --wait-timeout 300

WEBSITE=$(cat /proc/sys/kernel/random/uuid)
sql -c "INSERT INTO website (website_id, name, domain) VALUES ('$WEBSITE', 'contract', 'nse.qwewqa.dev')"

NOW=$(date +%s)
# The payload around an event, as the editor sends it.
# shellcheck disable=SC2016
BASE='{website: $w, hostname: "nse.qwewqa.dev", url: "/", title: "", language: "ja", screen: "1920x1080", timestamp: $t}'
ev() { # name, data (JSON object)
    jq -nc --arg w "$WEBSITE" --arg n "$1" --argjson d "$2" --argjson t "$NOW" \
        "{type: \"event\", payload: ($BASE + {name: \$n, data: \$d})}"
}
# The events in contract-events.json are checked against the editor's catalogue by a unit test. The one with
# an empty name is the pageview.
BATCH=$(jq -c --arg w "$WEBSITE" --argjson t "$NOW" \
    "[.[] | {type: \"event\", payload: ($BASE + (if .name == \"\" then {} else {name: .name, data: .data} end))}]" "$EVENTS")

step "a batch from a browser"
RESPONSE=$(curl -fsS -D /tmp/nse-contract.headers -X POST http://localhost:3000/api/batch \
    -H 'Content-Type: text/plain' -H "User-Agent: $BROWSER" -H 'X-Real-IP: 203.0.113.7' --data "$BATCH")
echo "$RESPONSE"
if [ "$(jq .processed <<< "$RESPONSE")" != 9 ] || [ "$(jq .errors <<< "$RESPONSE")" != 0 ]; then fail "the batch was not processed"; fi
grep -qi '^access-control-allow-origin: \*' /tmp/nse-contract.headers || fail "no CORS header on the batch response"
[ "$(sql -c "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE'")" = 9 ] || fail "expected 9 stored events"
[ "$(sql -c "SELECT count(*) FROM event_data WHERE website_id = '$WEBSITE'")" -ge 18 ] || fail "the event data was not stored"

step "a bot User-Agent is dropped"
BOT=$(curl -fsS -X POST http://localhost:3000/api/send -H 'Content-Type: text/plain' -H 'User-Agent: python-requests/2.32' \
    --data "$(ev nightly '{}')")
grep -q beep <<< "$BOT" || fail "a bot User-Agent was not dropped: $BOT"
[ "$(sql -c "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE'")" = 9 ] || fail "the bot's event was stored"

step "nightly.sh clean"
sql -c "UPDATE session SET region = 'WA', city = 'Seattle'"
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL")" -ge 1 ] || fail "no session to clean"
export NSE_COMPOSE="$COMPOSE"
# shellcheck disable=SC1091
. ./nightly.sh
clean
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] || fail "region or city was kept"

step "dump and restore"
dump_stream > /tmp/nse-contract.dump
docker run -d --name nse-contract-restore -e POSTGRES_PASSWORD=x -e POSTGRES_DB=umami "$POSTGRES_IMAGE" > /dev/null
for _ in $(seq 1 30); do docker exec nse-contract-restore pg_isready -U postgres -d umami > /dev/null 2>&1 && break; sleep 2; done
docker exec -i nse-contract-restore pg_restore -U postgres -d umami --no-owner --no-acl --exit-on-error < /tmp/nse-contract.dump
for table in website website_event event_data session _prisma_migrations; do
    a=$(sql -c "SELECT count(*) FROM $table")
    b=$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM $table")
    [ "$a" = "$b" ] || fail "$table: $a rows, $b after the restore"
done

step "saved queries"
run_query() { dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 -v "website=$WEBSITE" -tA -F'|' < "../queries/$1.sql"; }
expect() { # query, a row it must print
    run_query "$1" | grep -qxF "$2" || fail "$1.sql did not print the row $2"
}
for file in ../queries/*.sql; do
    echo "$file"
    run_query "$(basename "$file" .sql)" > /dev/null
done
# What the batch above holds, as each query reports it.
run_query visits | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[^|]+\|1$' || fail "visits.sql did not count the pageview"
expect commands 'zoomXIn|key|3|1'
expect commands 'undo|toolbar|1|1'
expect saves 'writeBack|failed|denied|1'
expect settings 'theme|dark|1'
expect settings 'showMinimap|on|1'
expect settings 'previewAssets.skin|bundled|1'
expect startup 'continued|1k-2k|1'
expect startup '1k-2k|1'
echo "All checks passed."
