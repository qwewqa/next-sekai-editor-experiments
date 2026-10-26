#!/bin/bash
# Runs the real Umami and PostgreSQL images from host/images.env (through host/compose.local.yaml) and checks
# what the server and the editor's sender rely on. infra-check.yml runs it; so can anyone with Docker.
#   1. the host files are valid (Compose, Caddyfile), and Caddy's own log drops the visitor's address and headers
#   2. a text/plain batch with a browser User-Agent is stored, with its data; a bot User-Agent is not
#   3. nightly.sh's clean empties region and city
#   4. geo-trigger.sql installs twice, and then no session keeps a region or a city, whether it is inserted with them,
#      updated to have them, or created by a request
#   5. nightly.sh's dump (with the upload stubbed) clears a region and city that are stored when it starts, a failed
#      clean stops it before any upload, and the dump restores into a fresh PostgreSQL with the same row counts, no
#      region or city and no record older than 13 months
#   6. nightly.sh's retain (the allowlist and retention SQL): the totals of the complete months (counts, sums and
#      percentiles, no codes) for what the catalogue allows and for 10 or more sessions; a failure in the totals deletes
#      nothing; the records older than 13 months, their sessions and what hangs off them go (heatmap rows too); a late
#      report is counted by the next run and a final month is not made again; mixed versions, groups of one, one session
#      with many events, text that is not in the catalogue and 6000 junk events are not totalled; a second run changes
#      nothing, Umami's start leaves nse_monthly alone, and tidy deletes old dump files
#   7. every saved query runs, and prints the rows the batch produces
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
    | jq -c '.logging.logs.default | [.exclude, .encoder.format, ([.encoder.fields | to_entries[] | select(.value.filter == "delete") | .key] | sort)]')
[ "$FILTERED" = '[["http.log.error"],"filter",["error","remote","remote_addr","request>client_ip","request>headers","request>remote_ip","request>remote_port"]]' ] \
    || fail "Caddy's log is not filtered as expected: $FILTERED"

step "Caddy's error log keeps no visitor address"
# The real Caddyfile on a plain-HTTP site, with umami pointing at a closed port, so that every request to /api/send
# fails in reverse_proxy. Caddy logs no request error. The request carries an address and a User-Agent that must not appear.
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
# The log lines are JSON. Caddy logged its start, and no request error.
[ -n "$(jq -cR 'fromjson? | select(.logger != null)' <<< "$CADDY_LOG")" ] || fail "Caddy's log is not JSON:
$CADDY_LOG"
[ -z "$(jq -cR 'fromjson? | select(.logger == "http.log.error")' <<< "$CADDY_LOG")" ] || fail "Caddy logged a request error:
$CADDY_LOG"
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

step "retention and monthly totals"
ROLL=$(cat /proc/sys/kernel/random/uuid)
JUNK=$(cat /proc/sys/kernel/random/uuid)
SITE=$ROLL
# A failed check prints what was found and the rows of nse_monthly for the website being checked.
dump_monthly() {
    sql -c "SELECT month, metric, name, value, version, device, n, contributors, total, p50, p90, p99 FROM nse_monthly WHERE website_id = '$SITE' ORDER BY 1, 2, 3, 4, 5, 6" >&2 || true
}
check_sql() { # what, the expected output, the query
    local got
    got=$(sql -c "$3")
    [ "$got" = "$2" ] && return 0
    dump_monthly
    fail "$1: expected '$2', found '$got'"
}
total() { # month, metric, name, value, version, device -> the row's n
    sql -c "SELECT n FROM nse_monthly WHERE website_id = '$SITE' AND month = '$1' AND metric = '$2' AND name = '$3' AND value = '$4' AND version = '$5' AND device = '$6'"
}
check_total() { # the expected n (empty for no row), then the arguments of total
    local got
    got=$(total "${@:2}")
    [ "$got" = "$1" ] && return 0
    dump_monthly
    fail "nse_monthly ${*:2}: expected '$1', found '$got'"
}
check_time() { # month, property, version, device, then the expected "n|p50|p90|p99" (empty for no row)
    check_sql "time $1 $2 '$3' '$4'" "$5" "SELECT n || '|' || p50 || '|' || p90 || '|' || p99 FROM nse_monthly WHERE website_id = '$SITE' AND month = '$1' AND metric = 'time' AND name = '$2' AND version = '$3' AND device = '$4'"
}

