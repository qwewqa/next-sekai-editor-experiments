#!/bin/bash
# Fails if a billable resource of the stats service is left in the current account (us-west-2).
# Each check below has a "billable:" marker. infra/check_templates.py requires a marker for every retained
# or long-running resource type in the stats list of reviewed types, so the two lists cannot drift.
set -euo pipefail
export AWS_DEFAULT_REGION=us-west-2

found=0
leftover() {
    echo "LEFTOVER ($1): $2"
    found=1
}

# billable: AWS::EC2::Instance
ids=$(aws ec2 describe-instances --filters Name=tag:nse:service,Values=stats Name=instance-state-name,Values=pending,running,stopping,stopped,shutting-down \
    --query 'Reservations[].Instances[].InstanceId' --output text)
[ -z "$ids" ] || leftover instance "$ids"

# billable: AWS::EC2::Volume
ids=$(aws ec2 describe-volumes --filters Name=tag:nse:service,Values=stats --query 'Volumes[].VolumeId' --output text)
[ -z "$ids" ] || leftover volume "$ids"

# billable: AWS::EC2::EIP
ids=$(aws ec2 describe-addresses --filters Name=tag:nse:service,Values=stats --query 'Addresses[].AllocationId' --output text)
[ -z "$ids" ] || leftover "Elastic IP" "$ids"

# billable: AWS::S3::Bucket
# S3 listing cannot filter by tag, so this goes by the name stats gives its buckets.
names=$(aws s3api list-buckets --query "Buckets[?starts_with(Name, 'nse-stats-')].Name" --output text)
[ -z "$names" ] || leftover bucket "$names"

# billable: stack
names=$(aws cloudformation list-stacks --query "StackSummaries[?starts_with(StackName, 'nse-stats') && StackStatus != 'DELETE_COMPLETE'].StackName" --output text)
[ -z "$names" ] || leftover stack "$names"

[ "$found" = 0 ] && echo "No stats resources are left."
exit "$found"
