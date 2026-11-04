// The asset store keeps the hashed assets of earlier builds, so that a tab still running an older build can load
// its lazy code after a deploy. infra/assets/README.md describes the store, the rule and the operations.
//
// `store` is the bucket under one site's prefix (scripts/release/awsStore.mjs):
//   readIndex() -> { bytes, etag } | null
//   headIndex() -> etag | null
//   writeIndex(bytes, { ifMatch } | { ifNoneMatch: true })
//   download(names, folder): writes each name's bytes to folder/<name without assets/>
//   putNew(name, bytes, sha256) -> 'created' | 'exists'
//   read(name) -> bytes
//   remove(names) -> the names whose delete failed

import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { containedPath, hashedAsset, sha256 } from '../release-utils.mjs'

const day = 24 * 60 * 60 * 1000
const sorted = (names) => [...new Set(names)].sort()

/** Reads the index strictly: anything unexpected fails the deploy. */
export function parseIndex(bytes) {
    let index
    try {
        index = JSON.parse(bytes.toString('utf8'))
    } catch {
        throw new Error('The asset store index is not valid JSON')
    }
    const fail = (why) => {
        throw new Error(`Invalid asset store index: ${why}`)
    }
    if (index?.version !== 1) fail('version')
    if (typeof index.assets !== 'object' || index.assets === null || Array.isArray(index.assets))
        fail('assets')
    for (const [name, entry] of Object.entries(index.assets)) {
        if (!hashedAsset.test(name)) fail(name)
        if (
            !/^[a-f0-9]{64}$/.test(entry?.sha256) ||
            !Number.isSafeInteger(entry.bytes) ||
            entry.bytes < 0 ||
            typeof entry.lastLive !== 'string' ||
            Number.isNaN(Date.parse(entry.lastLive))
        )
            fail(name)
    }
    const listed = (names) =>
        Array.isArray(names) && names.every((name) => Object.hasOwn(index.assets, name))
    if (!listed(index.live)) fail('live')
    if (index.next !== null) {
        if (!/^[a-f0-9]{40}$/.test(index.next?.commit) || !listed(index.next.files)) fail('next')
    }
    return index
}

export function serializeIndex(index) {
    const assets = {}
    for (const name of Object.keys(index.assets).sort()) assets[name] = index.assets[name]
    const next = index.next && { commit: index.next.commit, files: sorted(index.next.files) }
    return Buffer.from(
        JSON.stringify({ version: 1, live: sorted(index.live), next, assets }, null, 4) + '\n',
    )
}

async function readStoredIndex(store) {
    const stored = await store.readIndex()
    if (!stored)
        throw new Error(
            'The asset store has no index. Seed it first (infra/assets/README.md, Set-up).',
        )
    return { index: parseIndex(stored.bytes), etag: stored.etag }
}

// Puts a file that may already be stored, as an object the index does not list or one a prune deleted.
async function putChecked(store, name, bytes, hash) {
    if ((await store.putNew(name, bytes, hash)) === 'exists') {
        if (sha256(await store.read(name)) !== hash)
            throw new Error(`${name} is stored with different contents`)
    }
}

async function absent(path) {
    try {
        await lstat(path)
    } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
    }
    throw new Error(`Retained file is already in the build: ${path}`)
}

/**
 * Before the release check: adds the files to keep into `dist`, stores the build's own files, stages the build
 * as `next` and lists the kept files in the manifest's `retained`.
 */
