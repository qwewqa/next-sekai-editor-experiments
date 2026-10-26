import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const read = (name) =>
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
const pages = read('deploy-pages')
const check = read('check')
const job = (name) =>
    pages.match(new RegExp(`^    ${name}:\\n([\\s\\S]*?)(?=^    \\w+:|(?![\\s\\S]))`, 'm'))?.[1]
const condition = (name) => {
    const expression = job(name)?.match(/^ {8}if: (.+)$/m)?.[1]
    assert.ok(expression, `${name} has an explicit gate`)
    return expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
}
const allowed = (name, ref, result = 'success', cancelled = false) =>
    runInNewContext(condition(name), {
        github: { ref },
        needs: { check: { result } },
        cancelled: () => cancelled,
        startsWith: (value, prefix) => value.startsWith(prefix),
    })

test('main and PRs keep standalone checks and release validation without duplicate checks', () => {
    assert.match(check, /push:\n\s+branches: \['main', 'ci\/\*\*'\]/)
    assert.match(check, /pull_request:\n\s+branches: \['main'\]/)
    assert.match(pages, /push:\n\s+branches: \['main'\]/)
    assert.match(pages, /pull_request:\n\s+branches: \['main'\]/)
    for (const ref of ['refs/heads/main', 'refs/pull/123/merge']) {
        assert.equal(allowed('check', ref), false)
        assert.equal(allowed('build', ref, 'skipped'), true)
    }
    assert.doesNotMatch(job('build'), /test:browser/)
    assert.match(job('build'), /run: npm run test:production/)
    assert.match(job('build'), /run: npm run check:release/)
})

test('a tag requires successful checks before building and still deploys only the highest tag', () => {
    const ref = 'refs/tags/v0.6.0'
    assert.equal(allowed('check', ref), true)
    assert.match(job('check'), /uses: \.\/\.github\/workflows\/check.yml/)
    assert.match(job('build'), /needs: check/)
    assert.equal(allowed('build', ref), true)
    for (const result of ['skipped', 'failure', 'cancelled'])
        assert.equal(allowed('build', ref, result), false)
    for (const result of ['success', 'skipped'])
        for (const candidate of [ref, 'refs/heads/main', 'refs/pull/123/merge'])
            assert.equal(allowed('build', candidate, result, true), false)
    assert.match(job('build'), /if: steps.highest.outputs.deploy == 'true'/)
    assert.match(job('build'), /node scripts\/highest-tag.mjs/)
    assert.match(job('deploy'), /if: needs.build.outputs.deploy == 'true'/)
    assert.match(job('deploy'), /needs: build/)
})

test('only a version tag builds with the usage statistics target', () => {
    const vars = { ANALYTICS_ORIGIN: 'https://stats', ANALYTICS_WEBSITE_PRODUCTION: 'id' }
    const value = (name, ref) => {
        const expression = job('build')?.match(new RegExp(`^ {12}${name}: (.+)$`, 'm'))?.[1]
        assert.ok(expression, name)
        return runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
            github: { ref },
            vars,
            startsWith: (value, prefix) => value.startsWith(prefix),
        })
    }
    for (const ref of ['refs/heads/main', 'refs/pull/123/merge']) {
        assert.equal(value('NSE_ANALYTICS_ORIGIN', ref), '')
        assert.equal(value('NSE_ANALYTICS_WEBSITE', ref), '')
    }
    assert.equal(value('NSE_ANALYTICS_ORIGIN', 'refs/tags/v0.6.0'), 'https://stats')
    assert.equal(value('NSE_ANALYTICS_WEBSITE', 'refs/tags/v0.6.0'), 'id')
})

const full = read('browsers-full')
const section = (text, name) =>
    text.match(
        new RegExp(String.raw`^    ${name}:\n([\s\S]*?)(?=^    \w[\w-]*:|(?![\s\S]))`, 'm'),
    )?.[1]

test('Check cancels a superseded run on a branch or pull request, never on main or a tag', () => {
    const expression = check.match(/^ {4}cancel-in-progress: (.+)$/m)?.[1]
    assert.ok(expression)
    const cancels = (ref) =>
        runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
            github: { ref },
            startsWith: (value, prefix) => value.startsWith(prefix),
        })
    assert.equal(cancels('refs/heads/main'), false)
    assert.equal(cancels('refs/tags/v0.6.0'), false)
    assert.equal(cancels('refs/heads/ci/slim'), true)
    assert.equal(cancels('refs/pull/123/merge'), true)
    // Deploy Pages names its groups pages-*; a called workflow with the caller's group would wait on it.
    assert.match(check, /group: check-\$\{\{ github.ref \}\}/)
    assert.match(
        pages,
        /group: \$\{\{ startsWith\(github.ref, 'refs\/tags\/v'\) && 'pages-deploy' \|\| format\('pages-\{0\}', github.ref\) \}\}/,
    )
})

test('the browser jobs run beside the check job, and storage runs its core in shards', () => {
    for (const name of ['compatibility', 'compatibility-storage'])
        assert.doesNotMatch(section(check, name), /needs:/)
    // The unit suites run in a job of their own, beside the type check, lint and format check.
    assert.match(section(check, 'unit'), /- run: npm test\n/)
    assert.doesNotMatch(section(check, 'unit'), /needs:/)
    assert.doesNotMatch(section(check, 'check'), /run: npm test\n/)
    assert.match(
        section(check, 'compatibility'),
        /xvfb-run -a npx playwright test --config playwright.compatibility.config.ts .* --workers=2\n/,
    )
    const storage = section(check, 'compatibility-storage')
    assert.match(storage, /NSE_STORAGE_SET: core/)
    assert.match(storage, /fail-fast: false/)
    for (const shard of [
        'firefox\n {22}shard: 1/2',
        'firefox\n {22}shard: 2/2',
        'webkit\n {22}shard: 1/1',
    ])
        assert.match(storage, new RegExp(`engine: ${shard}`))
    assert.match(
        storage,
        /--project=\$\{\{ matrix.engine \}\}-storage --project=\$\{\{ matrix.engine \}\}-production-storage --shard=\$\{\{ matrix.shard \}\}/,
    )
    for (const [name, minutes] of [
        ['check', 15],
        ['compatibility', 30],
        ['compatibility-storage', 25],
    ])
        assert.match(section(check, name), new RegExp(`timeout-minutes: ${minutes}\n`))
})

