# Stats

Usage statistics for the web editor: a self-hosted [Umami](https://umami.is) on one small EC2 instance. The code that sends them is in `src/analytics/`, and `docs/analytics.md` lists what is sent. This page describes how to run the server. See `../README.md` for the accounts, the set-up and the cost review.

## What runs

| Part           | Detail                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance       | Ubuntu 24.04 LTS arm64. Prod `t4g.small`, dev `t4g.micro` with 1 GB of swap. Default VPC, one public subnet, Elastic IP, IMDSv2 only                                                                                                                                                                                                                                          |
| Network        | Port 443 in, nothing else. No SSH: access is Session Manager. Certificates come from the TLS-ALPN-01 challenge on 443, so port 80 stays closed                                                                                                                                                                                                                                |
| Containers     | Caddy, Umami and PostgreSQL in Compose, each pinned by digest in `host/images.env`. PostgreSQL has no published port                                                                                                                                                                                                                                                          |
| Public paths   | `POST /api/send`, `POST /api/batch`, `GET /api/heartbeat`. Everything else is a 404. Caddy keeps no access log and no request error log (`http.log.error`), and the rest of its own log leaves out the visitor’s address and headers. Only a handler panic in Caddy could still print an address                                                                              |
| Dashboard      | Umami’s login is never routed publicly. Umami listens on the instance’s `127.0.0.1:3000`, and you reach it through a Session Manager tunnel                                                                                                                                                                                                                                   |
| Data           | One encrypted gp3 volume at `/data`: PostgreSQL, Caddy’s certificates and `secrets.env`. The volume is retained when the stack is replaced or deleted                                                                                                                                                                                                                         |
| Secrets        | `update.sh` generates Umami’s `APP_SECRET` and the database password on first boot, into `/data/secrets.env` (readable by root only), on the encrypted data volume. They are not in the repository, in GitHub or in an AWS secrets service                                                                                                                                    |
| Backups        | A weekly `pg_dump` (Sundays, 03:00 UTC) to an S3 bucket, kept 28 days. In prod the bucket is versioned, so a deleted dump is kept 7 days more, about five weeks in all. The instance can add and list dumps, not read or delete them                                                                                                                                          |
| Retention      | Raw records (events, event data, sessions and what hangs off them) are kept 13 months. `host/retention.sql` deletes older ones every night, after it has added the month’s totals to `nse_monthly`. A dump never holds a record older than that, and a dump or download left on the host is deleted after two days                                                            |
| Monthly totals | `nse_monthly`, a table of ours in the Umami database: per month, website and metric, counts, sums and percentiles with no session or visit code. It is kept for good, and the retention never deletes from it. Umami’s migrations leave it alone, and every dump includes it                                                                                                  |
| Region, city   | A trigger on Umami’s `session` table (`host/geo-trigger.sql`) sets both to NULL on every insert and update, so they are never stored. `update.sh` installs it again on every update. The nightly job and every dump also run `clean` as a backstop                                                                                                                            |
| Nightly job    | `host/nightly.sh` runs at 03:00 UTC in prod. It clears any region and city that Umami stored, adds the monthly totals and deletes the records older than 13 months, deletes dump files left on the host for more than two days, dumps on Sundays, and checks the last dump, both disks (80%) and a test event. A failed step or check sends one email through the alert topic |
| Patches        | Unattended security upgrades, rebooting at 04:00 UTC when needed                                                                                                                                                                                                                                                                                                              |
| Recovery       | EC2’s own recovery for a failed system check. In prod, one alarm reboots the instance after 5 minutes of failed instance checks and emails                                                                                                                                                                                                                                    |

The host files reach the instance by commit. The stack’s `SourceCommit` parameter becomes the tag `nse:commit`, and `update.sh` downloads `host/*` at that commit from `raw.githubusercontent.com` (the repository is public). A deploy that changes only host files does not restart the instance. `update.sh` stops Caddy and Umami before it dumps and starts them again in order: the database and Umami, then the trigger and `clean`, then Caddy. If a step fails, Caddy stays stopped, nothing is collected, and the deploy’s heartbeat check fails. Run the deploy again once the cause is fixed. The user data runs once, at the instance’s first boot.

## Deploy

**Set-up, once,** as in `../README.md`, steps 1 to 7: the accounts and profiles, the Environments with `AWS_ACCOUNT_ID`, the baseline in the account, the `nse-services` zone delegated in `qwewqa.dev`, and the account defaults. Without the delegation Caddy cannot get a certificate, and the deploy’s smoke check fails after about 5 minutes.

Run Actions › Stats deploy, choosing `dev` or `prod`. Prod waits for the maintainer’s approval and refuses any branch but `main`. The workflow assumes `nse-stats-deploy` by OIDC, runs `scripts/deploy.sh`, and ends with a smoke check: `/api/heartbeat` over HTTPS, then the database’s migrations. The same script runs by hand with a profile: `AWS_PROFILE=nse-dev SOURCE_COMMIT=<pushed sha> bash infra/stats/scripts/deploy.sh dev`. For prod: `AWS_PROFILE=nse-prod SOURCE_COMMIT=<pushed sha> MONITOR_WEBSITE=<monitor website id> bash infra/stats/scripts/deploy.sh prod`. Without `MONITOR_WEBSITE` the deploy clears it.

A failed first deploy is one of two cases. Read the stack’s status first: `aws cloudformation describe-stacks --stack-name nse-stats --query 'Stacks[0].StackStatus'`.

- **`ROLLBACK_COMPLETE`:** CloudFormation failed and rolled back, and deleted the empty volume, Elastic IP and bucket that it made (they are `RetainExceptOnCreate`). The stack never ran, and prod’s termination protection is not yet on. Delete the failed stack, fix the cause, and deploy again. In dev, run Stats dev down. In prod the deploy role cannot delete stacks, so use the admin profile: `aws cloudformation delete-stack --profile nse-prod --stack-name nse-stats`.
- **`CREATE_COMPLETE`, with the deploy failing afterwards:** the stack exists and the failure came later, at Session Manager registration, the update, the heartbeat or the migrations check. Do not delete the stack: in prod it has termination protection, and deleting it leaves its data volume, Elastic IP and bucket behind, because they are retained. Find the cause on the instance (see If a deploy fails on a permission, and `/var/log/nse-stats-init.log`), fix it, and run the deploy again. It is safe to repeat.

Try the whole cycle in dev first (see Dev below). Deploying prod, in order:

1. Run Stats deploy for `prod`. The first boot takes 5 to 10 minutes.
2. **First sign-in,** through the tunnel (see The dashboard). Sign in as `admin` / `umami` (Umami’s default login), create a new admin with a generated password kept in a password manager, and delete `admin`.
3. Create three websites in Umami, using each name as both the Name and the Domain: `nse.qwewqa.dev`, `test.nse.qwewqa.dev` and `monitor`. Then set these variables:
    - in the editor repository, the repository variables `ANALYTICS_ORIGIN` (`https://stats.nse-services.qwewqa.dev`) and `ANALYTICS_WEBSITE_PRODUCTION` (the id of `nse.qwewqa.dev`). The release build passes them to the editor as `NSE_ANALYTICS_ORIGIN` and `NSE_ANALYTICS_WEBSITE`;
    - in `qwewqa/nse-test-site`, the repository variables `ANALYTICS_ORIGIN` (the same origin) and `ANALYTICS_WEBSITE_TEST` (the id of `test.nse.qwewqa.dev`);
    - in the editor repository, the Environment variable `STATS_MONITOR_WEBSITE` on `stats-prod` (the id of `monitor`).
4. Run Stats deploy for `prod` again, so the nightly job’s test event has its website.
5. The first release tag built after the editor variables are set sends statistics. Set them only for the release that publishes the privacy page.

## The dashboard

```sh
bash infra/stats/scripts/dashboard.sh prod    # or dev; then open http://localhost:3000
```

It needs the Session Manager plugin (`../README.md`, Set-up step 3) and a profile `nse-prod` or `nse-dev`. The script finds the running instance by its `nse:service=stats` tag and forwards port 3000. If port 3000 is still busy after Ctrl+C in Git Bash, end `session-manager-plugin.exe` in Task Manager.

## Upgrades

To upgrade Umami, PostgreSQL or Caddy, open a pull request that changes a digest in `host/images.env`. Find a digest with `docker buildx imagetools inspect <image:tag>`; it must be the index digest. Read Umami’s release notes for migrations and `ANALYZE` steps first. Migrations have no down step.

1. The pull request runs `infra-check.yml`. Its contract test starts the new images and checks the request the editor sends, the clean-up, the trigger, a restore and the saved queries.
2. Deploy dev from `main`, send some events, then deploy dev from the branch. Look at the dashboard and run the saved queries. Run Stats dev down.
3. Merge and deploy prod. `update.sh` takes a dump first whenever `images.env` changed.

After a major Umami upgrade, refresh the query planner’s statistics. The nightly job does this on the next Sunday with `VACUUM (ANALYZE)`, or run it at once with `dc exec db psql -U umami -d umami -c 'VACUUM (ANALYZE)'` (see Operations for `dc`).

**A PostgreSQL major version** keeps its data in its own folder on the volume (`/data/postgres/18/docker` on the instance). Take a dump, change `POSTGRES_IMAGE`, and deploy. The new version starts an empty cluster in its own folder, and Umami creates its tables. Restore the dump into it (see Operations). The old folder stays on the volume as a rollback until you delete it.

## Operations

Some commands run from your machine and take `--profile nse-prod`. The others run on the instance. To get a shell on it, run `aws ssm start-session --profile nse-prod --target <instance id>` from your machine, then `sudo -i`. On Windows, run it in PowerShell. A shell session needs a Windows console, and the Git Bash terminal is not one. The instance id and the bucket name are outputs of the `nse-stats` stack (`aws cloudformation describe-stacks --profile nse-prod --stack-name nse-stats --query 'Stacks[0].Outputs'`). On the instance, the Compose command is:

```sh
cd /opt/nse-stats
dc() { docker compose --env-file images.env --env-file /data/secrets.env --env-file /data/stats.env "$@"; }
```

- **Take a dump now:** `/opt/nse-stats/nightly.sh dump`. It runs `clean` and `retain` first and stops without a dump if either fails.
- **Restore a dump.** The instance cannot read S3. Create a link from your machine, fetch it on the instance, and restore. `<bucket>` is the `BucketName` output.

    ```sh
    aws s3 ls s3://<bucket>/dumps/ --profile nse-prod
    aws s3 presign s3://<bucket>/dumps/<file> --expires-in 900 --profile nse-prod
    # on the instance:
    mkdir -p /data/dumps && curl -fsSL -o /data/dumps/restore.dump '<link>'
    dc stop caddy umami
    dc exec -T db pg_restore -U umami -d umami --clean --if-exists --no-owner --single-transaction \
      < /data/dumps/restore.dump \
      && dc exec -T db psql -U umami -d umami -v ON_ERROR_STOP=1 -q -1 -f - < /opt/nse-stats/geo-trigger.sql \
      && /opt/nse-stats/nightly.sh clean \
      && dc up -d umami caddy && rm /data/dumps/restore.dump
    ```

    Caddy and Umami stay stopped until the trigger is installed and `clean` has succeeded, because a dump made before the trigger existed restores the table without it, and with the region and city it held.

    The restore runs in one transaction. If it fails, the database is unchanged, Caddy and Umami stay stopped and the dump stays in `/data/dumps`. Fix the cause (a full disk, for example) and run the restore again. The nightly job deletes a dump left in `/data/dumps` after two days.

    CI tests that a dump restores into a fresh PostgreSQL with the same row counts.

- **Replace the instance** (a new image id, or a broken boot). The data volume is the only part that must survive. Umami records nothing from the moment the instance stops until the deploy ends. Do the steps in this order.
    1. Take a dump.
    2. Merge the pull request that changes the literal `ImageId` in `stats.yaml`. Do not deploy yet.
    3. Check the change set, which stops nothing: `AWS_PROFILE=nse-prod SOURCE_COMMIT=<merged sha> PLAN=1 bash infra/stats/scripts/deploy.sh prod`. It must list `Instance` with `Replacement` `True`. If it does not, stop here. Delete the change set it names with `aws cloudformation delete-change-set --profile nse-prod --stack-name nse-stats --change-set-name <name>`.
    4. Allow termination: `aws ec2 modify-instance-attribute --profile nse-prod --instance-id <id> --no-disable-api-termination`.
    5. Stop the instance (`aws ec2 stop-instances --profile nse-prod --instance-ids <id>`) and detach the data volume (`aws ec2 detach-volume --profile nse-prod --volume-id <DataVolumeId output>`). Wait until the volume is `available`.
    6. Run Stats deploy for `prod`. The new instance attaches the volume and finds its filesystem, certificates, secrets and data. CloudFormation then deletes the old instance. The Elastic IP and the DNS record do not change.

    A change to the template’s `UserData` takes effect only on a new instance, because cloud-init runs it once per instance. Make that change together with an `ImageId` change, using this procedure. On its own, a `UserData` change stops and starts the instance and changes nothing on the instance.

- **Resize the instance.** In one pull request, change the sizes in the `Sizes` mapping, `COST_PINS` and the cost table, and deploy. A new instance type stops and starts the instance, which takes a few minutes. A larger data volume grows online. Then run `resize2fs /dev/disk/by-label/nse-data` on the instance to grow the filesystem. A volume cannot shrink, and it can be modified again only six hours after the last change.
- **Replace a secret.** `APP_SECRET`: edit `/data/secrets.env`, then `dc up -d umami`. Dashboard logins end, and the day’s visitor hashes change. The database password: `dc exec db psql -U umami -c "ALTER USER umami PASSWORD '<new>'"`, edit `secrets.env`, then `dc up -d umami`.
- **Retention and monthly totals.** The nightly job runs `nightly.sh retain`, which applies `host/retention.sql` in one transaction:
    1. For every website and complete month (two days after it ends) that has no row with `metric = 'month'` in `nse_monthly`, it adds that month’s rows, with the `month` row last.
    2. It deletes the records older than 13 months, in this order: `event_data`, `website_event`, then the sessions with no event left (`created_at` older than 13 months) with their `session_data`, `session_link`, `session_replay` and `revenue` rows, and `session_replay_saved`. Umami v3.4.1 has no foreign keys (Prisma `relationMode` is `prisma`); the schema was read at that tag, in `prisma/schema.prisma` and `prisma/migrations`.

    If step 1 fails, nothing is deleted, and the nightly email says "The retention job failed." It is safe to run again, by hand with `/opt/nse-stats/nightly.sh retain`. After an Umami upgrade, the contract test fails if a table that the job deletes from is gone; add any new table that holds visits to `retention.sql`. `queries/monthly.sql` reads the totals. A month keeps at most 5000 rows of a metric, so junk sent to the public endpoint cannot grow the table.

- **Delete data.** One website: Settings › Websites › Edit › Reset Data. That does not touch `nse_monthly`. To remove a website’s totals too, run `DELETE FROM nse_monthly WHERE website_id = '<id>'` in `dc exec db psql -U umami umami`. To delete records sooner than 13 months, edit the interval in `nse_cutoff` in `retention.sql` and run `nightly.sh retain`; the months in between get their totals first.

- **A nightly email** names what failed. The checks run even after a failed step:
    - the clean-up, the retention job, the removal of old dump files, the Sunday dump or `VACUUM` failed, for example because the database is down;
    - there is no dump in S3, or the dumps could not be listed (prod);
    - the newest dump is more than 8 days old (prod);
    - the data volume (`/data`) or the root volume (`/`) is 80% full or more;
    - the test event was refused, or did not reach the database;
    - the script itself stopped with an error.

    A separate email says that `/data` is not mounted. Each email ends with a pointer to this section. The log is `journalctl -u nse-stats-nightly`.

- **If the endpoint is down,** the editor is unaffected and its events are lost until the endpoint is back.

## Dev

Dev exists only while an analytics test runs, in `nse-dev`, and is deleted completely afterwards.

1. Run Stats deploy for `dev`.
2. Run `bash infra/stats/scripts/dashboard.sh dev`, sign in as `admin` / `umami`, and create the website `local`. The dev dashboard is reachable only through the tunnel, so `admin` stays.
3. Point a dev build at it:

    ```sh
    NSE_ANALYTICS_ORIGIN=https://stats.nse-services-dev.qwewqa.dev NSE_ANALYTICS_WEBSITE=<local id> npm run dev
    ```

4. Run Stats dev down. It deletes the stack, the retained data volume, Elastic IP and bucket, then runs `scripts/leftover.sh`. “No stats resources are left.” means it worked.
5. If the check names a leftover, delete it by hand with `AWS_PROFILE=nse-dev`, then run `bash infra/stats/scripts/leftover.sh` again:
    - an instance: `aws ec2 terminate-instances --instance-ids <id>`;
    - the stack: `aws cloudformation delete-stack --stack-name nse-stats`;
    - a volume: `aws ec2 delete-volume --volume-id <id>`;
    - an Elastic IP: `aws ec2 release-address --allocation-id <id>`;
    - a bucket: `aws s3 rb s3://<bucket> --force`.

Once the repository variable `STATS_DEV_REAPER` is `on` (`../README.md`, Set-up step 8), Stats dev down also runs every six hours and deletes a stats dev stack that is over 12 hours old. With no stack, it still deletes the retained volume, Elastic IP and bucket that an interrupted run left, and checks for leftovers. It covers only stats. GitHub disables a scheduled workflow after 60 days without repository activity, so re-enable it after a long pause. The $1 budget on `nse-dev` sends an email if a dev stack is left up anyway.

A dev deploy after a Stats dev down needs a new certificate. Let’s Encrypt allows five per identical set of names a week, and after that Caddy uses ZeroSSL.

## If a deploy fails on a permission

CloudFormation cannot check some permissions before it runs. A dev deploy has passed all of these except the prod-only alarm. If a deploy fails, find the symptom here. Fix the policy in `account/account.yaml`, redeploy the baseline (`../README.md`, Set-up step 5), and deploy again.

- **`RunInstances`, `CreateVolume` or `CreateTags` is not authorized.** Look at the execution role’s statements `CreateTaggedEc2`, `UseUntaggedEc2` and `TagOnCreate`. Add the resource named in the error to the matching statement. A resource that carries no `nse:service` tag belongs in `UseUntaggedEc2`.
- **“Role … is invalid or cannot be assumed.”** Check the trust policy of `nse-stats-cfn` and the stack’s role ARN in `deploy.sh`.
- **The instance profile is refused with an `iam:PassRole` error.** Look at the condition on `PassTheInstanceRole` (`iam:PassedToService` is `ec2.amazonaws.com`). Add the service named in the error to that condition. Do not remove the condition.
- **The Route 53 record is refused.** `StatsRecords` already lists the record name with and without the trailing dot. Compare the name in the error with that list.
- **The deploy’s update command fails, or the instance never registers.** Read `/var/log/nse-stats-init.log` through Session Manager. Look for an error from the data volume’s device lookup, from `apt-get` (the Docker packages), or from `snap install aws-cli`.
- **A step of `update.sh` fails with a 404 on a host file, or Compose fails on `STATS_HOSTNAME`.** The 404 means the tag `nse:commit` is empty, and the Compose failure means `nse:hostname` is empty. The metadata service returned no tag. Check that `InstanceMetadataTags` is enabled and that the tag exists (`aws ec2 describe-tags`).
- **Prod only: the alarm is refused.** The baseline lets `nse-stats-cfn` create the service-linked role `AWSServiceRoleForCloudWatchEvents`, which the reboot action needs. If the error names another role, add it to `AlarmRebootActionRole`. The reboot alarm exists only in prod, so the first prod deploy is its first run.

## App-side work with no AWS

```sh
docker compose --env-file infra/stats/host/images.env -f infra/stats/host/compose.local.yaml up
```

Sign in at `http://localhost:3000` as `admin` / `umami`, create a website, and start the editor with `NSE_ANALYTICS_ORIGIN=http://localhost:3000 NSE_ANALYTICS_WEBSITE=<id> npm run dev`. To delete the local data, run the same command with `down -v` instead of `up`.

## Reading the numbers

- A pageview is an engaged visit: one where the user clicked, pressed a key, touched or scrolled. Loads that never interacted are not counted at all. The totals therefore undercount page loads, by design.
- Count visits from pageviews, and time spent from `visibleTime`, in seconds. Umami’s visit duration and bounce rate are wrong for this client, so ignore them.
- Umami’s unique visitors are visitors per day, because the salt rotates daily.
- The saved queries in `queries/` answer the usual questions. Each takes the website’s id:

    ```sh
    bash infra/stats/scripts/query.sh prod infra/stats/queries/commands.sql <website id>
    ```

    `visits.sql` counts visits per day by country, `commands.sql` ranks commands by use and visitors, `saves.sql` lists Save outcomes by target and reason, `startup.sql` gives startup time percentiles by navigation type and document delivery, then the restored chart sizes, `frames.sql` gives long frames per minute of visible playback by preview host and render scale, and the share it leaves out, `actions.sql` gives action time percentiles by action, target and file size, `peek.sql` counts Timeline steps by the time they took, `settings.sql` lists every setting value with its number of visits, and `monthly.sql` reads the monthly totals: visits, sessions and events a month, visits by version, and the timing percentiles. The contract test runs all of them against Umami’s real schema.

## Cost

The monthly cost of each environment, at 730 hours a month, in `us-west-2` on demand. Every price was read on 2026-10-25, from the price list file where one is named and otherwise from the page named in the Basis column. `check_templates.py` requires every billable resource type in this table and pins the sizes.

| Resource                 | Type                         | Prod, a month              | Dev, while up           | Basis                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------- | -------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EC2 instance             | `AWS::EC2::Instance`         | $12.26                     | $0.0084 an hour         | t4g.small $0.0168 an hour, t4g.micro $0.0084 (EC2 price list, published 2026-10-23). Standard credits, so no surplus-credit charge                                                                                                     |
| Root volume, 8 GB gp3    | part of `AWS::EC2::Instance` | $0.64                      | $0.0009 an hour         | gp3 $0.08 per GB-month (EC2 price list). https://aws.amazon.com/ebs/pricing/ uses the same $0.08 as an example                                                                                                                         |
| Data volume              | `AWS::EC2::Volume`           | $2.40 (30 GB)              | $0.0011 an hour (10 GB) | gp3 $0.08 per GB-month (EC2 price list). Retained, so it bills until deleted                                                                                                                                                           |
| Elastic IP               | `AWS::EC2::EIP`              | $3.65                      | $0.005 an hour          | $0.005 an hour for a public IPv4 address, in use or idle (VPC price list, published 2026-10-16; https://aws.amazon.com/vpc/pricing/). Retained                                                                                         |
| Dump bucket              | `AWS::S3::Bucket`            | under $0.15                | under $0.01             | S3 Standard $0.023 per GB-month (S3 price list, published 2026-10-15). About five dumps of up to 1 GB, and none are read                                                                                                               |
| Alarm                    | `AWS::CloudWatch::Alarm`     | $0.10                      | none                    | $0.10 per standard-resolution alarm metric a month (CloudWatch price list, published 2026-10-07; https://aws.amazon.com/cloudwatch/pricing/). The price list also shows 10 free alarm metrics, so the real charge may be $0. Prod only |
| DNS record               | `AWS::Route53::RecordSet`    | under $0.01                | under $0.01             | $0.40 per million queries (https://aws.amazon.com/route53/pricing/)                                                                                                                                                                    |
| **Stats total**          |                              | **$19.05 plus the bucket** | **$0.0154 an hour**     |                                                                                                                                                                                                                                        |
| Services zone (baseline) | `AWS::Route53::HostedZone`   | $0.50                      | $0.50 a month           | $0.50 per hosted zone (Route 53 price list, published 2026-09-11). Shared by every service, and the whole cost of dev while stats is down                                                                                              |
| **With the zone**        |                              | **about $19.70**           | **$0.50 a month down**  |                                                                                                                                                                                                                                        |

A four-hour dev test costs about $0.06. A dev stack left up for a month costs about $11. The reaper and the $1 budget are there to stop that.

Not billed at this size: data transfer (the first 100 GB a month out is free), Session Manager, the alert topic’s emails, the budget, EC2’s default recovery, the IAM roles and the default KMS key for encrypted volumes.

**A change to any of these figures** updates this table and `COST_PINS` in `check_templates.py`, with the new price and where it was read, and the pull request states the change in monthly cost. It is reviewed as `../README.md` describes.
