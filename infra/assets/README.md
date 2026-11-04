# Asset store

Each Pages deploy replaces the whole site. A tab that is still running an older build then gets a 404 when it loads lazy code, such as Export Video, that it has not loaded yet. The asset store keeps the hashed files under `assets/` of earlier builds in an S3 bucket, and each deploy puts them back on the site for a while. The test site uses it; production does not yet. See `../README.md` for the accounts, the set-up and the cost review.

## The rule

A file that a deploy stops using stays on the site until at least 7 days after that deploy went live. Files leave only at a deploy, so a long gap between deploys never drops anything: the live release’s files are always kept.

## How a deploy uses it

The bucket is `nse-assets-<account id>` in `nse-dev`. Each site has a prefix: `test/` holds `test/assets/<name>` for every stored file and `test/index.json`, the only state. The index lists each file’s SHA-256, size and the last time it was on the live site (`lastLive`), the files that may be live now (`live`), and the release a deploy has staged but not recorded (`next`).

`scripts/asset-store.mjs` runs in the test site’s workflow:

- **`prepare`,** before `check:release`. The files to keep are `live`, an unrecorded `next` (it may have gone live), and every file whose `lastLive` is within 7 days. Those the new build lacks are downloaded, checked against their SHA-256, added to `dist/assets/` and listed in the manifest’s `retained`. The build’s own new files are uploaded, and the build is staged as `next`.
- **`record`,** after a successful publish. Everything in `live` and `next` gets the current time as `lastLive`, and `next` becomes `live`. Files not live whose `lastLive` is more than 7 days old are deleted, and their entries leave the index.

A failed or cancelled publish leaves `next` in place, so the next deploy keeps both releases. A stored file is never replaced: every upload is conditional on the name being free, the bucket policy refuses any other, and a name already stored with other bytes fails the deploy.

When `prepare` fails, nothing is published: a missing, invalid or changed index, a stored file that does not match its hash, or a name with other bytes stops the deploy before the upload to Pages. When `record` fails, the build has already been published, so a red run can be live. The next deploy keeps both that build and the one before it, and a failed delete is tried again at the next `record`.

## Set-up

The test site’s workflow runs from the `main` branch of `qwewqa/nse-test-site`, and the role trusts only that branch (`refs/heads/main`). A change to the workflow, including the one that adds the store’s steps, takes effect once it is pushed to `main`. Push it after the steps below, so that the first deploy finds the stack, the variable and the index.

In Git Bash, from a checkout of the editor’s `main`:

1. Deploy the stack:

    ```sh
    aws cloudformation deploy --profile nse-dev --template-file infra/assets/assets.yaml \
      --stack-name nse-assets --capabilities CAPABILITY_NAMED_IAM \
      --parameter-overrides Environment=dev --tags nse:service=assets nse:env=dev
    ```

2. In `qwewqa/nse-test-site`, give the `github-pages` Environment the variable `AWS_ACCOUNT_ID`, set to the id of `nse-dev`.
3. Stop deploys (see One writer at a time) and create the index from the live site:

    ```sh
    AWS_PROFILE=nse-dev node scripts/asset-store.mjs seed --bucket nse-assets-<dev id> --origin https://test.nse.qwewqa.dev
    ```

    It reads the live `release-manifest.json`, downloads every file under `assets/` that it lists as current or retained, checks each against its SHA-256, stores them, and writes the index. It prints the release’s version and commit; check them against the last successful deploy run. Then start deploys again.

## One writer at a time

Only one writer may use the store at a time. The test site’s workflow is the only writer. Its concurrency group `pages` runs deploys one after another, and no other workflow in that repository may use the `github-pages` Environment.

Anything done by hand, such as `seed`, runs only while deploys are stopped:

1. `gh workflow disable deploy.yml -R qwewqa/nse-test-site`
2. List the unfinished runs. `--all` is needed to select a disabled workflow:

    ```sh
    gh run list -R qwewqa/nse-test-site --workflow deploy.yml --all --limit 100 \
      --json databaseId,status --jq '[.[] | select(.status != "completed")]'
    ```

3. The output must be `[]`. If it lists runs, let them finish or cancel them (`gh run cancel <id> -R qwewqa/nse-test-site`), and list again. If the command fails, stop: you cannot tell whether a deploy is running.
4. Do the work, then `gh workflow enable deploy.yml -R qwewqa/nse-test-site`.

## Recovery

All of these run with deploys stopped.

- **The index is lost:** run `seed` as in Set-up. The files on the live site stay protected. A deploy cannot always say that the index is missing: the role may list only `test/assets/`, so S3 can answer `AccessDenied` instead of `NoSuchKey`. Check with `aws s3 ls --profile nse-dev s3://nse-assets-<dev id>/test/index.json`.
- **The index is broken** (a deploy says it is invalid): run `seed` with `--replace`. It replaces the index without reading it. Stored files that are not on the live site lose their entries and are no longer kept.
- **After a deploy with `skip_store`** (the test site workflow’s input that deploys without the store): the older files left the site with that deploy, and the store does not know its files. The next normal deploy puts the older files that are still within their 7 days back, and that deploy removes the skipped build’s files. To keep the skipped build’s files instead, run `seed --replace` before the next deploy; that drops the older entries.
- **Resetting protection** on purpose: write `{"version":1,"live":[],"next":null,"assets":{}}` over `test/index.json`. The next deploy then removes every older file from the site.

**Stray objects.** A prepare stopped between an upload and its index write leaves an object that the index does not list. It is never downloaded, and a build with the same file adopts it. To list them, compare `aws s3 ls --profile nse-dev s3://nse-assets-<dev id>/test/assets/` with the names in the index.

## What the role trusts

`nse-assets-pages` can read, add and delete files under `test/` only. It trusts nse-test-site’s `github-pages` Environment on `main`, by GitHub’s immutable subject. The `ref` condition is the workflow’s branch in nse-test-site, not the editor commit that the run builds.

The whole deploy job can request the role, not only the store’s steps. The editor commit chosen when the workflow runs and its locked dependencies are therefore trusted with the test site’s store, as they already are with the test site itself.

## Cost

The monthly cost in `us-west-2`, for about 5 test deploys a day, each changing about 3 MB of `assets/` (about 32 files). Prices were read on 2026-11-03 from the AWS price list files for S3 (published 2026-10-15) and for data transfer (published 2026-11-03).

| Resource                        | Type              | A month         | Basis                                                                                                             |
| ------------------------------- | ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Stored files                    | `AWS::S3::Bucket` | under $0.01     | S3 Standard $0.023 per GB-month. About 110 MB: the live build’s 6 MB and 7 days of changed files                  |
| Downloads                       | `AWS::S3::Bucket` | $0.07           | GET $0.0004 per 1,000. About 1,100 kept files per deploy, 150 deploys                                             |
| Uploads, index writes, listings | `AWS::S3::Bucket` | $0.03           | PUT, COPY, POST and LIST $0.005 per 1,000. About 36 per deploy. Deletes are free                                  |
| Transfer to GitHub’s runners    | `AWS::S3::Bucket` | $0              | About 16 GB, inside the 100 GB a month that is free across the Organization. Beyond it, $0.09 per GB, about $1.45 |
| **Total**                       |                   | **about $0.11** | **About $1.55** if the free transfer is used up elsewhere                                                         |

On GitHub, the site grows from about 27 MB to about 135 MB, well under the 1 GB Pages limit, which `check:release` enforces. Kept files are fetched only by tabs on older builds.
