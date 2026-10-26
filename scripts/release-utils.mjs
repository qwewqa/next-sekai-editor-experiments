import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { readZip } from '../builtin-assets/zip.mjs'
import { gateTag } from './analytics.mjs'
import { inlineScripts, metaIsFirst, pageMetaPolicy, webPolicy } from './csp.mjs'
import { isTestSitePage } from './site.mjs'

const execFileAsync = promisify(execFile)

const lyonInventoryBytes = readFileSync(
    new URL('../public/third-party/lyon/sources.json', import.meta.url),
)
const lyonInventory = JSON.parse(lyonInventoryBytes)
const lyonManifest = JSON.parse(
    readFileSync(new URL('../native/lyon/artifact.json', import.meta.url), 'utf8'),
)
const lyonArtifact = lyonManifest.artifact
const lyonNoticeHashes = new Map(
    lyonInventory.map(({ file, sha256 }) => ['third-party/lyon/' + file, sha256]),
)
for (const file of ['sources.json', 'README.txt']) {
    const entry = lyonManifest.sources.find(
        (entry) => entry.file === 'public/third-party/lyon/' + file,
    )
    if (!entry) throw new Error('Missing pinned Lyon notice metadata: ' + file)
    lyonNoticeHashes.set('third-party/lyon/' + file, entry.sha256)
}
if (sha256(lyonInventoryBytes) !== lyonNoticeHashes.get('third-party/lyon/sources.json'))
    throw new Error('Lyon notice inventory differs from its pinned artifact')
export const lyonNoticeFiles = [...lyonNoticeHashes.keys()]

// The extension point for files copied from public/: a step that adds one lists it here (or in a list
// beside this one, staged below), and in validateFileNames and tests/release/artifacts.test.mjs.
// gate.js is the support gate: a classic script that index.html loads ahead of the bundle.
export const staticFiles = ['favicon.ico', 'thumbnail.png', 'gate.js']
export const builtinTypes = ['skin', 'particle', 'background', 'effect']
// The four Built-in packages, and the Sonolus server folder made from them.
export const builtinFiles = builtinTypes.map((type) => `builtin/${type}.scp`)
const builtinServerFile =
    /^builtin-server\/sonolus\/(?:info|(?:skins|particles|backgrounds|effects)\/(?:info|list|nse-builtin)|repository\/[0-9a-f]{40})$/
export const noticeFiles = [
    ...lyonNoticeFiles,
    'LICENSE.txt',
    'THIRD_PARTY_NOTICES.txt',
    'notices/LGPL-3.0.txt',
    'notices/GPL-3.0.txt',
    'notices/Font-Awesome.txt',
    'notices/libtess.txt',
    'notices/pixi-colord.txt',
]

export function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex')
}

export function containedPath(directory, relative) {
    const target = resolve(directory, relative)
    if (!target.startsWith(resolve(directory) + sep)) {
        throw new Error(`Path is outside its release directory: ${relative}`)
    }
    return target
}

async function regularFile(path) {
    if (!(await lstat(path)).isFile()) {
        throw new Error(`Expected a regular release file: ${path}`)
    }
    return readFile(path)
}

