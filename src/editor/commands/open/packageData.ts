import { LEVEL_FILE_MAX_BYTES } from '../../../levelData/fileLimit'
import { inflateCapped } from '../../../levelData/gzip'
import { NXSP_CAPS } from '../../../local/nxsp/read'
import { scpBlackPng } from '../../../local/nxsp/scpMedia'
import { toWellFormed } from '../../../local/records/wellFormed'
import { sha1Hex } from '../../../preview/assets/files/item'
import { isSrl, type FilePackage, type Srl } from '../../../preview/assets/files/package'
import type { LevelInfo } from '../../../state/levelInfo'
import {
    FileUnreadableError,
    levelDataType,
    LevelUnreadableError,
    parseImported,
    UnsupportedFileError,
    type Parsed,
} from './levelData'

// A package level's data and media, read from the list item's SRLs. Kept free of the dialog so
// the reads and their messages can be tested in Node.

const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** Whether bytes match an SRL's SHA-1, when it has one (lowercased, as asset import checks). */
const matchesHash = async (srl: Srl, bytes: Uint8Array) => {
    const hash = srl?.hash
    if (hash === undefined || hash === null) return true
    return /^[0-9a-f]{40}$/i.test(hash) && (await sha1Hex(bytes)) === hash.toLowerCase()
}

/**
 * Reads, checks and parses a level's data through Open's level-data dispatch: Chart Cyanvas level
 * data or Next SEKAI level data, never USC or SUS. A chart that cannot be built is refused with
 * its reason; anything else that fails is `LevelUnreadableError`.
 */
export const readLevelData = async (
    pkg: FilePackage,
    item: Record<string, unknown>,
): Promise<Parsed> => {
    let json: unknown
    try {
        const srl = isSrl(item.data) ? item.data : undefined
        const path = pkg.resolve(srl)
        const bytes = path
            ? await pkg.entry(path, { type: 'level', part: 'data', maxSize: LEVEL_FILE_MAX_BYTES })
            : undefined
        if (!bytes) throw new Error('The level data is not in this file')
        if (!(await matchesHash(srl, bytes))) throw new Error('The level data fails its hash')
        // Sonolus requires gzip; plain JSON is read too, as Open reads it.
        const text = bytes[0] === 0x1f && bytes[1] === 0x8b ? inflateCapped(bytes) : bytes
        json = JSON.parse(new TextDecoder().decode(text))
    } catch (error) {
        if (isAbort(error)) throw error
        // A file that cannot be read any more is the file's doing, not the level's.
        if (error instanceof DOMException)
            throw new FileUnreadableError('The file could not be read', { cause: error })
        throw new LevelUnreadableError('The level data could not be read', { cause: error })
    }
    const type = levelDataType(json)
    if (!type) throw new LevelUnreadableError('The level data has no entities')
    try {
        return parseImported(type, json)
    } catch (error) {
        if (error instanceof UnsupportedFileError)
            throw new LevelUnreadableError('The level data is not level data', { cause: error })
        throw error
    }
}

/** The description in a level's detail entry; empty when it is missing or unreadable. */
export const readDescription = async (pkg: FilePackage, name: string) => {
    try {
        const raw = await pkg.json(`sonolus/levels/${name}`, 'level', 'details')
        return typeof raw === 'object' && raw !== null && 'description' in raw
            ? typeof raw.description === 'string'
                ? raw.description
                : ''
            : ''
    } catch {
        return ''
    }
}

export type MediaSlot = 'bgm' | 'cover' | 'preview'

/** A media resource of a level: none named, its bytes, or one the editor cannot use. */
type MediaRead =
    { kind: 'none' } | { kind: 'bytes'; bytes: Uint8Array } | { kind: 'unusable'; error?: unknown }

/** An SRL that names nothing: `{}`, a known absence. */
const namesNothing = (srl: Srl) => !srl?.url && !srl?.hash

/**
 * Reads one media entry from its SRL: its declared size within the project file's media cap and
 * the package's ratio guard, then its hash. The editor's own placeholders read as none.
 */
export const readMedia = async (
    pkg: FilePackage,
    item: Record<string, unknown>,
    slot: MediaSlot,
): Promise<MediaRead> => {
    const raw = item[slot]
    if (raw === undefined || raw === null) return { kind: 'none' }
    if (!isSrl(raw)) return { kind: 'unusable' }
    if (namesNothing(raw)) return { kind: 'none' }
    try {
        const path = pkg.resolve(raw)
        const bytes = path
            ? await pkg.entry(path, {
                  type: 'level',
                  part: slot === 'cover' ? 'image' : 'audio',
                  maxSize: NXSP_CAPS.media,
              })
            : undefined
        if (!bytes || !(await matchesHash(raw, bytes))) return { kind: 'unusable' }
        if (slot === 'cover' ? isBlackPng(bytes) : isSilentMp3(bytes)) return { kind: 'none' }
        return { kind: 'bytes', bytes }
    } catch (error) {
        if (isAbort(error)) throw error
        return { kind: 'unusable', error }
    }
}

let blackPng: Uint8Array | undefined

/** The cover a project file's package view holds when the project has none. */
export const isBlackPng = (bytes: Uint8Array) => {
    const black = (blackPng ??= scpBlackPng())
    return bytes.length === black.length && bytes.every((byte, i) => byte === black[i])
}

/** The silence a project file's package view holds when the project has no BGM. */
export const isSilentMp3 = (bytes: Uint8Array) => {
    if (bytes.length < 144 || bytes.length % 144 !== 0) return false
    // Every 144-byte frame is this header, then zeros.
    const header = [0xff, 0xfb, 0x18, 0xc0]
    return bytes.every((byte, at) => byte === (header[at % 144] ?? 0))
}

/**
 * The most Level Info text a package's level brings: a project file's `project.json` holds Level
 * Info and is refused past 1 MiB, so text past these bounds would make every Save of the session
 * fail. Real levels stay far below them.
 */
export const LEVEL_INFO_TEXT = { field: 1000, tag: 200, tags: 100, description: 100_000 }

/** Text cut to `max` characters, never inside a surrogate pair. */
const cut = (value: string, max: number) => {
    const characters = Array.from(toWellFormed(value))
    return characters.length > max ? characters.slice(0, max).join('') : characters.join('')
}

const text = (value: unknown) =>
    typeof value === 'string' ? cut(value, LEVEL_INFO_TEXT.field) : ''

/** Level Info from the list item, with the checks a project file's `metadata` gets. */
export const levelInfoOf = (item: Record<string, unknown>, description: string): LevelInfo => {
    const tags = Array.isArray(item.tags)
        ? (item.tags as unknown[])
              .flatMap((tag) =>
                  typeof tag === 'object' &&
                  tag !== null &&
                  'title' in tag &&
                  typeof tag.title === 'string'
                      ? [{ title: cut(tag.title, LEVEL_INFO_TEXT.tag) }]
                      : [],
              )
              .slice(0, LEVEL_INFO_TEXT.tags)
        : []
    return {
        title: text(item.title),
        artists: text(item.artists),
        author: text(item.author),
        description: cut(description, LEVEL_INFO_TEXT.description),
        tags,
        ...(typeof item.rating === 'number' && Number.isFinite(item.rating)
            ? { rating: item.rating }
            : {}),
    }
}
