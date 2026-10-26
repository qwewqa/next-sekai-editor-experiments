#!/bin/bash
# Runs the real Umami and PostgreSQL images from host/images.env (through host/compose.local.yaml) and checks
# what the server and the editor's sender rely on. infra-check.yml runs it; so can anyone with Docker.
#   1. the host files are valid (Compose, Caddyfile), and Caddy's own log drops the visitor's address and headers
#   2. a text/plain batch with a browser User-Agent is stored, with its data; a bot User-Agent is not
#   3. nightly.sh's clean empties region and city
#   4. geo-trigger.sql installs twice, and then no session keeps a region or a city, whether it is inserted with them,
#      updated to have them, or created by a request
#   5. nightly.sh's dump (with the upload stubbed) clears a region and city that are stored when it starts, a failed
#      clean stops it before any upload, and the dump restores into a fresh PostgreSQL with the same row counts and no
#      region or city
#   6. every saved query runs, and prints the rows the batch produces
# Needs docker, curl and jq.
set -euo pipefail

EVENTS=$(cd "$(dirname "$0")" && pwd)/contract-events.json
cd "$(dirname "$0")/../host"
COMPOSE="docker compose --env-file images.env -f compose.local.yaml"
dc() { $COMPOSE "$@"; }
# shellcheck disable=SC1091
. ./images.env
BROWSER='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

WORK=$(mktemp -d)
cleanup() {
    dc down -v > /dev/null 2>&1 || true
    docker rm -f nse-contract-restore nse-contract-caddy > /dev/null 2>&1 || true
    rm -rf "$WORK" /tmp/nse-contract.headers
}
trap cleanup EXIT

step() { echo "== $*"; }
fail() { echo "FAILED: $*" >&2; exit 1; }
sql() { dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 -tA "$@"; }

step "host files"
POSTGRES_PASSWORD=x APP_SECRET=x STATS_HOSTNAME=stats.example.test docker compose --env-file images.env -f compose.yaml config --quiet
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e STATS_HOSTNAME=stats.example.test "$CADDY_IMAGE" \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

# The global log block turns Caddy's own log, which holds the request behind every logged error, into a filter encoder
# that deletes the visitor's address and headers.
FILTERED=$(docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e STATS_HOSTNAME=stats.example.test "$CADDY_IMAGE" \
    caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2> /dev/null \
    | jq -c '.logging.logs.default.encoder | [.format, ([.fields | to_entries[] | select(.value.filter == "delete") | .key] | sort)]')
[ "$FILTERED" = '["filter",["error","remote","remote_addr","request>client_ip","request>headers","request>remote_ip","request>remote_port"]]' ] \
    || fail "Caddy's log is not filtered as expected: $FILTERED"

step "Caddy's error log keeps no visitor address"
# The real Caddyfile on a plain-HTTP site, with umami pointing at a closed port, so that every request to /api/send
# fails in reverse_proxy and Caddy logs the error. The request carries an address and a User-Agent that must not appear.
docker run -d --name nse-contract-caddy --add-host umami:127.0.0.1 -p 127.0.0.1::8080 \
    -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -e STATS_HOSTNAME=http://:8080 "$CADDY_IMAGE" > /dev/null
CADDY_URL="http://$(docker port nse-contract-caddy 8080/tcp | head -n 1)"
STATUS=000
for _ in $(seq 30); do
    STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CADDY_URL/api/send" -H 'X-Forwarded-For: 198.51.100.77' \
        -H 'User-Agent: ContractVisitor/9.9' --data '{}' || true)
    [ "$STATUS" = 502 ] && break
    sleep 1
done
[ "$STATUS" = 502 ] || fail "Caddy answered $STATUS where it should answer 502 for an upstream that is down"
CADDY_LOG=$(docker logs nse-contract-caddy 2>&1)
# The log lines are JSON. The error line is the one from the http.log.error logger.
ERRORS=$(jq -cR 'fromjson? | select(.logger == "http.log.error")' <<< "$CADDY_LOG")
[ -n "$ERRORS" ] || fail "Caddy logged no error for the failed request. Its log:
$CADDY_LOG"
jq -e -s 'all(.[]; .level == "error" and .status == 502 and (.msg | endswith("connection refused"))
    and .request.method == "POST" and .request.uri == "/api/send")' <<< "$ERRORS" > /dev/null \
    || fail "the error line lost its message, status or request line: $ERRORS"
