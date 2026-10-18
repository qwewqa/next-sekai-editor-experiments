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
