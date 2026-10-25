import assert from 'node:assert/strict'
import test from 'node:test'
import { analyticsFromEnv } from '../../scripts/analytics.mjs'

const origin = 'https://stats.nse-services.qwewqa.dev'
const website = '11111111-2222-3333-4444-555555555555'
const env = (values) => ({
    NSE_ANALYTICS_ORIGIN: origin,
    NSE_ANALYTICS_WEBSITE: website,
    ...values,
})

test('a build has a usage statistics target only with both variables', () => {
    assert.equal(analyticsFromEnv({}), null)
    assert.equal(analyticsFromEnv({ NSE_ANALYTICS_ORIGIN: '', NSE_ANALYTICS_WEBSITE: '' }), null)
    assert.deepEqual(analyticsFromEnv(env()), { origin, website })
    assert.throws(() => analyticsFromEnv(env({ NSE_ANALYTICS_WEBSITE: '' })), /both/)
    assert.throws(() => analyticsFromEnv(env({ NSE_ANALYTICS_ORIGIN: '' })), /both/)
})

test('the origin is an https: origin, or one on this machine, and the website a UUID', () => {
    for (const bad of ['http://stats.example', `${origin}/`, `${origin}/api`, 'stats.example'])
        assert.throws(
            () => analyticsFromEnv(env({ NSE_ANALYTICS_ORIGIN: bad })),
            /not an https/,
            bad,
        )
    assert.ok(analyticsFromEnv(env({ NSE_ANALYTICS_ORIGIN: 'http://localhost:3000' })))
    assert.throws(() => analyticsFromEnv(env({ NSE_ANALYTICS_WEBSITE: 'nse' })), /not a UUID/)
})

test('the apps refuse a target, and a perf build takes only one on this machine', () => {
    assert.equal(analyticsFromEnv({}, { native: true }), null)
    assert.throws(() => analyticsFromEnv(env(), { native: true }), /apps/)
    assert.throws(() => analyticsFromEnv(env(), { perf: true }), /loopback/)
    const loopback = env({ NSE_ANALYTICS_ORIGIN: 'http://127.0.0.1:5361' })
    assert.ok(analyticsFromEnv(loopback, { perf: true }))
})