if grep -qE '198\.51\.100\.77|ContractVisitor|remote_ip|remote_port|client_ip|"headers"' <<< "$CADDY_LOG"; then
    fail "Caddy's log holds a visitor address or header:
$CADDY_LOG"
fi
docker rm -f nse-contract-caddy > /dev/null

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
if [ "$(jq .processed <<< "$RESPONSE")" != 17 ] || [ "$(jq .errors <<< "$RESPONSE")" != 0 ]; then fail "the batch was not processed"; fi
grep -qi '^access-control-allow-origin: \*' /tmp/nse-contract.headers || fail "no CORS header on the batch response"
[ "$(sql -c "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE'")" = 17 ] || fail "expected 17 stored events"
[ "$(sql -c "SELECT count(*) FROM event_data WHERE website_id = '$WEBSITE'")" = 90 ] || fail "the event data was not stored"

step "a bot User-Agent is dropped"
BOT=$(curl -fsS -X POST http://localhost:3000/api/send -H 'Content-Type: text/plain' -H 'User-Agent: python-requests/2.32' \
    --data "$(ev nightly '{}')")
grep -q beep <<< "$BOT" || fail "a bot User-Agent was not dropped: $BOT"
[ "$(sql -c "SELECT count(*) FROM website_event WHERE website_id = '$WEBSITE'")" = 17 ] || fail "the bot's event was stored"

step "nightly.sh clean"
sql -c "UPDATE session SET region = 'WA', city = 'Seattle'"
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL")" -ge 1 ] || fail "no session to clean"
export NSE_COMPOSE="$COMPOSE"
# shellcheck disable=SC1091
. ./nightly.sh
clean
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] || fail "region or city was kept"

step "region and city are never stored"
# psql -1 is the way update.sh runs the file, and the second run shows it can be repeated.
sql -q -1 -f - < ../host/geo-trigger.sql
sql -q -1 -f - < ../host/geo-trigger.sql
# A new session that arrives with a region and a city is stored without them, and keeps its country.
SESSION=$(cat /proc/sys/kernel/random/uuid)
sql -c "INSERT INTO session (session_id, website_id, country, region, city) VALUES ('$SESSION', '$WEBSITE', 'US', 'WA', 'Seattle')" > /dev/null
[ "$(sql -c "SELECT count(*) FROM session WHERE session_id = '$SESSION' AND country = 'US'")" = 1 ] || fail "the new session was not stored with its country"
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] || fail "a new session kept its region or city"
# An update cannot set them either.
sql -c "UPDATE session SET region = 'WA', city = 'Seattle'" > /dev/null
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] || fail "an update set a region or city"
# A request after the trigger is installed. A new IP address makes a new session, on a website of its own so the saved
# queries below are unchanged. The Cloudflare headers are one way Umami may be given a location; if it ignores them the
# session has none, and the check still holds.
GEO=$(cat /proc/sys/kernel/random/uuid)
sql -c "INSERT INTO website (website_id, name, domain) VALUES ('$GEO', 'geo', 'nse.qwewqa.dev')" > /dev/null
# shellcheck disable=SC2016
GEO_EVENT=$(jq -nc --arg w "$GEO" --argjson t "$NOW" '{type: "event", payload: {website: $w, hostname: "nse.qwewqa.dev", url: "/", title: "", language: "ja", screen: "1920x1080", timestamp: $t}}')
curl -fsS -X POST http://localhost:3000/api/send -H 'Content-Type: text/plain' -H "User-Agent: $BROWSER" -H 'X-Real-IP: 203.0.113.8' \
    -H 'cf-ipcountry: US' -H 'cf-region-code: WA' -H 'cf-ipcity: Seattle' --data "$GEO_EVENT" > /dev/null
[ "$(sql -c "SELECT count(*) FROM session WHERE website_id = '$GEO'")" = 1 ] || fail "the request did not create one session"
[ "$(sql -c "SELECT count(*) FROM session WHERE website_id = '$GEO' AND region IS NULL AND city IS NULL")" = 1 ] || fail "the session from a request kept its region or city"

