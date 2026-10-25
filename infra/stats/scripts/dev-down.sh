#!/bin/bash
# Deletes the stats dev stack and everything it retained, then runs the leftover check.
# Only stats: the baseline, the services zone and any other service in the account stay.
#   --reaper   a scheduled run: exit unless the stack exists and is over 12 hours old
# AWS_ACCOUNT_ID must be the dev account's id. Run by stats-dev-down.yml, or by hand.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2
cd "$(dirname "$0")"

STACK=nse-stats
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
[ "$ACCOUNT" = "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID to the dev account id}" ] \
    || { echo "Refusing: these credentials are for account $ACCOUNT, not $AWS_ACCOUNT_ID" >&2; exit 1; }

created=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].CreationTime' --output text 2> /dev/null || echo none)
if [ "$created" != none ]; then
    env=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Tags[?Key=='nse:env'].Value" --output text)
    [ "$env" = dev ] || { echo "Refusing: the stack's nse:env tag is '$env', not dev" >&2; exit 1; }
    if [ "${1:-}" = --reaper ] && [ $(($(date -u +%s) - $(date -u -d "$created" +%s))) -lt 43200 ]; then
        echo "The dev stack is under 12 hours old."
        exit 0
    fi
    aws cloudformation delete-stack --stack-name "$STACK" --role-arn "arn:aws:iam::$ACCOUNT:role/nse-stats-cfn"
    aws cloudformation wait stack-delete-complete --stack-name "$STACK"
elif [ "${1:-}" = --reaper ]; then
    echo "There is no dev stack."
    exit 0
fi

# Retained by the template, so deleted here. The dev bucket is unversioned, so --force empties it.
for bucket in $(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'nse-stats-')].Name" --output text); do
    aws s3 rb "s3://$bucket" --force
done
for volume in $(aws ec2 describe-volumes --filters Name=tag:nse:service,Values=stats --query 'Volumes[].VolumeId' --output text); do
    aws ec2 wait volume-available --volume-ids "$volume"
    aws ec2 delete-volume --volume-id "$volume"
done
for allocation in $(aws ec2 describe-addresses --filters Name=tag:nse:service,Values=stats --query 'Addresses[].AllocationId' --output text); do
    aws ec2 release-address --allocation-id "$allocation"
done

./leftover.sh