test('every browser job runs in the Playwright image of the locked version', () => {
    const lock = JSON.parse(
        readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
    )
    const version = lock.packages['node_modules/@playwright/test'].version
    const image = `mcr.microsoft.com/playwright:v${version}-noble`
    for (const [text, name] of [
        [check, 'compatibility'],
        [check, 'compatibility-storage'],
        [check, 'formats'],
        [full, 'storage'],
        [full, 'chromium'],
    ]) {
        const body = section(text, name)
        assert.match(body, new RegExp(`(?:container|image): ${image}\n`), name)
        // Firefox needs a writable home, which a container job does not give it.
        assert.match(body, /^ {8}env:\n(?: {12}\w+: .+\n)*? {12}HOME: \/root\n/m, name)
        assert.doesNotMatch(body, /playwright install|install-browsers/, name)
    }
    // No other image, so a Playwright upgrade changes every job or fails here.
    for (const text of [check, full])
        for (const [tag] of text.matchAll(/mcr\.microsoft\.com\/playwright:\S+/g))
            assert.equal(tag, image)
    assert.equal(
        existsSync(new URL('../../scripts/ci/install-browsers.sh', import.meta.url)),
        false,
    )
})

test('browsers-full runs the whole storage set on a schedule, by hand and on ci/ branches', () => {
    assert.match(full, /workflow_dispatch:/)
    assert.match(full, /schedule:\n\s+- cron: '/)
    assert.match(full, /push:\n\s+branches: \['ci\/\*\*'\]/)
    assert.doesNotMatch(full, /NSE_STORAGE_SET/)
    assert.match(section(full, 'storage'), /timeout-minutes: 25\n/)
})

test('a scheduled browsers-full run does nothing on a commit that has already passed', () => {
    const gate = section(full, 'changed')
    assert.ok(gate)
    assert.match(gate, /actions: read/)
    assert.match(gate, /run: \$\{\{ steps.changed.outputs.run \}\}/)
    // Only a nightly can skip. A run by hand or from a push always runs.
    assert.match(gate, /if \[ "\$\{\{ github.event_name \}\}" = schedule \]/)
    // A passed run of the whole set: a nightly or a run by hand, on the same commit and not this run.
    assert.match(gate, /head_sha=\$GITHUB_SHA&status=success/)
    assert.match(gate, /\.event == "schedule" or \.event == "workflow_dispatch"/)
    assert.match(gate, /\.id != \$id/)
    for (const name of ['storage', 'chromium']) {
        const body = section(full, name)
        assert.match(body, /needs: changed\n/)
        assert.match(body, /if: \$\{\{ needs.changed.outputs.run == 'true'/)
    }
})

test('browsers-full runs its Chromium job on a schedule and by hand, not on a push', () => {
    const expression = section(full, 'chromium').match(/^ {8}if: (.+)$/m)?.[1]
    assert.ok(expression)
    const runs = (event, output = 'true') =>
        runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), {
            github: { event_name: event },
            needs: { changed: { outputs: { run: output } } },
        })
    assert.equal(runs('schedule'), true)
    assert.equal(runs('workflow_dispatch'), true)
    assert.equal(runs('push'), false)
    assert.equal(runs('schedule', 'false'), false)
    // The storage job keeps its push trigger.
    assert.doesNotMatch(section(full, 'storage'), /github.event_name/)
})

test('browsers-full runs the Chromium suite in shards and leaves the timing specs to a local check', () => {
    const chromium = section(full, 'chromium')
    assert.match(chromium, /timeout-minutes: 60\n/)
    assert.match(chromium, /fail-fast: false/)
    assert.match(
        chromium,
        /npx playwright test --project=chromium --project=chromium-worker --shard=\$\{\{ matrix.shard \}\} --workers=4\n/,
    )
    assert.match(chromium, /name: chromium-failures-\$\{\{ strategy.job-index \}\}/)
    // The shards cover the whole suite exactly once.
    const shards = chromium
        .match(/shard:\s*\[([^\]]+)\]/)?.[1]
        .split(',')
        .map((shard) => shard.trim())
        .filter(Boolean)
    assert.ok(shards)
    assert.deepEqual(
        shards,
        shards.map((_, index) => `${index + 1}/${shards.length}`),
    )
    assert.equal(shards.length, 16)
    assert.doesNotMatch(chromium, /--project=timing/)
    assert.doesNotMatch(full, /chromium-timing/)
    const rules = readFileSync(new URL('../../scripts/release/rules.mjs', import.meta.url), 'utf8')
    // A release from a branch other than main has no Browsers Full run, so it runs the whole suite locally.
    assert.match(rules, /'npm run test:browser',/)
    assert.doesNotMatch(rules, /'npm run test:timing',/)
})

test('a release needs a passed browsers-full run and says how to start one', () => {
    const tag = readFileSync(new URL('../../scripts/release/tag.mjs', import.meta.url), 'utf8')
    assert.match(tag, /\['check.yml', 'deploy-pages.yml', 'browsers-full.yml'\]/)
    assert.match(tag, /gh workflow run \$\{workflow\} --ref main/)
})
