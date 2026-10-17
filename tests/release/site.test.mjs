import assert from 'node:assert/strict'
import test from 'node:test'
import { applyTestSite, isTestSitePage, siteFromEnv, testTitlePrefix } from '../../scripts/site.mjs'

const page = '<html><head lang="en"><meta charset="UTF-8" /><title>Editor</title></head></html>'

test('the test site is not indexed and its title is prefixed', () => {
    const out = applyTestSite(page)
    assert.match(out, /<head lang="en">\s*<meta name="robots" content="noindex" \/>/)
    assert.ok(out.includes(`<title>${testTitlePrefix}Editor</title>`))
    assert.equal(isTestSitePage(out), true)
    assert.equal(isTestSitePage(page), false)
    assert.throws(() => applyTestSite('<html></html>'))
})

test('NSE_SITE is production or test', () => {
    assert.equal(siteFromEnv({}), 'production')
    assert.equal(siteFromEnv({ NSE_SITE: '' }), 'production')
    assert.equal(siteFromEnv({ NSE_SITE: 'test' }), 'test')
    assert.throws(() => siteFromEnv({ NSE_SITE: 'staging' }), /Unknown NSE_SITE/)
})
