# Agent guide

This file is for coding agents. Human contributors: read [CONTRIBUTING.md](CONTRIBUTING.md).

It holds only what is specific to agents. Read the project's own docs first:

- [CONTRIBUTING.md](CONTRIBUTING.md): setup, where code goes, tests, formats and releasing, and the design docs to read before you change the UI or a format.
- [docs/engineering-principles.md](docs/engineering-principles.md): how to write and review code and tests.
- [docs/writing.md](docs/writing.md): how to write user-facing text, docs, code comments and commit messages.

## Writing

- Follow `docs/writing.md` in everything you write, reports included.
- Language models overuse the patterns in its "Easy to read" section. Clark, Martin and Mahowald measured this (arXiv 2610.29162), and the effect is strongest in long chat and coding sessions.
- Before new or changed text lands, have a separate agent review the batch for those patterns and for word choice in the app’s register.
- A string change goes into all seven locales in one commit.

## Checking claims

- Verify a tool’s or another agent’s claim before you pass it on. A summarizer once reported "hidden instructions" in a paper that had none.
- Understand every test failure. Never delete a test to clear one.
- Before you call a behaviour a bug, check it against the last release. Existing charts rely on patterns such as notes on the same beat.

## Git

- Commit messages are one line, with no trailers.
- Never push or tag without the maintainer’s go-ahead.
- Never use `git stash` when worktrees share the repository. They share one stash.
- If a worktree’s `node_modules` is a link to another checkout’s, remove the link before you remove the worktree. `rm -rf`, `Remove-Item -Recurse` and `git worktree remove --force` follow the link and delete the other checkout’s packages. Do not run `npm install` or `npm ci` in such a worktree.

## Tests

- Run `TZ=UTC npm test`. CI runs in UTC, and some tests depend on the time zone.
- Run the browser specs for the area you touched, by path: `npx playwright test tests/browser/<name>.spec.ts --project=chromium`. Playwright reads a bare word as a pattern over the whole path, so it can match a folder name and run every spec.
- Run the full browser suite once per batch of changes. It is slow, and its load makes parallel runs flaky.
- Give each concurrent run its own `PLAYWRIGHT_PORT`.

## Reviews

- Report findings with a concrete scenario: what the user does and what goes wrong.
- Weigh likelihood and impact against the code a fix adds (engineering principle 9). Do not over-weight behaviour that is acceptable or arguable.

## Performance work

Follow [docs/performance-testing.md](docs/performance-testing.md).
