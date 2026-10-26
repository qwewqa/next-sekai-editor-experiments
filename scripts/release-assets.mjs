import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, gunzipSync } from 'node:zlib'
import { readZip } from '../builtin-assets/zip.mjs'
import { itemDetailsUrl } from '../src/preview/assets/serverUrl.ts'

const defaults = {
    skin: 'https://coconut.sonolus.com/next-sekai/skins/coconut-next-sekai-1',
    skin2: 'https://coconut.sonolus.com/next-sekai/skins/coconut-next-sekai-2',
    particle: 'https://coconut.sonolus.com/next-sekai/particles/coconut-next-sekai-1',
    effect: 'https://coconut.sonolus.com/next-sekai/effects/coconut-next-sekai-1',
    effect2: 'https://coconut.sonolus.com/next-sekai/effects/coconut-next-sekai-2',
}
export const categories = {
    skin: 'skins',
    skin2: 'skins',
    particle: 'particles',
    effect: 'effects',
    effect2: 'effects',
}
const optionalLocal = new Set(['skin2', 'particle', 'effect', 'effect2'])
// Franchise artwork stays out of these packages, whatever the lock says. A lock entry also
// records it with `thumbnail: false`, and may leave out the picture of any other item.
const withoutThumbnail = new Set(['particle', 'effect', 'effect2'])
// The second resource of an item: a skin or particle has a texture, an effect has audio.
const second = (category) => (category === 'effects' ? 'audio' : 'texture')
const lockFile = 'deployment/preview-assets.lock.json'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Shared with the editor, so the script and the chooser read item links alike.
export { itemDetailsUrl }