# The first run creates nse_monthly. Everything stored so far is from this month, so it adds and deletes nothing.
retain
check_sql "retain added totals for a month that is not complete" 0 "SELECT count(*) FROM nse_monthly"
SC=$(cat /proc/sys/kernel/random/uuid) SF=$(cat /proc/sys/kernel/random/uuid)
sql -c "INSERT INTO website (website_id, name, domain) VALUES ('$ROLL', 'roll', 'nse.qwewqa.dev'), ('$JUNK', 'junk', 'nse.qwewqa.dev')" > /dev/null
# Raw records, by months ago:
#   3  11 sessions on a laptop with 1.0.0 and 11 on a desktop with 1.1.0, each with a Save time and a use count
#   2  10 laptop sessions on 1.0.0, 10 that updated to 1.1.0 the same day (mixed), one on 2.0.0 on a tablet (a group of
#      one), one with 30 Exports (one session with many events), and 10 that Opened a file in five formats, 2 each
#   15 10 sessions with a Save time, one of them (C) with the rows that hang off a session; F has an old event and a
#      recent one, so its session must stay
#   JUNK website, 3 months ago: 12 sessions with text that is not in the catalogue, in unknown and in known properties,
#      and 6000 events with names and values of their own
sql -q -v "roll=$ROLL" -v "junk=$JUNK" -v "sc=$SC" -v "sf=$SF" -f - << 'SQL'
SET TIME ZONE 'UTC';
SELECT set_config('nse.roll', :'roll', false), set_config('nse.junk', :'junk', false),
       set_config('nse.sc', :'sc', false), set_config('nse.sf', :'sf', false) \g /dev/null
CREATE FUNCTION pg_temp.m(n int) RETURNS timestamptz LANGUAGE sql AS $$
    SELECT date_trunc('month', now()) - make_interval(months => n) + interval '10 days'
$$;
CREATE FUNCTION pg_temp.mk(sid uuid, site uuid, ts timestamptz, br text, sys text, dv text, cc text, lg text) RETURNS uuid LANGUAGE sql AS $$
    INSERT INTO session (session_id, website_id, browser, os, device, country, language, created_at)
    VALUES (sid, site, br, sys, dv, cc, lg, ts) RETURNING session_id
$$;
CREATE FUNCTION pg_temp.ev(site uuid, sess uuid, ts timestamptz, etype int, ename text, props jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid();
BEGIN
    INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, event_name, hostname)
    VALUES (id, site, sess, sess, ts, '/', etype, ename, 'nse.qwewqa.dev');
    INSERT INTO event_data (event_data_id, website_id, website_event_id, data_key, string_value, number_value, data_type, created_at)
    SELECT gen_random_uuid(), site, id, key,
           CASE WHEN jsonb_typeof(value) = 'string' THEN value #>> '{}' END,
           CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{}')::numeric END,
           CASE WHEN jsonb_typeof(value) = 'number' THEN 2 ELSE 1 END, ts
    FROM jsonb_each(props);
END $$;
DO $$
DECLARE
    roll uuid := current_setting('nse.roll')::uuid;
    junk uuid := current_setting('nse.junk')::uuid;
    sc uuid := current_setting('nse.sc')::uuid;
    sf uuid := current_setting('nse.sf')::uuid;
    s uuid;
    t timestamptz;
    js uuid[] := ARRAY[]::uuid[];
    formats text[] := ARRAY['levelData', 'sus', 'usc', 'chcy', 'nxsp'];
