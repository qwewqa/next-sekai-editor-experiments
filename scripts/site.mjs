// English-only constants for the test site (`site.testTitle`); not locale keys.
export const testTitlePrefix = 'Test - '

/** The site a build is for: `NSE_SITE=test` for the test site, else production. */
export function siteFromEnv(env = process.env) {
    const site = env.NSE_SITE || 'production'
    if (site !== 'production' && site !== 'test') throw new Error(`Unknown NSE_SITE: ${site}`)
    return site
}

/** The test site's page: not indexed, and the title prefixed. */
export function applyTestSite(html) {
    if (!/<title>/.test(html) || !/<head(?:\s[^>]*)?>/i.test(html))
        throw new Error('The page has no <head> and <title>')
    return html
        .replace('<title>', `<title>${testTitlePrefix}`)
        .replace(
            /<head(?:\s[^>]*)?>/i,
            (head) => `${head}\n        <meta name="robots" content="noindex" />`,
        )
}

/** Whether the page is the test site's. */
export const isTestSitePage = (html) =>
    /<meta name="robots" content="noindex"/.test(html) && html.includes(`<title>${testTitlePrefix}`)