async function dependencyNotices(root, kind) {
    const project = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
    if (
        project.dependencies?.['pixi.js'] !== '8.22.0' ||
        lock.packages['']?.dependencies?.['pixi.js'] !== '8.22.0' ||
        lock.packages['node_modules/pixi.js']?.version !== '8.22.0'
    )
        throw new Error('Release requires the audited, exactly pinned PixiJS 8.22.0 installation')
    if (project.dependencies?.['canvaskit-wasm'] || lock.packages['node_modules/canvaskit-wasm'])
        throw new Error('Remove the obsolete CanvasKit dependency before producing a Pixi release')
    // Staging verifies the installed outputs without repairing or mutating them.
    // A skipped or stale postinstall must fail before the patched-code notice is published.
    await execFileAsync(
        process.execPath,
        [
            join(root, 'scripts/patch-pixi-default-batcher.mjs'),
            '--check',
            join(root, 'node_modules/pixi.js'),
        ],
        { cwd: root },
    )
    const lamejs = JSON.parse(await readFile(join(root, 'deployment/lamejs-source.json'), 'utf8'))
    if (lock.packages[`node_modules/${lamejs.package}`]?.version !== lamejs.version) {
        throw new Error('Update LameJS source attribution for the locked dependency version')
    }
    const sections = [
        'Third-party software notices',
        '============================',
        '',
        'This list includes production dependencies and their build helpers.',
        'Versions are taken from the locked installation. Original license text is preserved',
        'from installed files or the explicitly pinned upstream notice identified below.',
        '',
        'LameJS: @breezystack/lamejs is used without source modifications.',
        'It is compiled as a separate dynamically imported JavaScript chunk.',
        'LAME project: https://lame.sourceforge.io/',
        `Published package source: ${lamejs.repository}/tree/${lamejs.commit}`,
        `Corresponding source archive: ${lamejs.archive}`,
        `Source archive SHA-256: ${lamejs.archiveSha256}`,
        'Upstream source: https://github.com/zhuker/lamejs',
        'Full LGPL-3.0 and GPL-3.0 texts are included in notices/.',
        'The published package LICENSE excerpt is also preserved below.',
        '',
        'Built-in preview assets and app icon: original, CC0 1.0.',
        'UI icons: Font Awesome Free by Fonticons, Inc. (https://fontawesome.com), licensed under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
        ...(kind === 'web'
            ? [
                  'Default preview skin and particle: "Next SEKAI 01" by Burrito, from coconut.sonolus.com, under its author’s terms.',
              ]
            : []),
        'Font Awesome icon attribution: notices/Font-Awesome.txt',
        'Lyon 1.0.22/Rust kernel: full notices and source revisions in third-party/lyon/sources.json.',
        'Vendored libtess.js: notices/libtess.txt (SGI Free Software License B).',
        'libtess.js source: https://github.com/brendankenny/libtess.js',
        '',
        'PixiJS 8.22.0 includes one checked source patch:',
        '- Resolve the initial default batcher through the registered batcher extension.',
        'The original PixiJS MIT license and copyright are preserved below.',
    ]
    for (const [location, locked] of Object.entries(lock.packages).sort(([a], [b]) =>
        a.localeCompare(b),
    )) {
        if (!location || locked.dev || locked.optional) continue
        if (!location.startsWith('node_modules/'))
            throw new Error(`Unexpected dependency path: ${location}`)
        const directory = containedPath(root, location)
        const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
        if (pkg.version !== locked.version)
            throw new Error(`Dependency version differs from lockfile: ${pkg.name}`)
        const licenses = (await readdir(directory))
            .filter((file) => /^(licen[sc]e|copying)(\.|$)/i.test(file))
            .sort()
        const licenseTexts = await Promise.all(
            licenses.map(async (file) =>
                (await regularFile(join(directory, file))).toString('utf8').trim(),
            ),
        )
        if (!licenseTexts.length) {
            // This published package omits LICENSE.md. Preserve the complete text
            // from its published gitHead; other missing licenses still fail closed.
            if (pkg.name !== '@pixi/colord' || pkg.version !== '2.9.6')
                throw new Error(`Missing dependency license: ${pkg.name}`)
            licenseTexts.push(
                (await regularFile(join(root, 'deployment/notices/pixi-colord.txt')))
                    .toString('utf8')
                    .trim(),
            )
        }
        sections.push(
            '',
            `${pkg.name} ${pkg.version}`,
            `License: ${pkg.license ?? locked.license ?? 'See text below'}`,
        )
        const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
        if (repository) sections.push(`Source: ${repository}`)
        for (const text of licenseTexts) sections.push('', text)
    }
    return sections.join('\n') + '\n'
}

/**
 * The static Sonolus server the four Built-in packages make: every entry of every
 * package, and one merged sonolus/info. Takes the packages' bytes by type; returns bytes by path.
 */
export function builtinServerFiles(packages) {
    const files = new Map()
    let title
    const buttons = []
    for (const type of builtinTypes) {
        for (const [name, data] of readZip(packages.get(type))) {
            if (name !== 'sonolus/info') {
                files.set(`builtin-server/${name}`, data)
                continue
            }
            const info = JSON.parse(data.toString('utf8'))
            title ??= info.title
            buttons.push(...info.buttons)
        }
    }
    files.set(
        'builtin-server/sonolus/info',
        Buffer.from(JSON.stringify({ title, buttons, configuration: { options: [] } })),
    )
    return files
}

