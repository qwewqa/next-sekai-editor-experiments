#!/bin/bash
# Housekeeping for stats: clean, dump, check. With no argument it does the nightly job: clean; on Sundays
# a dump and VACUUM; then the checks. Any step that fails is reported in the one email, and the checks
# still run. Prod runs it from nse-stats-nightly.timer at 03:00 UTC. Dev runs it
# only by hand. Sourcing the file defines the functions and runs nothing.
set -euo pipefail

DIR=/opt/nse-stats
# CI points NSE_COMPOSE at the local Compose file; the instance uses the files in place.
dc() {
    if [ -n "${NSE_COMPOSE:-}" ]; then
        # shellcheck disable=SC2086
        $NSE_COMPOSE "$@"
    else
        docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" --env-file "$DIR/images.env" --env-file /data/secrets.env --env-file /data/stats.env "$@"
    fi
}
psql_() { dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 "$@"; }

# Umami adds a region and a city from the IP address. Only the country is kept.
clean() {
    psql_ -c "UPDATE session SET region = NULL, city = NULL WHERE region IS NOT NULL OR city IS NOT NULL;"
}

dump_stream() { dc exec -T db pg_dump -Fc -U umami umami; }

# Writes the dump to a file and lists its contents before the upload, so a failed pg_dump cannot leave a partial dump in S3.
dump() {
    local file
    file="/data/dumps/umami-$(date -u +%Y-%m-%dT%H%M%SZ).dump"
    mkdir -p /data/dumps
    dump_stream > "$file"
    dc exec -T db pg_restore --list < "$file" > /dev/null
    aws s3 cp --only-show-errors "$file" "s3://$NSE_BUCKET/dumps/$(basename "$file")"
    rm -f "$file"
}

# The listing printed None when the bucket has no dump, and error when it could not be read.
no_dump_message() {
    if [ "$1" = None ]; then
        echo "There is no dump in S3."
    else
        echo "The dumps in S3 could not be listed."
    fi
}

notified=""
# Sends the email through the alert topic. The text is printf %b input.
notify() {
    printf '%b\n' "$1" >&2
    notified=1
    aws sns publish --topic-arn "$NSE_TOPIC" --subject "nse stats $NSE_ENV: nightly job failed" --message "$(printf '%b\nRunbook: infra/stats/README.md, Operations.' "$1")" > /dev/null
}

# The argument lists the steps that already failed.
check() {
    local problems="${1:-}" newest age pct body mount
    if [ "$NSE_ENV" = prod ]; then
        newest=$(aws s3api list-objects-v2 --bucket "$NSE_BUCKET" --prefix dumps/ \
            --query 'sort_by(Contents,&LastModified)[-1].LastModified' --output text 2> /dev/null || echo error)
        if [ "$newest" = None ] || [ "$newest" = error ]; then
            # A new server has no dump until its first Sunday.
            find /data/secrets.env -mtime -8 | grep -q . || problems="$problems\n$(no_dump_message "$newest")"
        else
            age=$((($(date -u +%s) - $(date -u -d "$newest" +%s)) / 86400))
            [ "$age" -le 8 ] || problems="$problems\nThe newest dump is $age days old."
        fi
    fi
    for mount in /data /; do
        pct=$(df --output=pcent "$mount" | tail -1 | tr -dc 0-9)
        [ "$pct" -lt 80 ] || problems="$problems\nThe disk at $mount is $pct% full."
    done
    if [[ "${NSE_MONITOR_WEBSITE:-}" =~ ^[0-9a-f-]{36}$ ]]; then
        body="{\"type\":\"event\",\"payload\":{\"website\":\"$NSE_MONITOR_WEBSITE\",\"hostname\":\"monitor\",\"url\":\"/\",\"title\":\"\",\"screen\":\"1x1\",\"language\":\"en\",\"name\":\"nightly\"}}"
        curl -fsS --max-time 20 -o /dev/null --resolve "$STATS_HOSTNAME:443:127.0.0.1" \
            -H 'Content-Type: text/plain' \
            -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' \
            --data "$body" "https://$STATS_HOSTNAME/api/send" || problems="$problems\nThe test event was refused."
        [ "$(psql_ -tA -c "SELECT count(*) FROM website_event WHERE website_id = '$NSE_MONITOR_WEBSITE' AND event_name = 'nightly' AND created_at > now() - interval '10 minutes'")" -ge 1 ] \
            || problems="$problems\nThe test event did not reach the database."
    fi
    if [ -n "$problems" ]; then
        notify "$problems"
        return 1
    fi
}

# Without /data the settings file is missing too, so the alert topic comes from the instance tags.
missing_mount() {
    local token topic env
    echo "/data is not mounted" >&2
    token=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
    topic=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/nse:topic)
    env=$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/tags/instance/nse:env)
    AWS_DEFAULT_REGION=$(cut -d: -f4 <<< "$topic") aws sns publish --topic-arn "$topic" \
        --subject "nse stats $env: /data is not mounted" \
        --message "The data volume is not mounted, so Docker and stats are not running. Runbook: infra/stats/README.md, Operations." > /dev/null
}

main() {
    mountpoint -q /data || { missing_mount; exit 1; }
    set -a
    # shellcheck disable=SC1091
    . /data/stats.env
    set +a
    AWS_DEFAULT_REGION=$(cut -d: -f4 <<< "$NSE_TOPIC")
    export AWS_DEFAULT_REGION
    case "${1:-all}" in
        clean) clean ;;
        dump) dump ;;
        check) check ;;
        all)
            # An error in the script itself still sends the email.
            trap '[ "$?" = 0 ] || [ -n "$notified" ] || notify "The nightly job stopped with an error."' EXIT
            failed=""
            clean || failed="$failed\nThe clean-up failed."
            if [ "$(date -u +%u)" = 7 ]; then
                dump || failed="$failed\nThe dump failed."
                psql_ -c "VACUUM (ANALYZE)" || failed="$failed\nVACUUM failed."
            fi
            check "$failed"
            ;;
        *)
            echo "usage: nightly.sh [clean|dump|check]" >&2
            exit 2
            ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