BEGIN
    FOR i IN 1..11 LOOP
        t := pg_temp.m(3) + i * interval '1 minute';
        s := pg_temp.mk(gen_random_uuid(), roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "1.0.0"}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'save', jsonb_build_object('outcome', 'done', 'took', 100 + i));
        PERFORM pg_temp.ev(roll, s, t, 2, 'usage', jsonb_build_object('undo.key', i));
        s := pg_temp.mk(gen_random_uuid(), roll, t, 'firefox', 'Linux', 'desktop', 'JP', 'en');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "1.1.0"}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'save', jsonb_build_object('outcome', 'done', 'took', 1000 + i));
    END LOOP;
    FOR i IN 1..10 LOOP
        t := pg_temp.m(2) + i * interval '1 minute';
        s := pg_temp.mk(gen_random_uuid(), roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "1.0.0"}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'save', '{"outcome": "done", "took": 200}');
        s := pg_temp.mk(gen_random_uuid(), roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "1.0.0"}');
        PERFORM pg_temp.ev(roll, s, t + interval '30 seconds', 2, 'visit', '{"version": "1.1.0"}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'save', '{"outcome": "done", "took": 300}');
        s := pg_temp.mk(gen_random_uuid(), roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'open', jsonb_build_object('format', formats[1 + (i - 1) % 5]));
    END LOOP;
    t := pg_temp.m(2);
    s := pg_temp.mk(gen_random_uuid(), roll, t, 'safari', 'iOS', 'tablet', 'US', 'ja');
    PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
    PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "2.0.0"}');
    PERFORM pg_temp.ev(roll, s, t, 2, 'save', '{"outcome": "done", "took": 5001}');
    s := pg_temp.mk(gen_random_uuid(), roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
    PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
    FOR i IN 1..30 LOOP
        PERFORM pg_temp.ev(roll, s, t, 2, 'export', '{"outcome": "done", "took": 50}');
    END LOOP;

    FOR i IN 1..10 LOOP
        t := pg_temp.m(15) + i * interval '1 minute';
        s := pg_temp.mk(CASE WHEN i = 1 THEN sc ELSE gen_random_uuid() END, roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
        PERFORM pg_temp.ev(roll, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'visit', '{"version": "1.0.0"}');
        PERFORM pg_temp.ev(roll, s, t, 2, 'save', '{"outcome": "done", "took": 500}');
    END LOOP;
    t := pg_temp.m(15);
    PERFORM pg_temp.mk(sf, roll, t, 'chrome', 'Windows 10', 'laptop', 'US', 'ja');
    PERFORM pg_temp.ev(roll, sf, t, 1, NULL, '{}');
    PERFORM pg_temp.ev(roll, sf, pg_temp.m(2), 2, 'features', '{}');
    INSERT INTO session_data (session_data_id, website_id, session_id, data_key, data_type) VALUES
        (gen_random_uuid(), roll, sc, 'k', 1), (gen_random_uuid(), roll, sf, 'k', 1);
    INSERT INTO session_link (website_id, session_id, distinct_id) VALUES (roll, sc, 'x');
    INSERT INTO session_replay (replay_id, website_id, session_id, visit_id, chunk_index, events, event_count, started_at, ended_at)
    VALUES (gen_random_uuid(), roll, sc, sc, 0, '\x00', 1, now(), now());
    INSERT INTO revenue (revenue_id, website_id, session_id, event_id, event_name, currency)
    VALUES (gen_random_uuid(), roll, sc, gen_random_uuid(), 'x', 'USD');
    INSERT INTO heatmap_event (heatmap_event_id, website_id, session_id, visit_id, url_path, event_type, created_at) VALUES
        (gen_random_uuid(), roll, sc, sc, '/', 1, pg_temp.m(15)),
        (gen_random_uuid(), roll, sf, sf, '/', 1, pg_temp.m(15)),
        (gen_random_uuid(), roll, sf, sf, '/', 1, pg_temp.m(2));

    FOR i IN 1..12 LOOP
        t := pg_temp.m(3) + i * interval '1 minute';
        s := pg_temp.mk(gen_random_uuid(), junk, t, 'person@example.com', 'x', 'y', 'zz', 'Not A Language!!');
        js := js || s;
        PERFORM pg_temp.ev(junk, s, t, 1, NULL, '{}');
        PERFORM pg_temp.ev(junk, s, t, 2, 'visit', '{"version": "alice"}');
        PERFORM pg_temp.ev(junk, s, t, 2, 'save', '{"outcome": "person@example.com", "email": "a@b.c", "took": 10}');
        PERFORM pg_temp.ev(junk, s, t, 2, 'secret', '{"x": "alice"}');
    END LOOP;
    FOR i IN 1..3000 LOOP
        t := pg_temp.m(3) + interval '1 hour';
        PERFORM pg_temp.ev(junk, js[1 + i % 12], t, 2, 'junk' || i, jsonb_build_object('x', 'v' || i));
        PERFORM pg_temp.ev(junk, js[1 + i % 12], t, 2, 'save', jsonb_build_object('outcome', 'v' || i));
    END LOOP;
END $$;
SQL
OLD_EVENTS="SELECT count(*) FROM website_event WHERE website_id = '$ROLL' AND created_at < now() - interval '13 months'"
KEPT_EVENTS="SELECT count(*) FROM website_event WHERE website_id = '$ROLL' AND created_at >= now() - interval '13 months'"
KEPT=$(sql -c "$KEPT_EVENTS")
check_sql "the old events were not seeded" 31 "$OLD_EVENTS"
[ "$KEPT" -gt 150 ] || fail "the recent events were not seeded: $KEPT"

# If the totals fail, nothing is deleted. A check that refuses every new row stands in for the failure.
sql -c "ALTER TABLE nse_monthly ADD CONSTRAINT nse_fail CHECK (n < 0) NOT VALID" > /dev/null
if retain 2> /dev/null; then fail "retain went on after the totals failed"; fi
check_sql "retain deleted records after its totals failed" 31 "$OLD_EVENTS"
check_sql "a failed retain kept some totals" 0 "SELECT count(*) FROM nse_monthly"
sql -c "ALTER TABLE nse_monthly DROP CONSTRAINT nse_fail" > /dev/null

retain
check_sql "retain kept a record older than 13 months" 0 "$OLD_EVENTS"
check_sql "retain deleted a record that is newer than 13 months" "$KEPT" "$KEPT_EVENTS"
check_sql "retain left event data without its event" 0 "SELECT count(*) FROM event_data WHERE website_id = '$ROLL' AND website_event_id NOT IN (SELECT event_id FROM website_event)"
check_sql "retain kept a session with no event left" 1 "SELECT count(*) FROM session WHERE website_id = '$ROLL' AND created_at < now() - interval '13 months'"
check_sql "retain deleted a session that still has an event" 1 "SELECT count(*) FROM session WHERE session_id = '$SF'"
for table in session_data session_link session_replay revenue heatmap_event; do
    check_sql "retain kept $table rows of a deleted session" 0 "SELECT count(*) FROM $table WHERE session_id = '$SC'"
done
check_sql "retain deleted session_data of a kept session" 1 "SELECT count(*) FROM session_data WHERE session_id = '$SF'"
check_sql "retain kept an old heatmap row, or deleted a recent one" 1 "SELECT count(*) FROM heatmap_event WHERE website_id = '$ROLL'"

# The totals. A month is named by its first day.
month() { sql -c "SELECT (date_trunc('month', now() AT TIME ZONE 'UTC') - interval '$1 months')::date"; }
M15=$(month 15) M3=$(month 3) M2=$(month 2) M0=$(month 0)

# Three months ago: 22 sessions.
check_total 22 "$M3" visits all '' '' ''
check_total 22 "$M3" sessions all '' '' ''
check_total 11 "$M3" visits version 1.0.0 '' ''
check_total 11 "$M3" visits version 1.1.0 '' ''
check_total 11 "$M3" sessions country US '' ''
check_total 11 "$M3" sessions country JP '' ''
check_total 11 "$M3" sessions device desktop '' ''
check_total 11 "$M3" sessions device laptop '' ''
check_total 11 "$M3" sessions browser chrome '' ''
check_total 22 "$M3" events pageview '' '' ''
check_total 22 "$M3" events visit '' '' ''
check_total 22 "$M3" events save '' '' ''
check_total 11 "$M3" events usage '' '' ''
check_total 22 "$M3" value save.outcome 'done' '' ''
check_total 11 "$M3" value visit.version 1.0.0 '' ''
check_total 11 "$M3" number usage.undo.key '' '' ''
check_sql "the usage total and its sessions" '66|11' "SELECT total || '|' || contributors FROM nse_monthly WHERE website_id = '$ROLL' AND month = '$M3' AND metric = 'number' AND name = 'usage.undo.key'"
# Saves of 101 to 111 ms on 1.0.0 and 1001 to 1011 ms on 1.1.0.
check_time "$M3" save.took '' '' '22|556|1009|1011'
check_time "$M3" save.took 1.0.0 '' '11|106|110|111'
check_time "$M3" save.took 1.1.0 '' '11|1006|1010|1011'
check_time "$M3" save.took '' laptop '11|106|110|111'
check_time "$M3" save.took '' desktop '11|1006|1010|1011'
check_time "$M3" save.took 1.0.0 laptop '11|106|110|111'
check_time "$M3" save.took 1.1.0 desktop '11|1006|1010|1011'
check_total '' "$M3" final '' '' '' ''

# Two months ago: groups of ten are kept (the edge), a group of one is not, and neither is a single session with 30 events.
check_total 32 "$M2" visits all '' '' ''
check_total 33 "$M2" sessions all '' '' ''
check_total 10 "$M2" visits version 1.0.0 '' ''
check_total 10 "$M2" visits version mixed '' ''
check_total 11 "$M2" visits version unknown '' ''
check_total 12 "$M2" sessions version unknown '' ''
check_total '' "$M2" visits version 2.0.0 '' ''
check_total '' "$M2" visits version other '' ''
check_total '' "$M2" visits device tablet '' ''
check_total 31 "$M2" events visit '' '' ''
check_total 21 "$M2" events save '' '' ''
check_total 10 "$M2" events open '' '' ''
check_total '' "$M2" events export '' '' ''
check_total 20 "$M2" value visit.version 1.0.0 '' ''
check_total 10 "$M2" value visit.version 1.1.0 '' ''
check_total '' "$M2" value visit.version 2.0.0 '' ''
check_total 10 "$M2" value open.format other '' ''
check_total '' "$M2" value open.format sus '' ''
check_total '' "$M2" value export.outcome 'done' '' ''
check_time "$M2" save.took '' '' '21|300|300|4061'
check_time "$M2" save.took 1.0.0 '' '10|200|200|200'
check_time "$M2" save.took mixed '' '10|300|300|300'
check_time "$M2" save.took '' laptop '20|250|300|300'
check_time "$M2" save.took 1.0.0 laptop '10|200|200|200'
check_time "$M2" save.took mixed laptop '10|300|300|300'
check_time "$M2" save.took 2.0.0 '' ''
check_time "$M2" save.took other '' ''
check_time "$M2" save.took '' tablet ''
check_time "$M2" save.took '' other ''
check_time "$M2" export.took '' '' ''
check_sql "no total of 5001 or of the single session's 50" 0 "SELECT count(*) FROM nse_monthly WHERE website_id = '$ROLL' AND (p50 IN (5001, 50) OR p90 IN (5001, 50) OR p99 IN (5001, 50) OR name LIKE 'export%')"

# 15 months ago: the records are gone, the totals stay and the month is final.
check_total 11 "$M15" visits all '' '' ''
check_total 10 "$M15" visits version 1.0.0 '' ''
check_total 11 "$M15" events pageview '' '' ''
check_time "$M15" save.took '' '' '10|500|500|500'
check_total 0 "$M15" final '' '' '' ''
check_sql "the months that are final" "$M15" "SELECT month FROM nse_monthly WHERE website_id = '$ROLL' AND metric = 'final'"
check_total '' "$M0" visits all '' '' ''
check_sql "totals for this month" 0 "SELECT count(*) FROM nse_monthly WHERE website_id = '$ROLL' AND month = '$M0'"

# Text that the catalogue does not allow is not totalled, whatever its volume, and the legitimate counts stay.
SITE=$JUNK
check_total 12 "$M3" visits all '' '' ''
check_total 12 "$M3" visits browser other '' ''
check_total 12 "$M3" sessions country other '' ''
check_total 12 "$M3" visits version unknown '' ''
check_total 12 "$M3" events pageview '' '' ''
check_total 12 "$M3" events visit '' '' ''
check_total 3012 "$M3" events save '' '' ''
check_total '' "$M3" events secret '' '' ''
check_total '' "$M3" events junk1 '' '' ''
check_time "$M3" save.took '' '' '12|10|10|10'
check_sql "text that is not in the catalogue was totalled" 0 "SELECT count(*) FROM nse_monthly WHERE name ~* '(example|alice|secret|junk|email)' OR value ~* '(example|alice|secret|junk|email)' OR value ~ '^v[0-9]'"
check_sql "the rows of the website with 6000 junk events" 21 "SELECT count(*) FROM nse_monthly WHERE website_id = '$JUNK'"
SITE=$ROLL
# No row holds a session or a visit code.
check_sql "nse_monthly holds a code" 0 "SELECT count(*) FROM nse_monthly WHERE name ~* '[0-9a-f]{8}-[0-9a-f]{4}' OR value ~* '[0-9a-f]{8}-[0-9a-f]{4}'"

# A report that arrives after the first run is counted by the next: two more sessions three months ago.
sql -q -v "roll=$ROLL" -f - << 'SQL'
SET TIME ZONE 'UTC';
SELECT set_config('nse.roll', :'roll', false) \g /dev/null
DO $$
DECLARE
    roll uuid := current_setting('nse.roll')::uuid;
    s uuid;
    t timestamptz := date_trunc('month', now()) - interval '3 months' + interval '10 days' + interval '2 hours';
BEGIN
    FOR i IN 1..2 LOOP
        s := gen_random_uuid();
        INSERT INTO session (session_id, website_id, browser, os, device, country, language, created_at)
        VALUES (s, roll, 'chrome', 'Windows 10', 'laptop', 'US', 'ja', t);
        INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, hostname)
        VALUES (gen_random_uuid(), roll, s, s, t, '/', 1, 'nse.qwewqa.dev');
        WITH e AS (
            INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, event_name, hostname)
            VALUES (gen_random_uuid(), roll, s, s, t, '/', 2, 'visit', 'nse.qwewqa.dev') RETURNING event_id
        )
        INSERT INTO event_data (event_data_id, website_id, website_event_id, data_key, string_value, data_type, created_at)
        SELECT gen_random_uuid(), roll, event_id, 'version', '1.0.0', 1, t FROM e;
        WITH e AS (
            INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, event_name, hostname)
            VALUES (gen_random_uuid(), roll, s, s, t, '/', 2, 'save', 'nse.qwewqa.dev') RETURNING event_id
        )
        INSERT INTO event_data (event_data_id, website_id, website_event_id, data_key, string_value, number_value, data_type, created_at)
        SELECT gen_random_uuid(), roll, event_id, k, v, n, d, t
        FROM e, (VALUES ('outcome', 'done', NULL::numeric, 1), ('took', NULL, 111::numeric, 2)) x(k, v, n, d);
    END LOOP;
