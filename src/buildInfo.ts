declare const __GITHUB_REPOSITORY__: string
declare const __LEGAL_PAGES__: { privacy?: number; terms?: number }
declare const __NSE_SITE__: string

/** The repository the release notes and source code link to; forks link to themselves. */
export const GITHUB_REPOSITORY =
    typeof __GITHUB_REPOSITORY__ === 'string'
        ? __GITHUB_REPOSITORY__
        : 'qwewqa/next-sekai-editor-experiments'

/** The legal pages this build contains, with their revisions (scripts/legal.mjs); none in the apps. */
export const LEGAL_PAGES: { privacy?: number; terms?: number } =
    typeof __LEGAL_PAGES__ === 'object' ? __LEGAL_PAGES__ : {}

export const HAS_PRIVACY_PAGE = LEGAL_PAGES.privacy !== undefined
export const HAS_TERMS_PAGE = LEGAL_PAGES.terms !== undefined

export const PRIVACY_PATH = '/privacy/'
export const TERMS_PATH = '/terms/'

/** `CHANGELOG.md` on `main`, newest release first: the update line's and About's Release Notes. */
export const RELEASE_NOTES_URL = `https://github.com/${GITHUB_REPOSITORY}/blob/main/CHANGELOG.md`

/** The site this build is for: `test` under `NSE_SITE=test`, else `production`. */
export const SITE = typeof __NSE_SITE__ === 'string' ? __NSE_SITE__ : 'production'

/** About line on the test site: an English constant, not a locale key (`site.testAbout`). */
export const TEST_SITE_ABOUT = 'This is the test site. Its data is separate from nse.qwewqa.dev.'