async function download(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Preview download failed: ${response.status} ${url}`)
    return response
}

function resourceReference(reference, base, requireHash = false) {
    if (!reference?.url) throw new Error('Preview item is missing a resource URL')
    const url = new URL(reference.url, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Invalid resource URL')
    if (requireHash && !/^[a-f0-9]{40}$/.test(reference.hash))
        throw new Error('Locked preview resources must have a SHA-1 hash')
    return { ...reference, url: url.href }
}

async function resource(reference) {
    const url = reference.url
    const bytes = Buffer.from(await (await download(url)).arrayBuffer())
    if (reference.hash && createHash('sha1').update(bytes).digest('hex') !== reference.hash)
        throw new Error(`Preview resource hash mismatch: ${url}`)
    return bytes
}

// SCP is a ZIP archive. Stored entries avoid recompressing PNG and gzip payloads.
export function createScp(entries) {
    const local = []
    const central = []
    let offset = 0
    for (const [path, bytes] of Object.entries(entries)) {
        const name = Buffer.from(path)
        const checksum = crc32(bytes)
        const header = Buffer.alloc(30)
        header.writeUInt32LE(0x04034b50, 0)
        header.writeUInt16LE(20, 4)
        header.writeUInt16LE(0x800, 6)
        header.writeUInt16LE(33, 12)
        header.writeUInt32LE(checksum, 14)
        header.writeUInt32LE(bytes.length, 18)
        header.writeUInt32LE(bytes.length, 22)
        header.writeUInt16LE(name.length, 26)
        local.push(header, name, bytes)
        const directory = Buffer.alloc(46)
        directory.writeUInt32LE(0x02014b50, 0)
        directory.writeUInt16LE(20, 4)
        header.copy(directory, 6, 4, 30)
        directory.writeUInt32LE(offset, 42)
        central.push(directory, name)
        offset += header.length + name.length + bytes.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(local.length / 3, 8)
    end.writeUInt16LE(local.length / 3, 10)
    end.writeUInt32LE(
        central.reduce((size, bytes) => size + bytes.length, 0),
        12,
    )
    end.writeUInt32LE(offset, 16)
    return Buffer.concat([...local, ...central, end])
}

async function resolveItem(source, category) {
    const url = itemDetailsUrl(source, category)
    const response = await download(url)
    const { item } = await response.json()
    return { source: url, item: normalizeItem(item, response.url || url, category) }
}

function normalizeItem(item, base, category, requireHash = false) {
    if (!item?.name || typeof item.title !== 'string') throw new Error('Invalid preview item')
    return {
        ...item,
        data: resourceReference(item.data, base, requireHash),
        [second(category)]: resourceReference(item[second(category)], base, requireHash),
        ...(item.thumbnail && { thumbnail: resourceReference(item.thumbnail, base, requireHash) }),
    }
}

async function packageItem({ source, item }, category, withThumbnail = true) {
    const { thumbnail, ...rest } = item
    const key = second(category)
    const [data, extra, image] = await Promise.all([
        resource(item.data),
        resource(item[key]),
        withThumbnail && thumbnail ? resource(thumbnail) : undefined,
    ])
    const decoded = JSON.parse(gunzipSync(data))
    if (
        category === 'effects'
            ? !Array.isArray(decoded.clips)
            : !Array.isArray(decoded.sprites) ||
              (category === 'particles' && !Array.isArray(decoded.effects))
    )
        throw new Error('Invalid preview resource data')
    const packagedItem = {
        ...rest,
        data: { ...item.data, url: '/data' },
        [key]: { ...item[key], url: `/${key}` },
        ...(image && { thumbnail: { ...thumbnail, url: '/thumbnail' } }),
    }
    const json = (value) => Buffer.from(JSON.stringify(value))
    return {
        bytes: createScp({
            [`sonolus/${category}/list`]: json({ items: [packagedItem] }),
            [`sonolus/${category}/${item.name}`]: json({ item: packagedItem }),
            data,
            [key]: extra,
            ...(image && { thumbnail: image }),
        }),
        source,
        title: item.title,
        author: item.author,
    }
}

export async function downloadPackage(source, category, withThumbnail = true) {
    return packageItem(await resolveItem(source, category), category, withThumbnail)
}

function lockItem(item, base, category, withThumbnail) {
    const { name, source, version, title, subtitle, author, thumbnail, data } = item
    return normalizeItem(
        {
            name,
            source,
            version,
            title,
            subtitle,
            author,
            ...(withThumbnail && { thumbnail }),
            data,
            [second(category)]: item[second(category)],
        },
        base,
        category,
        true,
    )
}

async function readLock(root) {
    const lock = JSON.parse(await readFile(join(root, lockFile), 'utf8'))
    if (lock.version !== 1) throw new Error('Unsupported preview asset lock version')
    return lock
}

async function thumbnailPolicy(root, name) {
    let entry
    try {
        entry = (await readLock(root))[name]
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    return !withoutThumbnail.has(name) && entry?.thumbnail !== false
}

// A package that should have no picture has no `thumbnail` entry and no locator for one.
function hasPicture(bytes, category) {
    const zip = readZip(bytes)
    if (zip.has('thumbnail')) return true
    return [
        `sonolus/${category}/list`,
        ...[...zip.keys()].filter((key) => key.startsWith(`sonolus/${category}/`)),
    ].some((key) => {
        if (!zip.has(key)) return false
        const json = JSON.parse(Buffer.from(zip.get(key)).toString('utf8'))
        return [json.item, ...(json.items ?? [])].some((item) => item && 'thumbnail' in item)
    })
}

export async function refreshPreviewAssetLock(root, env = process.env) {
    const lock = { version: 1 }
    for (const [name, category] of Object.entries(categories)) {
        const withThumbnail = await thumbnailPolicy(root, name)
        const resolved = await resolveItem(
            env[`PREVIEW_${name.toUpperCase()}_URL`] || defaults[name],
            category,
        )
        resolved.item = lockItem(resolved.item, resolved.source, category, withThumbnail)
        const { bytes } = await packageItem(resolved, category, withThumbnail)
        lock[name] = {
            ...resolved,
            ...(!withThumbnail && { thumbnail: false }),
            sha256: sha256(bytes),
        }
    }
    await mkdir(join(root, 'deployment'), { recursive: true })
    await writeFile(join(root, lockFile), `${JSON.stringify(lock, null, 4)}\n`)
    return lock
}

async function lockedPackage(root, name, category) {
    const entry = (await readLock(root))[name]
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256))
        throw new Error(`Invalid preview asset lock entry: ${name}`)
    const source = itemDetailsUrl(entry.source, category)
    const loaded = await packageItem(
        { source, item: normalizeItem(entry.item, source, category, true) },
        category,
        await thumbnailPolicy(root, name),
    )
    if (sha256(loaded.bytes) !== entry.sha256)
        throw new Error(`Locked preview package hash mismatch: ${name}`)
    return loaded
}

export { lockedPackage }

export async function stagePreviewAssets(root, destination, env = process.env) {
    const source = env.PREVIEW_ASSET_SOURCE || 'server'
    if (!['server', 'local'].includes(source))
        throw new Error('PREVIEW_ASSET_SOURCE must be server or local')
    const assets = []
    for (const [name, category] of Object.entries(categories)) {
        let loaded
        if (source === 'local') {
            try {
                loaded = {
                    bytes: await readFile(join(root, `public/resource/${name}.scp`)),
                    source: `public/resource/${name}.scp`,
                }
            } catch (error) {
                if (optionalLocal.has(name) && error.code === 'ENOENT') continue
                throw error
            }
            if (!(await thumbnailPolicy(root, name)) && hasPicture(loaded.bytes, category))
                throw new Error(`Local ${name}.scp has a picture that its lock entry leaves out`)
        } else {
            const override = env[`PREVIEW_${name.toUpperCase()}_URL`]
            loaded = override
                ? await downloadPackage(override, category, await thumbnailPolicy(root, name))
                : await lockedPackage(root, name, category)
        }
        const { bytes, ...metadata } = loaded
        const file = `resource/${name}.scp`
        await mkdir(join(destination, 'resource'), { recursive: true })
        await writeFile(join(destination, file), bytes)
        assets.push({
            file,
            ...metadata,
            bytes: bytes.length,
            sha256: sha256(bytes),
        })
    }
    return assets
}
