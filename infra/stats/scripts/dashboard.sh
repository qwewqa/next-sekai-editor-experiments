#!/bin/bash
# Opens Umami's dashboard for dev or prod at http://localhost:3000 through Session Manager.
# Needs the AWS CLI, the Session Manager plugin and a profile named nse-dev or nse-prod.
set -euo pipefail

ENVIRONMENT=${1:?usage: dashboard.sh dev|prod}
case "$ENVIRONMENT" in dev | prod) ;; *) echo "environment must be dev or prod" >&2; exit 2 ;; esac
PROFILE=nse-$ENVIRONMENT

if ! command -v session-manager-plugin > /dev/null; then
    echo "The Session Manager plugin is not on PATH. Install it (infra/README.md), then open a new terminal." >&2
    exit 1
fi

INSTANCE=$(aws ec2 describe-instances --profile "$PROFILE" \
    --filters Name=tag:nse:service,Values=stats Name=instance-state-name,Values=running \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)
[ -n "$INSTANCE" ] && [ "$INSTANCE" != None ] || { echo "No running stats instance in $PROFILE" >&2; exit 1; }

echo "Dashboard: http://localhost:3000 (Ctrl+C closes the tunnel)"
aws ssm start-session --profile "$PROFILE" --target "$INSTANCE" \
    --document-name AWS-StartPortForwardingSession \
    --parameters portNumber=3000,localPortNumber=3000