export async function prepare({ dist, store, now, commit, days, log = () => {} }) {
    const manifestPath = join(dist, 'release-manifest.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (manifest.retained && Object.keys(manifest.retained).length)
        throw new Error('The build already has retained files')
    const current = Object.keys(manifest.files).filter((name) => hashedAsset.test(name))
    const { index, etag } = await readStoredIndex(store)

    // A staged release that was never recorded may have gone live.
    const live = sorted([...index.live, ...(index.next?.files ?? [])])
    const since = now.getTime() - days * day
    const keep = new Set([
        ...live,
        ...Object.keys(index.assets).filter(
            (name) => Date.parse(index.assets[name].lastLive) >= since,
        ),
    ])
    for (const name of current) {
        const stored = index.assets[name]
        if (stored && stored.sha256 !== manifest.files[name])
            throw new Error(`${name} is in the store with different contents`)
    }
    const retained = [...keep].filter((name) => !current.includes(name)).sort()

    const folder = await mkdtemp(join(tmpdir(), 'nse-asset-store-'))
    let keptBytes = 0
    try {
        if (retained.length) await store.download(retained, folder)
        for (const name of retained) {
            const entry = index.assets[name]
            let bytes
            try {
                bytes = await readFile(join(folder, name.slice('assets/'.length)))
            } catch (error) {
                if (error.code === 'ENOENT')
                    throw new Error(`${name} is missing from the store`, { cause: error })
                throw error
            }
            if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
                throw new Error(`${name} in the store does not match its recorded hash`)
            const target = containedPath(dist, name)
            await absent(target)
            await writeFile(target, bytes, { flag: 'wx' })
            keptBytes += bytes.length
        }
    } finally {
        await rm(folder, { recursive: true, force: true })
    }

    // A current file in keep is stored: pruning deletes only names outside keep. Any other goes through the
    // conditional put, including an expired entry whose object a prune deleted before its index write failed.
    let uploaded = 0
    for (const name of current) {
        if (keep.has(name)) continue
        const bytes = await readFile(containedPath(dist, name))
        await putChecked(store, name, bytes, manifest.files[name])
        uploaded++
        index.assets[name] ??= {
            sha256: manifest.files[name],
            bytes: bytes.length,
            lastLive: now.toISOString(),
        }
    }
    index.live = live
    index.next = { commit, files: current }
    await store.writeIndex(serializeIndex(index), { ifMatch: etag })

    manifest.retained = Object.fromEntries(retained.map((name) => [name, index.assets[name].sha256]))
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    const oldest = retained.map((name) => index.assets[name].lastLive).sort()[0]
    log(
        `Asset store: ${current.length} current (${uploaded} uploaded), ${retained.length} retained ` +
            `(${(keptBytes / 1e6).toFixed(1)} MB${oldest ? `, oldest last live ${oldest}` : ''})`,
    )
    return { retained, uploaded }
}

/** After a successful publish: the staged release is live, and files expired by then are deleted. */
export async function record({ store, now, commit, days, log = () => {} }) {
    const { index, etag } = await readStoredIndex(store)
    if (!index.next) throw new Error('The asset store has no staged release to record')
    if (index.next.commit !== commit)
        throw new Error(
            `The asset store staged ${index.next.commit}, not the deployed ${commit}`,
        )
    const time = now.toISOString()
    for (const name of [...index.live, ...index.next.files]) index.assets[name].lastLive = time
    index.live = sorted(index.next.files)
    index.next = null

    // Deleting first is safe: an expired name is never kept again, and one that returns is put again.
    const since = now.getTime() - days * day
    const expired = Object.keys(index.assets)
        .filter(
            (name) =>
                !index.live.includes(name) && Date.parse(index.assets[name].lastLive) < since,
        )
        .sort()
    const failed = expired.length ? await store.remove(expired) : []
    for (const name of expired) if (!failed.includes(name)) delete index.assets[name]
    await store.writeIndex(serializeIndex(index), { ifMatch: etag })
    log(
        `Asset store: ${index.live.length} live, ${Object.keys(index.assets).length} stored, ` +
            `${expired.length - failed.length} deleted`,
    )
    if (failed.length)
        throw new Error(
            `These expired files could not be deleted, and the next record tries again: ${failed.join(', ')}`,
        )
}

/**
 * Builds the index from the live site's verified release: its current and retained files. Run by hand with
 * deploys stopped (infra/assets/README.md). `replace` replaces an existing index without reading it.
 */
export async function seed({ store, fetch, origin, site, now, replace, log = () => {} }) {
    const response = await fetch(
        `${origin}/release-manifest.json?seed=${now.getTime().toString(36)}`,
        { cache: 'no-store' },
    )
    if (!response.ok) throw new Error(`The live manifest returned ${response.status}`)
    const manifest = await response.json()
    if (manifest.site !== site || !/^[a-f0-9]{40}$/.test(manifest.commit))
        throw new Error(`The live manifest is not a ${site} release`)
    const live = Object.keys(manifest.files).filter((name) => hashedAsset.test(name))
    const files = { ...manifest.retained, ...manifest.files }
    const names = sorted([...live, ...Object.keys(manifest.retained ?? {})])
    for (const name of names)
        if (!hashedAsset.test(name) || !/^[a-f0-9]{64}$/.test(files[name]))
            throw new Error(`The live manifest lists an invalid file: ${name}`)

    const etag = await store.headIndex()
    if (replace && !etag) throw new Error('There is no index to replace. Run seed without --replace.')
    if (!replace && etag)
        throw new Error('The store already has an index. Use --replace to rebuild it.')

    const downloaded = new Map()
    for (const name of names) {
        const file = await fetch(`${origin}/${name}`, { cache: 'no-store' })
        if (!file.ok) throw new Error(`${name} returned ${file.status}`)
        const bytes = Buffer.from(await file.arrayBuffer())
        if (sha256(bytes) !== files[name])
            throw new Error(`${name} on the live site does not match its manifest`)
        downloaded.set(name, bytes)
    }
    const assets = {}
    for (const [name, bytes] of downloaded) {
        await putChecked(store, name, bytes, files[name])
        assets[name] = { sha256: files[name], bytes: bytes.length, lastLive: now.toISOString() }
    }
    const index = { version: 1, live, next: null, assets }
    await store.writeIndex(serializeIndex(index), replace ? { ifMatch: etag } : { ifNoneMatch: true })
    log(
        `Asset store seeded from ${manifest.appVersion} (${manifest.commit}): ${live.length} live, ` +
            `${names.length - live.length} retained`,
    )
    return index
}