/** The web-only static files, the Built-in packages and the server folder made from them. */
export async function stageWebStatic(root, destination) {
    await mkdir(destination, { recursive: true })
    for (const file of staticFiles) {
        await writeFile(join(destination, file), await regularFile(join(root, 'public', file)))
    }
    const packages = new Map()
    for (const [index, file] of builtinFiles.entries()) {
        const bytes = await regularFile(join(root, 'public', file))
        packages.set(builtinTypes[index], bytes)
        await mkdir(join(destination, 'builtin'), { recursive: true })
        await writeFile(join(destination, file), bytes)
    }
    for (const [file, bytes] of builtinServerFiles(packages)) {
        const target = containedPath(destination, file)
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, bytes)
    }
}

/** The licence, the notice files and the generated notices of a target, 'web' or 'native'. */
export async function stageNotices(root, destination, kind = 'web') {
    await mkdir(destination, { recursive: true })
    await writeFile(join(destination, 'LICENSE.txt'), await regularFile(join(root, 'LICENSE.txt')))
    await mkdir(join(destination, 'notices'), { recursive: true })
    for (const file of noticeFiles.filter((file) => file.startsWith('notices/'))) {
        await writeFile(join(destination, file), await regularFile(join(root, 'deployment', file)))
    }
    for (const file of lyonNoticeFiles) {
        const target = containedPath(destination, file)
        await mkdir(resolve(target, '..'), { recursive: true })
        await writeFile(target, await regularFile(containedPath(join(root, 'public'), file)))
    }
    await writeFile(
        join(destination, 'THIRD_PARTY_NOTICES.txt'),
        await dependencyNotices(root, kind),
    )
}

export async function stageReleasePublic(root, destination) {
    await stageWebStatic(root, destination)
    await stageNotices(root, destination, 'web')
}

async function listFiles(directory, prefix = '') {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isDirectory())
            files.push(...(await listFiles(join(directory, entry.name), relative + '/')))
        else if (entry.isFile()) files.push(relative)
        else throw new Error(`Non-regular release entry: ${relative}`)
    }
    return files.sort()
}

function validateFileNames(files, assets) {
    const remaining = new Set(['resource/skin.scp', 'resource/particle.scp'])
    if (!Array.isArray(assets)) throw new Error('Invalid preview asset declarations')
    for (const asset of assets) {
        if (
            !remaining.delete(asset.file) ||
            typeof asset.source !== 'string' ||
            !asset.source ||
            !Number.isSafeInteger(asset.bytes) ||
            asset.bytes <= 0 ||
            !/^[a-f0-9]{64}$/.test(asset.sha256)
        )
            throw new Error('Invalid preview asset declaration')
    }
    if (remaining.has('resource/skin.scp')) throw new Error('Missing preview skin')
    const exact = new Set([
        'index.html',
        'privacy/index.html',
        'release-manifest.json',
        ...staticFiles,
        ...noticeFiles,
        ...builtinFiles,
        ...assets.map((asset) => asset.file),
    ])
    for (const file of files) {
        if (
            !exact.has(file) &&
            !builtinServerFile.test(file) &&
            !/^assets\/lyon-[\w-]{8,}\.wasm$/.test(file) &&
            !/^assets\/[\w.-]+-[\w-]{8,}\.(?:js|css|png|mp3|svg|woff2?)$/.test(file)
        ) {
            throw new Error(`Unexpected release file: ${file}`)
        }
    }
    for (const file of exact) {
        if (file !== 'release-manifest.json' && !files.includes(file)) {
            throw new Error(`Missing release file: ${file}`)
        }
    }
    if (!files.some((file) => /^assets\/.+\.js$/.test(file)))
        throw new Error('Release contains no JavaScript bundle')
    if (!files.some((file) => /^assets\/.+\.css$/.test(file)))
        throw new Error('Release contains no stylesheet')
}

// The packages are the locked ones, and the server folder is exactly what they unpack to.
async function checkBuiltinRelease(directory, files) {
    const lock = JSON.parse(
        readFileSync(
            new URL('../builtin-assets/builtin-assets.lock.json', import.meta.url),
            'utf8',
        ),
    )
    const packages = new Map()
    for (const [index, file] of builtinFiles.entries()) {
        if (!files.includes(file)) throw new Error(`Missing release file: ${file}`)
        const bytes = await regularFile(containedPath(directory, file))
        if (sha256(bytes) !== lock.files[`public/${file}`]?.sha256)
            throw new Error(`Built-in package differs from builtin-assets.lock.json: ${file}`)
        packages.set(builtinTypes[index], bytes)
    }
    const expected = builtinServerFiles(packages)
    for (const [file, bytes] of expected) {
        if (!files.includes(file)) throw new Error(`Missing release file: ${file}`)
        if (!(await regularFile(containedPath(directory, file))).equals(bytes))
            throw new Error(`Built-in server file differs from the packages: ${file}`)
    }
    for (const file of files.filter((file) => file.startsWith('builtin-server/')))
        if (!expected.has(file)) throw new Error(`Unexpected release file: ${file}`)
}