step "dump()"
# nightly.sh's dump itself, with the upload stubbed to copy the file. The trigger is off while a region and a city are
# put back, and nothing calls clean first: dump() has to clear them before its snapshot.
export NSE_BUCKET=contract NSE_DUMP_DIR="$WORK/dumps"
UPLOADS="$WORK/uploads"
mkdir -p "$UPLOADS"
aws() { cp "$4" "$UPLOADS/$(basename "$5")"; } # s3 cp --only-show-errors <file> <destination>
sql -c "ALTER TABLE session DISABLE TRIGGER nse_drop_geo" > /dev/null
sql -c "UPDATE session SET region = 'WA', city = 'Seattle'" > /dev/null
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL AND city IS NOT NULL")" -ge 1 ] || fail "no session to dump with a region"
# A clean that fails stops dump() before it makes a file or uploads one. Only the psql calls fail.
if (
    # shellcheck disable=SC2317,SC2329
    dc() { case " $* " in *" psql "*) return 1 ;; esac; $NSE_COMPOSE "$@"; }
    dump
); then fail "dump() went on after a failed clean"; fi
[ -z "$(ls -A "$UPLOADS")" ] || fail "dump() uploaded after a failed clean"
[ ! -d "$NSE_DUMP_DIR" ] || [ -z "$(ls -A "$NSE_DUMP_DIR")" ] || fail "dump() left a file after a failed clean"
dump || fail "dump() failed"
[ "$(find "$UPLOADS" -type f | wc -l)" = 1 ] || fail "dump() did not upload exactly one dump"
[ -z "$(ls -A "$NSE_DUMP_DIR")" ] || fail "dump() left its file after the upload"
[ "$(sql -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] || fail "dump() did not clear the region and city"
sql -c "ALTER TABLE session ENABLE TRIGGER nse_drop_geo" > /dev/null

step "dump and restore"
docker run -d --name nse-contract-restore -e POSTGRES_PASSWORD=x -e POSTGRES_DB=umami "$POSTGRES_IMAGE" > /dev/null
# Over TCP: the image's first-run server listens only on the socket, before the database exists.
for _ in $(seq 1 30); do docker exec nse-contract-restore pg_isready -h 127.0.0.1 -U postgres -d umami > /dev/null 2>&1 && break; sleep 2; done
docker exec -i nse-contract-restore pg_restore -U postgres -d umami --no-owner --no-acl --exit-on-error < "$UPLOADS"/*.dump
for table in website website_event event_data session _prisma_migrations; do
    a=$(sql -c "SELECT count(*) FROM $table")
    b=$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM $table")
    [ "$a" = "$b" ] || fail "$table: $a rows, $b after the restore"
done
[ "$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] \
    || fail "the dump holds a region or city"

step "saved queries"
run_query() { # query, website (default: the one with the batch)
    dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 -v "website=${2:-$WEBSITE}" -tA -F'|' < "../queries/$1.sql"
}
expect() { # query, a row it must print
    # The rows are captured first: grep -q exits at its match, and under pipefail the closed pipe fails psql.
    local rows
    rows=$(run_query "$1")
    grep -qxF "$2" <<< "$rows" || fail "$1.sql did not print the row $2. It printed:
$rows"
}
for file in ../queries/*.sql; do
    echo "$file"
    run_query "$(basename "$file" .sql)" > /dev/null
done
# What the batch above holds, as each query reports it.
rows=$(run_query visits)
grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[^|]+\|1$' <<< "$rows" || fail "visits.sql did not count the pageview. It printed:
$rows"
expect commands 'zoomXIn|key|3|1'
expect commands 'undo|toolbar|1|1'
expect saves 'writeBack|failed|denied|1'
expect settings 'theme|dark|1'
expect settings 'showMinimap|on|1'
expect settings 'previewAssets.skin|bundled|1'
expect startup 'reload|cache|2|2|2000|2250|2400|2450|0'
expect startup 'navigate|network|1|0|||||'
expect startup '1000-1299|1'
expect frames 'worker|1|1|4|120|2.00'
expect frames 'worker|2|1|0|60|0.00'
expect frames '3|1|33'
expect actions 'save|save|writeBack|1M-2M|2|1000|1160'
expect actions 'open|||256K-512K|1|400|400'
expect peek 'cached|5'
expect peek '25-50|3'
# A website with no events: every query still runs, and the share left out of the frames is empty, not an error.
EMPTY=$(cat /proc/sys/kernel/random/uuid)
sql -c "INSERT INTO website (website_id, name, domain) VALUES ('$EMPTY', 'empty', 'nse.qwewqa.dev')"
for file in ../queries/*.sql; do
    run_query "$(basename "$file" .sql)" "$EMPTY" > /dev/null
done
rows=$(run_query frames "$EMPTY")
[ "$rows" = "0|0|" ] || fail "frames.sql on a website with no events printed: $rows"
echo "All checks passed."
