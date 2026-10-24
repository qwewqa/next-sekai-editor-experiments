// The rights gate over dist-native/: no web-only file or reference, our own assets as locked,
// the notices present. Node only. `--full` (release jobs) also checks the Rust crates in the notices.
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const textFile = /\.(?:html|js|mjs|css|json)$/i
// Licence texts and their inventories list upstream projects, so they aren't app code.
const licenceFolder = /^(?:third-party|notices)\//

async function listFiles(directory, prefix = '') {
    const files = []
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isDirectory())
            files.push(...(await listFiles(join(directory, entry.name), relative + '/')))
        else files.push(relative)
    }
    return files.sort()
}

/** The local files an HTML page loads: script and image sources, stylesheet and icon links. */
export function localReferences(html) {
    const references = []
    const attributes = /<(?:script|link|img|source|audio|video)\b([^>]*)>/gi
    for (const [, attrs] of html.matchAll(attributes))
        for (const [, double, single] of attrs.matchAll(
            /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
        ))
            references.push(double ?? single)
    return [...new Set(references)]
        .filter((value) => value && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value))
        .map((value) => posix.normalize(value.replace(/[?#].*$/, '').replace(/^\//, '')))
}

async function cargoCrates(root) {
    const lock = await readFile(join(root, 'src-tauri/Cargo.lock'), 'utf8')
    return [...lock.matchAll(/^\[\[package\]\]\r?\nname = "([^"]+)"/gm)].map(([, name]) => name)
}

/** Whether the notices name the crate as a whole word, so `log` is not found inside `catalog`. */
export function mentionsCrate(notices, crate) {
    const escaped = crate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(notices)
}

/** The problems with a native build in `directory`; empty when it passes. */
export async function checkNativeBundle(directory, { root = defaultRoot, full = false } = {}) {
    const problems = []
    const files = await listFiles(directory)
    const has = (file) => files.includes(file)

    const webOnly = JSON.parse(
        await readFile(join(root, 'deployment/web-only-assets.json'), 'utf8'),
    )
    const hashes = new Map(webOnly.files.map(({ name, sha256: hash }) => [hash, name]))
    const references = webOnly.references.map((reference) =>
        reference.regex
            ? {
                  label: `/${reference.regex}/`,
                  test: (text) => new RegExp(reference.regex).test(text),
              }
            : { label: reference.text, test: (text) => text.includes(reference.text) },
    )

    const contents = new Map()
    for (const file of files) {
        const bytes = await readFile(join(directory, file))
        contents.set(file, bytes)
        const listed = hashes.get(sha256(bytes))
        if (listed) problems.push(`${file} is the web-only file ${listed}`)
        if (textFile.test(file) && !licenceFolder.test(file)) {
            const text = bytes.toString('utf8')
            for (const reference of references)
                if (reference.test(text))
                    problems.push(`${file} contains the web-only reference ${reference.label}`)
            if (/serviceWorker\s*\.\s*register|rel\s*=\s*["']manifest["']/.test(text))
                problems.push(`${file} registers a service worker or links a web app manifest`)
        }
    }

    if (files.some((file) => file.startsWith('resource/'))) problems.push('resource/ exists')
    for (const file of files)
        if (/(?:^|\/)sw\.js$/.test(file) || /\.webmanifest$/.test(file))
            problems.push(`${file} is a service worker or web app manifest`)

    if (has('index.html')) {
        const html = contents.get('index.html').toString('utf8')
        for (const reference of localReferences(html))
            if (!has(reference))
                problems.push(`index.html references ${reference}, which is missing`)
    } else problems.push('index.html is missing')

    const lock = JSON.parse(
        await readFile(join(root, 'builtin-assets/builtin-assets.lock.json'), 'utf8'),
    )
    for (const type of ['skin', 'particle', 'background', 'effect']) {
        const file = `builtin/${type}.scp`
        const locked = lock.files[`public/${file}`]
        if (!has(file)) problems.push(`${file} is missing`)
        else if (sha256(contents.get(file)) !== locked.sha256)
            problems.push(`${file} does not match builtin-assets.lock.json`)
    }
    for (const file of files)
        if (
            file.startsWith('builtin/') &&
            !/^builtin\/(?:skin|particle|background|effect)\.scp$/.test(file)
        )
            problems.push(`${file} is not one of the Built-in files`)

    const cc0 = await readFile(join(root, 'builtin-assets/LICENSE.txt'))
    if (
        !has('notices/builtin-assets-CC0.txt') ||
        !contents.get('notices/builtin-assets-CC0.txt').equals(cc0)
    )
        problems.push(
            'notices/builtin-assets-CC0.txt is missing or differs from builtin-assets/LICENSE.txt',
        )
    for (const file of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'notices/Font-Awesome.txt'])
        if (!has(file)) problems.push(`${file} is missing`)
    const notices = contents.get('THIRD_PARTY_NOTICES.txt')?.toString('utf8') ?? ''
    if (
        !/UI icons: Font Awesome Free by Fonticons, Inc\./.test(notices) ||
        !notices.includes('CC BY 4.0')
    )
        problems.push('THIRD_PARTY_NOTICES.txt lacks the Font Awesome credit')
    if (!notices.includes('Built-in preview assets and app icon: original, CC0 1.0.'))
        problems.push('THIRD_PARTY_NOTICES.txt lacks the Built-in assets credit')

    if (full) {
        if (!existsSync(join(root, 'src-tauri/Cargo.lock')))
            problems.push('src-tauri/Cargo.lock is missing')
        else
            for (const crate of await cargoCrates(root))
                if (!mentionsCrate(notices, crate))
                    problems.push(`THIRD_PARTY_NOTICES.txt lacks the crate ${crate}`)
    }
    return problems
}

if (import.meta.main) {
    const args = process.argv.slice(2)
    const directory = resolve(
        defaultRoot,
        args.find((arg) => !arg.startsWith('--')) ?? 'dist-native',
    )
    if (!existsSync(directory)) {
        console.error(`${directory} doesn't exist; run npm run build:native first.`)
        process.exit(1)
    }
    const problems = await checkNativeBundle(directory, { full: args.includes('--full') })
    if (problems.length) {
        console.error(
            `The native bundle fails its checks:\n${problems.map((p) => `  ${p}`).join('\n')}`,
        )
        process.exit(1)
    }
    console.log(`The native bundle passes: ${(await listFiles(directory)).length} files.`)
}