async function checkLyonRelease(directory, files) {
    const modules = files.filter((file) => /^assets\/lyon-[\w-]{8,}\.wasm$/.test(file))
    if (modules.length !== 1) throw new Error('Release requires exactly one Lyon kernel')
    if (sha256(await regularFile(join(directory, modules[0]))) !== lyonArtifact.sha256)
        throw new Error('Lyon release binary differs from its pinned artifact')
    for (const file of lyonNoticeFiles) {
        if (
            sha256(await regularFile(containedPath(directory, file))) !== lyonNoticeHashes.get(file)
        )
            throw new Error('Lyon release notice differs from its pinned inventory: ' + file)
    }
}

export async function writeReleaseManifest(directory, metadata, assets) {
    const files = (await listFiles(directory)).filter((file) => file !== 'release-manifest.json')
    validateFileNames(files, assets)
    await checkLyonRelease(directory, files)
    await checkBuiltinRelease(directory, files)
    const hashes = {}
    for (const file of files) hashes[file] = sha256(await regularFile(join(directory, file)))
    const manifest = {
        schemaVersion: 1,
        ...metadata,
        previewAssets: assets,
        files: hashes,
    }
    await writeFile(
        join(directory, 'release-manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n',
    )
    return manifest
}

// The version rule of scripts/version.mjs: X.Y.Z at the tag, X.Y.Z+<commit8> after it, or the package's.
function validAppVersion(manifest) {
    if (manifest.atTag) return manifest.appVersion === manifest.version
    return [manifest.version, `${manifest.version}+${manifest.commit.slice(0, 8)}`].includes(
        manifest.appVersion,
    )
}

// The Vite entries, /privacy/ and /app/ included; the third-party notice pages are static documents.
const pageEntries = /^(?:index|privacy\/index|app\/index)\.html$/

// The support gate is a plain classic script with no async or defer, ahead of every module script.
function gateComesFirst(html) {
    const gate = /<script\s+src="\/gate\.js"\s*><\/script>/i.exec(html)
    const module = /<script\b[^>]*\btype="module"/i.exec(html)
    return Boolean(gate && module && gate.index < module.index)
}

// The pages' policy is the web policy hashing exactly their inline scripts, first in <head>, with
// the build's analytics origin as its only cross-origin source.
async function checkPages(directory, files, manifest) {
    for (const file of files.filter((file) => pageEntries.test(file))) {
        const html = (await regularFile(join(directory, file))).toString('utf8')
        const policy = webPolicy(inlineScripts(html), manifest.analytics?.origin)
        if (pageMetaPolicy(html) !== policy || !metaIsFirst(html))
            throw new Error(`Content Security Policy differs from the web policy: ${file}`)
    }
    const index = (await regularFile(join(directory, 'index.html'))).toString('utf8')
    if (!gateComesFirst(index))
        throw new Error('index.html does not load gate.js before the bundle')
    if (isTestSitePage(index) !== (manifest.site === 'test'))
        throw new Error(`index.html does not match the site: ${manifest.site}`)
}

// The editor's layout needs these utilities. Without them the chart canvas grows each frame and
// the page hangs.
const layoutUtilities = ['absolute', 'size-full']

async function checkStylesheet(directory, files) {
    const index = (await regularFile(join(directory, 'index.html'))).toString('utf8')
    const linked = [...index.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="\/([^"]+)"/g)]
        .map((match) => match[1])
        .filter((file) => files.includes(file))
    let css = ''
    for (const file of linked) css += (await regularFile(join(directory, file))).toString('utf8')
    const missing = layoutUtilities.filter(
        (name) => !new RegExp(String.raw`\.${name}(?![\w-])`).test(css),
    )
    if (missing.length) throw new Error(`The editor’s stylesheet lacks .${missing.join(' and .')}`)
}

