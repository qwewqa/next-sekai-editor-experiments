import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyticsFromEnv } from './analytics.mjs'
import { checkRelease } from './release-utils.mjs'
import { siteFromEnv } from './site.mjs'
import { appVersion } from './version.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { version, appVersion: shown, atTag } = appVersion({ cwd: root })
// The usage statistics' target is the one the same variables give the build.
const expected = {
    version,
    appVersion: shown,
    atTag,
    site: siteFromEnv(),
    analytics: analyticsFromEnv(process.env),
}
if (process.env.GITHUB_SHA) expected.commit = process.env.GITHUB_SHA
if (process.env.GITHUB_ACTIONS === 'true') expected.sourceDirty = false
const manifest = await checkRelease(join(root, 'dist'), expected)
console.log(
    `Release artifact verified: ${manifest.appVersion} (${Object.keys(manifest.files).length} files)`,
)