END $$;
SQL
retain
check_total 24 "$M3" visits all '' '' ''
check_total 24 "$M3" sessions all '' '' ''
check_total 13 "$M3" visits version 1.0.0 '' ''
check_time "$M3" save.took 1.0.0 '' '13|107|111|111'
check_time "$M3" save.took '' '' '24|111|1009|1011'
check_total 10 "$M15" visits version 1.0.0 '' ''
check_time "$M15" save.took '' '' '10|500|500|500'
check_sql "retain deleted a record that is newer than 13 months" "$((KEPT + 6))" "$KEPT_EVENTS"

# A second run changes nothing.
FINGERPRINT="SELECT count(*) || '|' || md5(string_agg(t::text, ',' ORDER BY t::text)) FROM nse_monthly t"
BEFORE=$(sql -c "$FINGERPRINT")
retain
check_sql "a second retain changed nse_monthly" "$BEFORE" "$FINGERPRINT"
check_sql "a second retain changed the records" "$((KEPT + 6))" "$KEPT_EVENTS"

# Umami's migrations leave the table alone: a restart runs them again.
dc restart umami > /dev/null
dc up -d --wait --wait-timeout 300 > /dev/null
check_sql "Umami's start changed nse_monthly" "$BEFORE" "$FINGERPRINT"

