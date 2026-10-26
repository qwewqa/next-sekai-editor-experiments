import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
    assert.match(
        job('build'),
        /run: npm run test:browser\n\s+if: github.event_name == 'pull_request'/,
    )
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

test('every browser job installs through the stall guard', () => {
    for (const [text, name] of [
        [check, 'compatibility'],
        [check, 'compatibility-storage'],
        [full, 'storage'],
        [full, 'chromium'],
        [full, 'chromium-timing'],
    ])
        assert.match(section(text, name), /run: scripts\/ci\/install-browsers.sh /)
    const script = readFileSync(
        new URL('../../scripts/ci/install-browsers.sh', import.meta.url),
        'utf8',
    )
    assert.match(script, /for attempt in 1 2 3/)
    assert.match(script, /timeout --kill-after=10s "\$limit"/)
})

test('browsers-full runs the whole storage set on a schedule, by hand and on ci/ branches', () => {
    assert.match(full, /workflow_dispatch:/)
    assert.match(full, /schedule:\n\s+- cron: '/)
    assert.match(full, /push:\n\s+branches: \['ci\/\*\*'\]/)
    assert.doesNotMatch(full, /NSE_STORAGE_SET/)
    assert.match(section(full, 'storage'), /timeout-minutes: 25\n/)
})

test('browsers-full runs the Chromium suite in shards and the timing specs alone', () => {
    const chromium = section(full, 'chromium')
    assert.match(chromium, /timeout-minutes: 25\n/)
    assert.match(chromium, /fail-fast: false/)
    assert.match(
        chromium,
        /npx playwright test --project=chromium --project=chromium-worker --shard=\$\{\{ matrix.shard \}\} --workers=4\n/,
    )
    assert.match(chromium, /name: chromium-failures-\$\{\{ strategy.job-index \}\}/)
    // The shards cover the whole suite exactly once.
    const shards = chromium.match(/shard: \[(.+)\]/)?.[1].split(', ')
    assert.ok(shards)
    assert.deepEqual(
        shards,
        shards.map((_, index) => `${index + 1}/${shards.length}`),
    )
    assert.equal(shards.length, 6)
    assert.doesNotMatch(chromium, /--project=timing/)
    const timing = section(full, 'chromium-timing')
    assert.match(timing, /timeout-minutes: 15\n/)
    assert.doesNotMatch(timing, /matrix:|needs:/)
    assert.match(timing, /npx playwright test --project=timing --no-deps\n/)
    assert.match(timing, /name: chromium-timing-failures\n/)
})

test('a release needs a passed browsers-full run and says how to start one', () => {
    const tag = readFileSync(new URL('../../scripts/release/tag.mjs', import.meta.url), 'utf8')
    assert.match(tag, /\['check.yml', 'deploy-pages.yml', 'browsers-full.yml'\]/)
    assert.match(tag, /gh workflow run \$\{workflow\} --ref main/)
})
