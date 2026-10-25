// The build's usage statistics target, from NSE_ANALYTICS_ORIGIN and NSE_ANALYTICS_WEBSITE
// (docs/analytics.md). With neither set the build has none and sends nothing.

const LOOPBACK = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9.-]+(?::\d+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * `{ origin, website }` or null. Throws on half a pair, a malformed value, any target in the apps'
 * build, and a perf build's target that is not on this machine.
 */
export function analyticsFromEnv(env = process.env, { native = false, perf = false } = {}) {
    const origin = env.NSE_ANALYTICS_ORIGIN || ''
    const website = env.NSE_ANALYTICS_WEBSITE || ''
    if (!origin && !website) return null
    if (!origin || !website)
        throw new Error('Set both NSE_ANALYTICS_ORIGIN and NSE_ANALYTICS_WEBSITE, or neither')
    if (native) throw new Error('The apps do not send usage statistics')
    if (!HTTPS_ORIGIN.test(origin) && !LOOPBACK.test(origin))
        throw new Error(`NSE_ANALYTICS_ORIGIN is not an https: origin: ${origin}`)
    if (perf && !LOOPBACK.test(origin))
        throw new Error('A perf build sends usage statistics only to a loopback origin')
    if (!UUID.test(website)) throw new Error(`NSE_ANALYTICS_WEBSITE is not a UUID: ${website}`)
    return { origin, website }
}

/** The host each site's build runs on (src/analytics/config.ts has the same table). */
export const SITE_HOSTS = { production: 'nse.qwewqa.dev', test: 'test.nse.qwewqa.dev' }

/** The tag the support gate (public/gate.js) reads to send its one `unsupported` event. */
export const gateTag = (target, site) =>
    `<meta name="nse-analytics" content="${target.origin} ${target.website} ${SITE_HOSTS[site]}" />`
