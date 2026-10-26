# Infrastructure

The Next SEKAI Editor’s AWS services. The editor itself is static and needs none of this. These are the services around it, starting with `stats/` (usage statistics, a self-hosted Umami).

This folder is in neither the web build nor the native build, and has no `package.json`. Its checks run in `.github/workflows/infra-check.yml`, only when `infra/` or an infra workflow changes, or by hand. Deploys are by hand and never part of a release.

## What the accounts are for

`nse-prod` and `nse-dev` are member accounts of the maintainer’s AWS Organization. They hold only the Next SEKAI Editor’s services. Another project gets its own accounts, and none of its stacks go here. Everything is in `us-west-2`.

| Where                  | What                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account/account.yaml` | The baseline, deployed once per account and again when a service is added: GitHub OIDC, the alert topic, the account budget, the services zone, and a deploy role and an execution role per service |
| `stats/`               | The first service, with its own template, host files, scripts, saved queries and runbook (`stats/README.md`)                                                                                        |
| `check_templates.py`   | The rules we check on every template, the host files, the workflows and `leftover.sh`, in addition to `cfn-lint`                                                                                    |
| `create-accounts.sh`   | The one-time account creation                                                                                                                                                                       |

The account ids, email addresses and secrets are not in the repository. The ids are GitHub Environment variables, the email is passed on the command line, and a service generates its secrets on its own server.

Every resource that takes tags carries `nse:service` (`stats`, or `shared` for the baseline) and `nse:env` (`prod` or `dev`).

## Set-up, once

Only steps 1 and 6 touch the management account. It is never touched again, however many services are added.

**On Windows,** run the `bash` and `aws` commands in Git Bash (Git for Windows), not in PowerShell or cmd. There, `bash` can be WSL’s, and the `NAME=value command` form does not work. Install the AWS CLI version 2 as well; `uv` runs the checks (see Checking changes).

1. **Create the accounts**, in the management account: `bash infra/create-accounts.sh <prod email> <dev email>`, or Organizations › AWS accounts › Add an AWS account in the console. Each needs an email address that no other AWS account uses (a plus-address on one mailbox works). Put both in an OU `nse` if the Organization uses OUs.
2. **Profiles** named `nse-prod` and `nse-dev`. Without IAM Identity Center, add to `~/.aws/config` (on Windows, `C:\Users\<you>\.aws\config`; the ids stay in this local file):

    ```ini
    [profile nse-prod]
    role_arn = arn:aws:iam::<prod account id>:role/OrganizationAccountAccessRole
    source_profile = default
    region = us-west-2
    ```

    and the same for `nse-dev`. `source_profile = default` means the profile signs in with your `default` credentials, which are for the management account. Organizations creates `OrganizationAccountAccessRole` in each new account, and it gives administrator access. With Identity Center, assign `AdministratorAccess` on both accounts instead and give the profiles the same names. The accounts’ root users are not used. The commands below that run in a member account take `--profile nse-<env>`.

3. **Session Manager plugin,** once, for the dashboard tunnel. On Windows run the installer from `https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe`, then open a new terminal and check `session-manager-plugin`. Other systems: AWS’s page “Install the Session Manager plugin for the AWS CLI”.
4. **GitHub.** Create the Environments `stats-dev` (any branch) and `stats-prod` (the maintainer as required reviewer, deployment branch `main` only). Environment rules are free in a public repository. Each Environment gets the variable `AWS_ACCOUNT_ID`, set to the id of its account. `stats-prod` gets `STATS_MONITOR_WEBSITE` later (`stats/README.md`, Deploy). The deploy roles trust the repository by GitHub’s immutable OIDC subject, `repo:<owner>@<owner id>/<name>@<repository id>:environment:<Environment>`, written in `account/account.yaml`. In a fork, `gh api repos/<owner>/<name>/actions/oidc/customization/sub` prints its prefix.
5. **Deploy the baseline** in each account:

    ```sh
    aws cloudformation deploy --profile nse-<env> --template-file infra/account/account.yaml \
      --stack-name nse-account --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides Environment=<env> AlertEmail=<address> \
      --tags nse:service=shared nse:env=<env>
    aws cloudformation describe-stacks --profile nse-<env> --stack-name nse-account \
      --query 'Stacks[0].Outputs'
    ```

    AWS then emails a subscription message to the alert address. Confirm it in that email, or the alerts are not delivered.

6. **Delegate the services zones,** in the management account’s `qwewqa.dev` zone, from each stack’s `ServicesZoneNameServers` output: one `NS` record named `nse-services` (prod) and one named `nse-services-dev` (dev), each with the four name servers. This is the last change in the management account. Then activate the cost allocation tags `nse:service` and `nse:env` in its Billing console (Cost allocation tags). They can take a day to appear after the first tagged resource exists.
7. **Optional: the dev reaper.** Once the baseline and the `stats-dev` Environment exist, set the repository variable `STATS_DEV_REAPER` to `on` (Settings › Secrets and variables › Actions › Variables). Stats dev down then also runs every six hours and deletes a stats dev stack that is over 12 hours old. Without the variable it runs only by hand.

Then follow `stats/README.md` to deploy the first service.

## Adding a service

1. Add `infra/<service>/` with its template, scripts and runbook. It writes DNS records only under `<service>.` in the services zone.
2. Add the service to `SERVICES` in `check_templates.py` with every resource type its template may create (see Cost review).
3. Add its two roles, `nse-<service>-deploy` and `nse-<service>-cfn`, to `account/account.yaml`, scoped by stack name, resource name or tag as the stats roles are. Redeploy the baseline in each account (Set-up, step 5).
4. Create the Environments `<service>-dev` and `<service>-prod` (Set-up, step 4) and the workflows. A deploy workflow runs by hand only and uses only OIDC. Only a `*-dev-down` workflow or `dev-down.sh` may delete a stack.
5. Raise the prod budget in `account.yaml` if the service needs it.

Nothing is needed in the management account.

## Cost review

Infrastructure costs money every month, so someone other than the author reviews every change that can change the bill, before it merges. The reviewer gets the change and the code, and checks both security and cost. The change updates the service’s cost table (each environment’s monthly cost, each price and where it was read), and the pull request states the change in monthly cost.

A service’s template can create roles with any permissions: `nse-<service>-cfn` may create roles named `nse-<service>-*` with any inline policy. The reviewer therefore reads every IAM statement in the template. A permissions boundary would close this, and is not used.

`check_templates.py` fails when a template creates a resource type missing from the service’s list of reviewed types, when a billable type is missing from the service’s cost table, and when an instance size, a volume size or a budget differs from its pinned value. To fix a failure, review the cost, update the cost table in the runbook, and then the list in the script.

**The baseline’s cost** (`us-west-2`, prices read from the AWS price list on 2026-10-25):

| Resource                           | Type                                        | Per environment, per month | Basis                                                                                                                                        |
| ---------------------------------- | ------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Services zone                      | `AWS::Route53::HostedZone`                  | $0.50                      | $0.50 per hosted zone for the first 25. Queries are $0.40 per million and negligible here                                                    |
| GitHub OIDC provider, IAM roles    | `AWS::IAM::OIDCProvider`, `AWS::IAM::Role`  | $0                         | No charge                                                                                                                                    |
| Alert topic and email subscription | `AWS::SNS::Topic`, `AWS::SNS::Subscription` | $0                         | A few emails a year                                                                                                                          |
| Budget                             | `AWS::Budgets::Budget`                      | $0                         | “You can monitor and receive notifications on your budgets free of charge” (https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) |

Each environment’s zone costs $0.50 a month. For `nse-dev` that is the whole cost while stats is down. The baseline adds nothing to a service’s own cost table. The budgets are $30 for prod and $1 for dev. Each sends an email at 80% of actual cost and at 100% of forecast cost.

**Cost per service** is in Cost Explorer, grouped by the `nse:service` tag, once the tags are activated (Set-up, step 6).

## Checking changes

Push a branch that adds or changes `infra/` to a `ci/<name>` branch first, and get Infra check green, including the `stats-compose` job, before the change reaches `main`. The contract test cannot run without Docker, so CI is its first run.

No AWS access is needed for these:

```sh
uv run --with cfn-lint==1.58.0 cfn-lint infra/account/account.yaml infra/stats/stats.yaml
uv run infra/check_templates.py
shellcheck infra/create-accounts.sh infra/stats/host/*.sh infra/stats/scripts/*.sh
bash infra/stats/scripts/contract-test.sh   # needs Docker, curl, jq and Linux
```

On Windows, run these in Git Bash and use `uv run --with shellcheck-py shellcheck …` for the third. The contract test reads `/proc` and mounts Linux paths, so it does not run in Git Bash. Run it in CI, or in WSL 2 with Docker.

`infra-check.yml` runs the same when `infra/`, `src/analytics/` or an infra workflow changes. Its `stats-compose` job runs the contract test against the real images.
