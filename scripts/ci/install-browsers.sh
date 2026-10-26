#!/usr/bin/env bash
# Installs Playwright browsers and their system packages on a CI runner: install-browsers.sh firefox webkit
# An apt mirror sometimes stalls at about 70 kB/s, so each try is cut off after NSE_INSTALL_TIMEOUT
# (default 6m) and the install tries three times. Packages already downloaded are kept. A retry takes
# its packages from another mirror, because apt moves to the next one only when a mirror fails, not
# when it is slow. A cut-off try can leave apt holding the dpkg lock, so the script frees it first.
set -u

limit="${NSE_INSTALL_TIMEOUT:-6m}"
mirrors=/etc/apt/apt-mirrors.txt
# fallbacks[n] is the mirror for try n + 1; try 1 uses the runner's own, azure.archive.ubuntu.com.
fallbacks=("" "https://archive.ubuntu.com/ubuntu/" "http://mirrors.edge.kernel.org/ubuntu/")

prepare_retry() {
    sudo pkill -KILL -x apt-get || true
    sudo pkill -KILL -x apt || true
    sudo pkill -KILL -x dpkg || true
    for _ in $(seq 1 30); do
        sudo fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || break
        sleep 1
    done
    # Anything still holding the lock is killed, then an interrupted dpkg run is finished.
    sudo fuser -k -KILL /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1 || true
    sudo dpkg --configure -a || true
    local list
    list=$(mktemp)
    if [ -n "${fallbacks[$1]}" ] && [ -f "$mirrors" ]; then
        # The runner's own list stays below it, for the security pocket.
        { printf '%s\tpriority:1\n' "${fallbacks[$1]}"; sed 's/priority:[0-9]*/priority:9/' "$mirrors"; } >"$list"
        sudo cp "$list" "$mirrors"
        echo "Using ${fallbacks[$1]} for the next try."
    fi
}

for attempt in 1 2 3; do
    start=$SECONDS
    if timeout --kill-after=10s "$limit" npx playwright install --with-deps "$@"; then
        echo "Browsers installed on try $attempt in $((SECONDS - start)) s."
        exit 0
    fi
    echo "Browser install try $attempt failed or timed out after $((SECONDS - start)) s."
    [ "$attempt" -lt 3 ] && prepare_retry "$attempt"
done
exit 1
