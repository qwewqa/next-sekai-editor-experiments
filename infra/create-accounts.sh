#!/bin/bash
# The owner's one-time step, run in the Organization's management account: creates the project's two
# member accounts, nse-prod and nse-dev. Each needs an email address no other AWS account uses
# (a plus-address on one mailbox works). The addresses are passed here and never committed.
#   infra/create-accounts.sh <prod email> <dev email>
set -euo pipefail

PROD_EMAIL=${1:?usage: create-accounts.sh <prod email> <dev email>}
DEV_EMAIL=${2:?usage: create-accounts.sh <prod email> <dev email>}

create() {
    local name=$1 email=$2 id state
    id=$(aws organizations create-account --email "$email" --account-name "$name" --query CreateAccountStatus.Id --output text)
    while :; do
        state=$(aws organizations describe-create-account-status --create-account-request-id "$id" --query CreateAccountStatus.State --output text)
        [ "$state" = IN_PROGRESS ] || break
        sleep 10
    done
    [ "$state" = SUCCEEDED ] || { echo "$name: $state" >&2; exit 1; }
    echo "$name: $(aws organizations describe-create-account-status --create-account-request-id "$id" --query CreateAccountStatus.AccountId --output text)"
}

create nse-prod "$PROD_EMAIL"
create nse-dev "$DEV_EMAIL"
echo "Put each id in a ~/.aws/config profile (infra/README.md), and in the GitHub Environments as AWS_ACCOUNT_ID."
