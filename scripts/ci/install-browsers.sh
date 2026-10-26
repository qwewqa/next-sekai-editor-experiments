#!/usr/bin/env bash
# Installs Playwright browsers and their system packages on a CI runner: install-browsers.sh firefox webkit
# An apt mirror sometimes stalls at a few kB/s, so each try is cut off after NSE_INSTALL_TIMEOUT
# (default 6m) and the install tries three times. A cut-off try can leave apt holding the dpkg lock,
# so the script frees the lock between tries.
set -u

limit="${NSE_INSTALL_TIMEOUT:-6m}"

free_dpkg_lock() {
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
}

for attempt in 1 2 3; do
    start=$SECONDS
    if timeout --kill-after=10s "$limit" npx playwright install --with-deps "$@"; then
        echo "Browsers installed on try $attempt in $((SECONDS - start)) s."
        exit 0
    fi
    echo "Browser install try $attempt failed or timed out after $((SECONDS - start)) s."
    [ "$attempt" -lt 3 ] && free_dpkg_lock
done
exit 1
