#!/bin/bash
# Runs on the instance as root: at first boot (from the user data) and on every deploy (through SSM).
# /usr/local/bin/nse-stats-update fetches this file at the commit in the instance's nse:commit tag
# and pipes it to bash, with NSE_REPO set. Safe to run again at any time.
set -euo pipefail

exec 9> /run/nse-stats-update.lock
flock 9

imds() {
    local token
    token=$(curl -fsS --retry 5 --retry-all-errors -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
    curl -fsS --retry 5 --retry-all-errors -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1"
}
tag() { imds "tags/instance/$1" 2> /dev/null || true; }

# Without the data volume, Compose would start a new empty database on the root volume.
mountpoint -q /data || { echo "/data is not mounted" >&2; exit 1; }

DIR=/opt/nse-stats
COMMIT=$(tag nse:commit)
ENVIRONMENT=$(tag nse:env)
BASE="https://raw.githubusercontent.com/$NSE_REPO/$COMMIT/infra/stats/host"
FILES="compose.yaml images.env Caddyfile nightly.sh nse-stats-nightly.service nse-stats-nightly.timer"

mkdir -p "$DIR/new" /data/caddy /data/postgres
for f in $FILES; do curl -fsSL --retry 5 -o "$DIR/new/$f" "$BASE/$f"; done

# Secrets are made once, on the encrypted data volume. Hex keeps them safe in a URL.
if [ ! -f /data/secrets.env ]; then
    (
        umask 077
        printf 'POSTGRES_PASSWORD=%s\nAPP_SECRET=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > /data/secrets.env
    )
fi
(
    umask 077
    cat > /data/stats.env << ENV
STATS_HOSTNAME=$(tag nse:hostname)
NSE_ENV=$ENVIRONMENT
NSE_BUCKET=$(tag nse:bucket)
NSE_TOPIC=$(tag nse:topic)
NSE_MONITOR_WEBSITE=$(tag nse:monitor-website)
ENV
)

dc() { docker compose --project-directory "$1" -f "$1/compose.yaml" --env-file "$1/images.env" --env-file /data/secrets.env --env-file /data/stats.env "${@:2}"; }

# Refuse a file Compose cannot read before it replaces the running one.
dc "$DIR/new" config --quiet

# Migrations have no down step, so a dump comes first whenever an image changes.
if [ -f "$DIR/images.env" ] && ! cmp -s "$DIR/images.env" "$DIR/new/images.env" && [ -n "$(dc "$DIR" ps -q db 2> /dev/null)" ]; then
    "$DIR/nightly.sh" dump
fi

for f in $FILES; do install -m 0644 "$DIR/new/$f" "$DIR/$f"; done
chmod 0755 "$DIR/nightly.sh"
install -m 0644 "$DIR/nse-stats-nightly.service" "$DIR/nse-stats-nightly.timer" /etc/systemd/system/
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\nMaxRetentionSec=2week\n' > /etc/systemd/journald.conf.d/nse-stats.conf
systemctl restart systemd-journald
# Docker, and so the containers, never start before /data is mounted.
mkdir -p /etc/systemd/system/docker.service.d
printf '[Unit]\nRequiresMountsFor=/data\n' >/etc/systemd/system/docker.service.d/nse-data.conf
systemctl daemon-reload
systemctl enable --now docker
if [ "$ENVIRONMENT" = prod ]; then
    systemctl enable --now nse-stats-nightly.timer
else
    systemctl disable --now nse-stats-nightly.timer 2> /dev/null || true
fi

# The small dev instance has 1 GB of memory.
if [ "$ENVIRONMENT" = dev ] && [ ! -f /swapfile ]; then
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

dc "$DIR" pull --quiet
dc "$DIR" up -d --remove-orphans

# Wait for Umami to report healthy, which includes its migrations.
status=""
for _ in $(seq 1 60); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$(dc "$DIR" ps -q umami)" 2> /dev/null || true)
    [ "$status" = healthy ] && break
    sleep 5
done
[ "$status" = healthy ] || { echo "Umami is ${status:-missing}" >&2; exit 1; }
docker image prune -f > /dev/null
echo "stats is up at $COMMIT"
