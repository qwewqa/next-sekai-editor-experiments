import type {
    BackgroundConfiguration,
    BackgroundData,
    EffectData,
    ParticleData,
    SkinData,
} from '@sonolus/core'
import type { AssetType } from '../types'
import type { DecodeImage } from './decodeImage'
import { AssetImportError, type ImportPart } from './errors'
import { readImageSize, type ImageSize } from './image'
import {
    checkBackgroundConfiguration,
    checkBackgroundData,
    checkEffectData,
    checkParticleData,
    checkSkinData,
    type CheckMode,
} from './itemData'
import { LIMITS } from './limits'
import { displayText, isSrl, parseDataJson, type SourcePackage, type Srl } from './package'

// Reading one item of a package and checking all of it: the same code at
// import, where a problem refuses the file with a message, and at load, where it falls back.

export type CheckedParts = {
    skin: { data: SkinData; texture: Uint8Array; size: ImageSize }
    particle: { data: ParticleData; texture: Uint8Array; size: ImageSize }
    background: {
        data: BackgroundData
        configuration: BackgroundConfiguration
        image: Uint8Array
        size: ImageSize
    }
    effect: { data: EffectData; audio: Uint8Array }
}

/** A resource of an item, as its SRL field names it. */
export type ResourceField = 'thumbnail' | 'data' | 'texture' | 'image' | 'configuration' | 'audio'

export type CheckedItem<T extends AssetType = AssetType> = {
    type: T
    name: string
    title: string
    subtitle: string
    author: string
    version: number | undefined
    /** The thumbnail's bytes, when it has a valid one. */
    thumbnail: Uint8Array | undefined
    /** The resources as they are stored (the thumbnail included), by field. */
    resources: Map<ResourceField, Uint8Array>
    parts: CheckedParts[T]
}

export type CheckContext = {
    mode: CheckMode
    /** The largest texture side the device takes (`gl.MAX_TEXTURE_SIZE`), at most 4096. */
    maxTextureSide: number
    signal?: AbortSignal
    /** Decodes the texture or the background image once its header passed: import's check. */
    decodeImage?: DecodeImage
}

const fields: Record<AssetType, ResourceField[]> = {
    skin: ['data', 'texture'],
    particle: ['data', 'texture'],
    background: ['data', 'image', 'configuration'],
    effect: ['data', 'audio'],
}

/** The part a field is named by in a message. */
const partOf = (field: ResourceField): ImportPart => field

const maxSizeOf = (field: ResourceField) => {
    switch (field) {
        case 'data':
            return LIMITS.dataGzip
        case 'audio':
            return LIMITS.effectAudio
        case 'configuration':
            return LIMITS.json
        case 'thumbnail':
            return LIMITS.thumbnail
        case 'texture':
        case 'image':
            return LIMITS.package
    }
}