step "dump()"
# nightly.sh's dump itself, with the upload stubbed to copy the file. The trigger is off while a region and a city are
# put back, and nothing calls clean first: dump() has to clear them before its snapshot.
export NSE_BUCKET=contract NSE_DUMP_DIR="$WORK/dumps"
UPLOADS="$WORK/uploads"
mkdir -p "$UPLOADS"
aws() { cp "$4" "$UPLOADS/$(basename "$5")"; } # s3 cp --only-show-errors <file> <destination>
# A record that arrives late for a month already rolled up is deleted before the snapshot.
sql -c "INSERT INTO website_event (event_id, website_id, session_id, visit_id, created_at, url_path, event_type, event_name, hostname)
    SELECT gen_random_uuid(), '$ROLL', '$SF', '$SF', now() - interval '14 months', '/', 2, 'late', 'nse.qwewqa.dev'" > /dev/null
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
[ "$(sql -c "$OLD_EVENTS")" = 0 ] || fail "dump() did not apply the retention"
sql -c "ALTER TABLE session ENABLE TRIGGER nse_drop_geo" > /dev/null

step "tidy"
# A dump or a download left behind goes after two days. Other files, and newer ones, stay.
touch -d '3 days ago' "$NSE_DUMP_DIR/umami-old.dump" "$NSE_DUMP_DIR/restore.dump" "$NSE_DUMP_DIR/notes.txt"
touch -d '1 day ago' "$NSE_DUMP_DIR/umami-recent.dump"
tidy
LEFT=$(find "$NSE_DUMP_DIR" -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ')
[ "$LEFT" = 'notes.txt umami-recent.dump ' ] || fail "tidy left: $LEFT"

step "dump and restore"
docker run -d --name nse-contract-restore -e POSTGRES_PASSWORD=x -e POSTGRES_DB=umami "$POSTGRES_IMAGE" > /dev/null
# Over TCP: the image's first-run server listens only on the socket, before the database exists.
for _ in $(seq 1 30); do docker exec nse-contract-restore pg_isready -h 127.0.0.1 -U postgres -d umami > /dev/null 2>&1 && break; sleep 2; done
docker exec -i nse-contract-restore pg_restore -U postgres -d umami --no-owner --no-acl --exit-on-error < "$UPLOADS"/*.dump
for table in website website_event event_data session nse_monthly _prisma_migrations; do
    a=$(sql -c "SELECT count(*) FROM $table")
    b=$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM $table")
    [ "$a" = "$b" ] || fail "$table: $a rows, $b after the restore"
done
[ "$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM session WHERE region IS NOT NULL OR city IS NOT NULL")" = 0 ] \
    || fail "the dump holds a region or city"
[ "$(docker exec nse-contract-restore psql -U postgres -d umami -tA -c "SELECT count(*) FROM website_event WHERE created_at < now() - interval '13 months'")" = 0 ] \
    || fail "the dump holds a record older than 13 months"

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
monthly_rows=$(run_query monthly "$ROLL")
for row in "$M3|24|24|83" "$M2|32|33|94" "$M15|11|11|31" "$M3|1.0.0|13" "$M3|save.took|24|111|1009|1011"; do
    grep -qxF "$row" <<< "$monthly_rows" || fail "monthly.sql did not print the row $row. It printed:
$monthly_rows"
done
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
