#!/bin/bash
# Deploys the stats stack for dev or prod, runs update.sh on the instance, and checks the result.
# stats-deploy.yml runs it; so can the owner, with credentials for the target account.
#   SOURCE_COMMIT      the pushed commit whose infra/stats/host files the instance runs (default: HEAD)
#   MONITOR_WEBSITE    the Umami "monitor" website id; empty skips that nightly check
set -euo pipefail

ENVIRONMENT=${1:?usage: deploy.sh dev|prod}
case "$ENVIRONMENT" in dev | prod) ;; *) echo "environment must be dev or prod" >&2; exit 2 ;; esac
export AWS_DEFAULT_REGION=us-west-2
cd "$(dirname "$0")/.."

COMMIT=${SOURCE_COMMIT:-$(git rev-parse HEAD)}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
STACK=nse-stats

output() { aws cloudformation describe-stacks --stack-name "$1" --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text; }

# The default VPC's first subnet by zone name. It must not change between deploys, or the instance is replaced.
read -r SUBNET VPC ZONE < <(aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
    --query 'sort_by(Subnets,&AvailabilityZone)[0].[SubnetId,VpcId,AvailabilityZone]' --output text)
[ -n "${SUBNET:-}" ] && [ "$SUBNET" != None ] || { echo "No default subnet. Run: aws ec2 create-default-vpc" >&2; exit 1; }

aws cloudformation deploy \
    --stack-name "$STACK" \
    --template-file stats.yaml \
    --role-arn "arn:aws:iam::$ACCOUNT:role/nse-stats-cfn" \
    --capabilities CAPABILITY_NAMED_IAM \
    --no-fail-on-empty-changeset \
    --tags "nse:service=stats" "nse:env=$ENVIRONMENT" \
    --parameter-overrides \
    "Environment=$ENVIRONMENT" "SourceCommit=$COMMIT" "MonitorWebsite=${MONITOR_WEBSITE:-}" \
    "VpcId=$VPC" "SubnetId=$SUBNET" "AvailabilityZone=$ZONE" \
    "ZoneId=$(output nse-account ServicesZoneId)" "ZoneName=$(output nse-account ServicesZoneName)" \
    "AlertTopicArn=$(output nse-account AlertTopicArn)"

if [ "$ENVIRONMENT" = prod ]; then
    aws cloudformation update-termination-protection --stack-name "$STACK" --enable-termination-protection > /dev/null
fi

INSTANCE=$(output "$STACK" InstanceId)
HOST=$(output "$STACK" Hostname)

# Runs a shell command on the instance and prints its output. Fails unless it succeeds.
run_on_instance() {
    local id status out
    id=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --timeout-seconds 1200 \
        --parameters "$(printf '{"commands":["%s"]}' "$1")" --query Command.CommandId --output text)
    for _ in $(seq 1 150); do
        sleep 10
        status=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query Status --output text 2> /dev/null || echo Pending)
        case "$status" in Pending | InProgress | Delayed) continue ;; esac
        break
    done
    out=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text)
    echo "$out"
    [ "$status" = Success ] || { echo "The command ended as $status" >&2; exit 1; }
}

echo "Waiting for the instance to register with Session Manager"
for _ in $(seq 1 60); do
    ping=$(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" --query 'InstanceInformationList[0].PingStatus' --output text)
    [ "$ping" = Online ] && break
    sleep 10
done
[ "$ping" = Online ] || { echo "The instance never registered with Session Manager" >&2; exit 1; }

# The instance's own first-boot run holds a lock, so this waits for it. An Umami version change dumps first.
run_on_instance /usr/local/bin/nse-stats-update

echo "Smoke check: https://$HOST/api/heartbeat"
curl -fsS --retry 30 --retry-delay 10 --retry-all-errors "https://$HOST/api/heartbeat" | grep -q '"ok":true'

# Umami's migrations ran: none unfinished, and some applied. Prints "<unfinished>|<applied>".
migrations=$(run_on_instance "docker exec \$(docker ps -q -f label=com.docker.compose.service=db) psql -U umami -d umami -tA -c \\\"select count(*) filter (where finished_at is null), count(*) from _prisma_migrations\\\"" | head -1)
echo "Migrations (unfinished|applied): $migrations"
case "$migrations" in 0\|[1-9]*) ;; *) echo "Umami's migrations are not complete" >&2; exit 1 ;; esac
echo "Deployed $COMMIT to $ENVIRONMENT"
