# Infrastructure

The Next SEKAI Editor’s AWS services. The editor itself is static and needs none of this. These are the services around it, starting with `stats/` (usage statistics, a self-hosted Umami).

This folder is in neither the web build nor the native build, has no `package.json`, and is checked by `.github/workflows/infra-check.yml` only when it changes. Deploys are by hand and never part of a release.

## What the accounts are for

`nse-prod` and `nse-dev` are member accounts of the maintainer’s AWS Organization. They hold only the Next SEKAI Editor’s services. Another project gets its own accounts and never a stack here. Everything is in `us-west-2`.

| Where                  | What                                                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `account/account.yaml` | The baseline, deployed once per account: GitHub OIDC, the alert topic, the account budget, the services zone, and a deploy role and an execution role per service |
| `stats/`               | The first service. Its own template, host files, scripts, saved queries and runbook (`stats/README.md`)                                                           |
| `check_templates.py`   | Our rules over every template, on top of `cfn-lint`                                                                                                               |
| `create-accounts.sh`   | The one-time account creation                                                                                                                                     |

The account ids, email addresses and secrets are not in the repository. The ids are GitHub Environment variables, the email is passed on the command line, and a service’s secrets are generated on its server.

Every resource carries the tags `nse:service` (`stats`, or `shared` for the baseline) and `nse:env` (`prod` or `dev`).

## Set-up, once

The management account is touched in steps 1 and 6, and never again, however many services are added.

1. **Create the accounts**, in the management account: `bash infra/create-accounts.sh <prod email> <dev email>`, or Organizations › AWS accounts › Add an AWS account in the console. Each needs an email address that no other AWS account uses (a plus-address on one mailbox works). Put both in an OU `nse` if the Organization uses OUs.
2. **Profiles.** Without IAM Identity Center, add to `~/.aws/config` (the ids stay in this local file):

    ```ini
    [profile nse-prod]
    role_arn = arn:aws:iam::<prod account id>:role/OrganizationAccountAccessRole
    source_profile = default
    region = us-west-2
    ```

    and the same for `nse-dev`. With Identity Center, assign `AdministratorAccess` on both accounts and name the profiles the same. Every command below names its profile. The accounts’ root users are not used.

3. **Session Manager plugin,** once, for the dashboard tunnel. On Windows run the installer from `https://s3.amazonaws.com/session-manager-downloads/plugin/latest/windows/SessionManagerPluginSetup.exe`, then open a new terminal and check `session-manager-plugin`. Other systems: AWS’s page “Install the Session Manager plugin for the AWS CLI”.
4. **GitHub.** Create the Environments `stats-dev` (any branch) and `stats-prod` (the maintainer as required reviewer, deployment branch `main` only; both are free in a public repository). Each gets the variable `AWS_ACCOUNT_ID` set to its account’s id, and `stats-prod` later gets `STATS_MONITOR_WEBSITE` (`stats/README.md`). Set the repository variable `STATS_DEV_REAPER` to `on` to enable Stats dev down’s six-hourly reaper; until then it runs only by hand.
5. **Deploy the baseline** in each account, and confirm the email that SNS sends:

    ```sh
    aws cloudformation deploy --profile nse-<env> --template-file infra/account/account.yaml \
      --stack-name nse-account --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides Environment=<env> AlertEmail=<address> \
      --tags nse:service=shared nse:env=<env>
    aws cloudformation describe-stacks --profile nse-<env> --stack-name nse-account \
      --query 'Stacks[0].Outputs'
    ```

6. **Delegate the services zones,** in the management account’s `qwewqa.dev` zone, from each stack’s `ServicesZoneNameServers` output: one `NS` record named `nse-services` (prod) and one named `nse-services-dev` (dev), each with the four name servers. This is the last change in the management account. Then activate the cost allocation tags `nse:service` and `nse:env` in its Billing console (Cost allocation tags). They can take a day to appear after the first tagged resource exists.

Then `stats/README.md` deploys the first service.

## Adding a service

1. Add `infra/<service>/` with its template, scripts and runbook. It writes DNS records only under `<service>.` in the services zone.
2. Add the service to `SERVICES` in `check_templates.py` with every resource type it may create (see Cost review).
3. Add its two roles, `nse-<service>-deploy` and `nse-<service>-cfn`, to `account/account.yaml`, scoped by stack name, resource name or tag as stats’ are. Redeploy the baseline in each account with step 5.
4. Create the Environments `<service>-dev` and `<service>-prod` (step 4) and the workflows. A deploy workflow is by hand only and uses only OIDC. Only a `*-dev-down` workflow or `dev-down.sh` may delete a stack.
5. Raise the prod budget in `account.yaml` if the service needs it.

Nothing is needed in the management account.

## Cost review

Infrastructure costs money every month, so every change that can change the bill is reviewed before it merges. The review is by someone other than the author, who is given the change and the code and checks both security and cost. The change also writes down the monthly cost delta for each environment, with the price and where it was read, in the service’s cost table.

A service’s template can create roles with any permissions: `nse-<service>-cfn` may create roles named `nse-<service>-*` with any inline policy. So the review reads every IAM statement in the template. A permissions boundary would close this, and is not used.

`check_templates.py` backs this. It fails when a template creates a resource type missing from the service’s table, when a billable type is missing from the service’s runbook, and when an instance size, volume size or budget differs from the pinned values. Fix a failure by reviewing the cost, updating the runbook’s table, and then the table in the script.

**The baseline’s cost** (prices read from the AWS price list on 2026-10-25, `us-west-2`):

| Resource                           | Type                                        | Per environment, per month | Basis                                                                                                                                        |
| ---------------------------------- | ------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Services zone                      | `AWS::Route53::HostedZone`                  | $0.50                      | $0.50 per hosted zone for the first 25. Queries are $0.40 per million and negligible here                                                    |
| GitHub OIDC provider, IAM roles    | `AWS::IAM::OIDCProvider`, `AWS::IAM::Role`  | $0                         | No charge                                                                                                                                    |
| Alert topic and email subscription | `AWS::SNS::Topic`, `AWS::SNS::Subscription` | $0                         | A few emails a year                                                                                                                          |
| Budget                             | `AWS::Budgets::Budget`                      | $0                         | “You can monitor and receive notifications on your budgets free of charge” (https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/) |

Each environment’s zone is the whole idle cost of `nse-dev`, $0.50 a month, and the baseline adds nothing to a service’s own table. The budgets are $30 for prod and $1 for dev, emailing at 80% of actual and 100% of forecast.

**Cost per service** is in Cost Explorer, grouped by the `nse:service` tag, once the tags are activated (step 6).

## Checking changes

Push a branch that adds or changes `infra/` to a `ci/<name>` branch first, and get Infra check green, including the Compose job, before the change reaches `main`. The contract test cannot run without Docker, so CI is its first run.

No AWS access is needed:

```sh
uv run --with cfn-lint==1.58.0 cfn-lint infra/account/account.yaml infra/stats/stats.yaml
uv run infra/check_templates.py
shellcheck infra/create-accounts.sh infra/stats/host/*.sh infra/stats/scripts/*.sh
bash infra/stats/scripts/contract-test.sh   # needs Docker
```

`infra-check.yml` runs the same on a change under `infra/`, and runs the contract test against the real images.