const hex = (bytes: ArrayBuffer) =>
    [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')

/** The SHA-1 of a resource as 40 hex characters, which is what an SRL's hash names. */
export const sha1Hex = async (bytes: Uint8Array) =>
    hex(await crypto.subtle.digest('SHA-1', new Uint8Array(bytes)))

const checkHash = async (srl: Srl, bytes: Uint8Array, type: AssetType, field: ResourceField) => {
    // An absent or null hash means there is none to check.
    const hash = srl?.hash
    if (hash === undefined || hash === null) return
    const detail = { type, part: partOf(field) }
    if (!/^[0-9a-f]{40}$/i.test(hash)) throw new AssetImportError('checksum', detail)
    if ((await sha1Hex(bytes)) !== hash.toLowerCase())
        throw new AssetImportError('checksum', detail)
}

const checkImage = (
    bytes: Uint8Array,
    type: AssetType,
    field: ResourceField,
    limit: number,
): ImageSize => {
    const detail = { type, part: partOf(field) }
    const size = readImageSize(bytes)
    if (!size) throw new AssetImportError('notImage', detail)
    if (size.width > limit || size.height > limit)
        throw new AssetImportError('imageSize', { ...detail, ...size, limit })
    return size
}

const imageLimit = (type: AssetType, field: ResourceField, maxTextureSide: number) =>
    field === 'thumbnail'
        ? LIMITS.thumbnailSide
        : Math.min(
              type === 'background' ? LIMITS.backgroundSide : LIMITS.textureSide,
              maxTextureSide,
          )

/**
 * Reads and checks one item of a package. Everything is verified before anything is decoded:
 * the schemas, the caps, the images' headers and any SRL hash.
 */
export const checkItem = async <T extends AssetType>(
    pkg: SourcePackage,
    type: T,
    name: string,
    context: CheckContext,
): Promise<CheckedItem<T>> => {
    const raw = await pkg.details(type, name)
    if (!raw) throw new AssetImportError('missing', { type, part: 'details' })

    const resources = new Map<ResourceField, Uint8Array>()
    const read = async (field: ResourceField, required: boolean) => {
        const srl: unknown = raw[field]
        if (srl !== undefined && srl !== null && !isSrl(srl))
            throw new AssetImportError('unreadable', { type, part: partOf(field) })
        const path = pkg.resolve(srl)
        const bytes = path
            ? await pkg.entry(path, {
                  type,
                  part: partOf(field),
                  maxSize: maxSizeOf(field),
              })
            : undefined
        if (!bytes) {
            if (required) throw new AssetImportError('missing', { type, part: partOf(field) })
            return
        }
        await checkHash(srl, bytes, type, field)
        resources.set(field, bytes)
        return bytes
    }

    const need = async (field: ResourceField) => {
        const bytes = await read(field, true)
        if (!bytes) throw new AssetImportError('missing', { type, part: partOf(field) })
        return bytes
    }

    // A thumbnail that is there must be a small image; one that is not there is no matter.
    // A stored package loads without its thumbnail, which only the lists show.
    const thumbnail = context.mode === 'import' ? await read('thumbnail', false) : undefined
    if (thumbnail) checkImage(thumbnail, type, 'thumbnail', LIMITS.thumbnailSide)

    const have = new Map<ResourceField, Uint8Array>()
    for (const field of fields[type]) have.set(field, await need(field))
    const get = (field: ResourceField) => {
        const bytes = have.get(field)
        if (!bytes) throw new AssetImportError('missing', { type, part: partOf(field) })
        return bytes
    }
    const data = () => parseDataJson(get('data'), type)
    const size = (field: ResourceField) =>
        checkImage(get(field), type, field, imageLimit(type, field, context.maxTextureSide))
    // The body decodes only after the header's size passed, so nothing large is decoded.
    const decoded = async (field: ResourceField, imageSize: ImageSize) => {
        try {
            await context.decodeImage?.(get(field), imageSize.format)
        } catch (error) {
            throw new AssetImportError(
                'unreadable',
                { type, part: partOf(field) },
                { cause: error },
            )
        }
        return imageSize
    }

    let parts: CheckedParts[AssetType]
    switch (type) {
        case 'skin':
            parts = {
                data: checkSkinData(data(), context.mode),
                texture: get('texture'),
                size: await decoded('texture', size('texture')),
            }
            break
        case 'particle':
            parts = {
                data: checkParticleData(data()),
                texture: get('texture'),
                size: await decoded('texture', size('texture')),
            }
            break
        case 'background': {
            const configuration = parseDataJson(
                get('configuration'),
                type,
                'configuration',
                LIMITS.json,
            )
            parts = {
                data: checkBackgroundData(data()),
                configuration: checkBackgroundConfiguration(configuration),
                image: get('image'),
                size: await decoded('image', size('image')),
            }
            break
        }
        case 'effect':
            parts = { data: checkEffectData(data()), audio: get('audio') }
            break
    }

    const version = typeof raw.version === 'number' ? raw.version : undefined
    return {
        type,
        name,
        title: displayText(raw.title) || name,
        subtitle: displayText(raw.subtitle),
        author: displayText(raw.author),
        version,
        thumbnail,
        resources,
        parts: parts as CheckedParts[T],
    }
}
