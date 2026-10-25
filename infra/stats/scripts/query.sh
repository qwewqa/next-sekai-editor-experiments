#!/bin/bash
# Runs a saved query on the stats instance and prints the result. PostgreSQL has no public or published
# port, so the SQL goes to the instance through Session Manager and runs in the database container.
#   infra/stats/scripts/query.sh <dev|prod> <file.sql> <website id>
# Needs the AWS CLI and a profile named nse-dev or nse-prod. The output is cut at 24,000 characters.
set -euo pipefail

ENVIRONMENT=${1:?usage: query.sh dev|prod file.sql website-id}
FILE=${2:?usage: query.sh dev|prod file.sql website-id}
WEBSITE=${3:?usage: query.sh dev|prod file.sql website-id}
case "$ENVIRONMENT" in dev | prod) ;; *) echo "environment must be dev or prod" >&2; exit 2 ;; esac
[[ "$WEBSITE" =~ ^[0-9a-f-]{36}$ ]] || { echo "the website id is a UUID" >&2; exit 2; }
export AWS_PROFILE=nse-$ENVIRONMENT AWS_DEFAULT_REGION=us-west-2

INSTANCE=$(aws ec2 describe-instances --filters Name=tag:nse:service,Values=stats Name=instance-state-name,Values=running \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)
SQL=$(base64 < "$FILE" | tr -d '\n')
COMMAND="echo $SQL | base64 -d | docker exec -i \$(docker ps -q -f label=com.docker.compose.service=db) psql -U umami -d umami -v website=$WEBSITE"

ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
    --parameters "{\"commands\":[\"$COMMAND\"]}" --query Command.CommandId --output text)
for _ in $(seq 1 30); do
    sleep 3
    STATUS=$(aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2> /dev/null || echo Pending)
    case "$STATUS" in Pending | InProgress | Delayed) continue ;; esac
    break
done
aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query StandardOutputContent --output text
[ "$STATUS" = Success ] || { aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query StandardErrorContent --output text >&2; exit 1; }