// The apps' bridge and the dev-only sample seeder (src/local/seed.ts) must not reach the web build.
// A production-site build names no test key but these (src/platform/testKeys.ts); the test site may.
const liveTestKeys = ['nse.test.version', 'nse.test.storage', 'nse.test.startBlank']

// The usage statistics' client is one chunk, which only a build with a target has, and the bundle
// names that target.
async function checkAnalytics(directory, files, analytics, site) {
    const scripts = []
    // The gate (gate.js) names the path too, in every build; it has no client in it.
    for (const file of files.filter((file) => file.endsWith('.js') && file !== 'gate.js'))
        scripts.push({ file, text: (await regularFile(join(directory, file))).toString('utf8') })
    const clients = scripts.filter(({ text }) => text.includes('/api/batch'))
    // The support gate reads where to send its one event from a tag on the editor's page.
    const index = (await regularFile(join(directory, 'index.html'))).toString('utf8')
    const tags = index.match(/<meta name="nse-analytics"[^>]*>/g) ?? []
    if (!analytics) {
        if (clients.length)
            throw new Error(`Release without analytics contains its client: ${clients[0].file}`)
        if (tags.length) throw new Error('Release without analytics tags its page for the gate')
        return
    }
    if (tags.length !== 1 || tags[0] !== gateTag(analytics, site))
        throw new Error('Release page does not tag the gate with its analytics target')
    if (clients.length !== 1) throw new Error('Release requires exactly one analytics client')
    for (const value of [analytics.origin, analytics.website])
        if (!scripts.some(({ text }) => text.includes(value)))
            throw new Error(`Release does not name its analytics target: ${value}`)
}

const validAnalytics = (analytics) =>
    analytics === null ||
    (typeof analytics === 'object' &&
        Object.keys(analytics).sort().join() === 'origin,website' &&
        /^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(analytics.origin) &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(analytics.website))

async function checkBundles(directory, files, site) {
    for (const file of files.filter((file) => /\.(?:js|html|css)$/.test(file))) {
        const bytes = await regularFile(join(directory, file))
        for (const marker of ['__TAURI_INTERNALS__', 'seedSample', 'nse-handle-probe'])
            if (bytes.includes(marker)) throw new Error(`Release contains ${marker}: ${file}`)
        const named =
            site === 'production' ? (bytes.toString().match(/nse\.test\.[A-Za-z]+/g) ?? []) : []
        for (const key of named)
            if (!liveTestKeys.includes(key))
                throw new Error(`Release names a gated key ${key}: ${file}`)
    }
}

export async function checkRelease(directory, expected = {}) {
    const manifest = JSON.parse(await regularFile(join(directory, 'release-manifest.json')))
    const assets = manifest.previewAssets
    if (
        manifest.schemaVersion !== 1 ||
        !/^[a-f0-9]{40}$/.test(manifest.commit) ||
        typeof manifest.version !== 'string' ||
        !manifest.version ||
        manifest.base !== '/' ||
        typeof manifest.atTag !== 'boolean' ||
        !validAppVersion(manifest) ||
        !['production', 'test'].includes(manifest.site) ||
        typeof manifest.sourceDirty !== 'boolean' ||
        !validAnalytics(manifest.analytics)
    )
        throw new Error('Invalid release metadata')
    for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(manifest[key]) !== JSON.stringify(value))
            throw new Error(`Release metadata mismatch: ${key}`)
    }
    const files = await listFiles(directory)
    validateFileNames(files, assets)
    await checkLyonRelease(directory, files)
    await checkBuiltinRelease(directory, files)
    await checkPages(directory, files, manifest)
    await checkStylesheet(directory, files)
    await checkBundles(directory, files, manifest.site)
    await checkAnalytics(directory, files, manifest.analytics, manifest.site)
    const recorded = Object.keys(manifest.files).sort()
    if (
        JSON.stringify(recorded) !==
        JSON.stringify(files.filter((file) => file !== 'release-manifest.json'))
    ) {
        throw new Error('Release file inventory differs from its manifest')
    }
    for (const file of recorded) {
        if (sha256(await regularFile(join(directory, file))) !== manifest.files[file]) {
            throw new Error(`Release file integrity failed: ${file}`)
        }
    }
    for (const asset of assets) {
        const bytes = await regularFile(join(directory, asset.file))
        if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256) {
            throw new Error(`Preview asset integrity failed: ${asset.file}`)
        }
    }
    return manifest
}
