declare const __GITHUB_REPOSITORY__: string
declare const __HAS_PRIVACY_PAGE__: boolean
declare const __NSE_SITE__: string

/** The repository the release notes and source code link to; forks link to themselves. */
export const GITHUB_REPOSITORY =
    typeof __GITHUB_REPOSITORY__ === 'string'
        ? __GITHUB_REPOSITORY__
        : 'qwewqa/next-sekai-editor-experiments'

/** Whether this build contains the privacy page. */
export const HAS_PRIVACY_PAGE = typeof __HAS_PRIVACY_PAGE__ === 'boolean' && __HAS_PRIVACY_PAGE__

/** `CHANGELOG.md` on `main`, newest release first: the update line's and About's Release Notes. */
export const RELEASE_NOTES_URL = `https://github.com/${GITHUB_REPOSITORY}/blob/main/CHANGELOG.md`

/** The site this build is for: `test` under `NSE_SITE=test`, else `production`. */
export const SITE = typeof __NSE_SITE__ === 'string' ? __NSE_SITE__ : 'production'

/** About line on the test site: an English constant, not a locale key (`site.testAbout`). */
export const TEST_SITE_ABOUT = 'This is the test site. Its data is separate from nse.qwewqa.dev.'
