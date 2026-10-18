import type { LevelInfo, MediaRef } from '../../state/levelInfo'
import { isHash16Hex } from '../hash'
import type { RecordValue } from '../records/canonical'
import { noteCountOf, type SnapshotRecords } from '../records/records'
import { toWellFormed } from '../records/wellFormed'
import { isObject } from './json'
import { NXSP_FORMAT, NXSP_VERSION } from './version'

// `project.json` v1 (§1.6.11.4): its fields, the pinned `metadata` mapping, `summary`, the media
// forms and the entry names the writer makes. Reading reports every unknown or invalid key.

/** A media item in `project.json`: with its bytes (`file`, `sha256`), or as metadata only (`hash`). */
export type MediaForm =
    | { file: string; filename?: string; type: string; sha256: string; size: number }
    | { file?: undefined; filename?: string; type: string; hash: string; size: number }

export type DeviceForm = { id: string; label: string }

export type RevisionForm = {
    id: string
    parent: string | null
    n: number
    savedAt: string
    device: DeviceForm
    ancestors: string[]
    replaces?: string
    fileName?: string
    completeFrom?: string
}

export type HistoryPointers = {
    manifest: string
    chunks: string
    entries: number
    segments?: string[]
}

export type SummaryForm = { noteCount: number; durationMs: number; revisionId: string }

export type MetadataForm = {
    title?: string
    artists?: string
    author?: string
    rating?: number
    tags?: { title: string; icon?: string }[]
    description?: string
    cover?: MediaForm
    preview?: MediaForm
}

/** `project.json`'s known fields, as read or as written. */
export type ProjectV1 = {
    format: typeof NXSP_FORMAT
    version: number
    minor: number
    levelVersion: number
    appVersion: string
    id: string
    lineageId: string
    revision?: RevisionForm
    name?: string
    exportName?: string
    level: string
    editor: { defaultGuideColors?: number[] }
    bgm?: MediaForm
    history?: HistoryPointers
    summary?: SummaryForm
    metadata?: MetadataForm
}

/** Unknown `project.json` keys (the chain's `extra`): top-level keys as they are, `metadata`'s under `metadata`. */
export type ProjectExtra = { [key: string]: unknown; metadata?: Record<string, unknown> }

/** The v1 top-level keys, in the order the writer writes them. */
export const PROJECT_KEYS = [
    'format',
    'version',
    'minor',
    'levelVersion',
    'appVersion',
    'id',
    'lineageId',
    'revision',
    'name',
    'exportName',
    'level',
    'editor',
    'bgm',
    'history',
    'summary',
    'metadata',
    'parts',
] as const

/** Why part of `project.json` was not read: each makes the open partial. */
export type ProjectIssue = {
    reason: 'unknown-key' | 'schema' | 'pointer' | 'limit' | 'damaged'
    path: string
}

// Reading

const isString = (value: unknown): value is string => typeof value === 'string'
const isUint = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0
const isId = (value: unknown): value is string => typeof value === 'string' && value !== ''
const isHex64 = (value: unknown): value is string =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** The most `history.segments` a reader accepts (§1.6.11.4). */
export const SEGMENT_CAP = 4096

/** Reads a media form; the issues name what's wrong. */
const readMedia = (value: unknown, path: string, issues: ProjectIssue[]) => {
    if (!isObject(value)) {
        issues.push({ reason: 'schema', path })
        return
    }
    const withFile = Object.hasOwn(value, 'file')
    const allowed = withFile
        ? ['file', 'filename', 'type', 'sha256', 'size']
        : ['filename', 'type', 'hash', 'size']
    let ok = true
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            issues.push({ reason: 'unknown-key', path: `${path}.${key}` })
            ok = false
        }
    }
    const { file, filename, type, sha256, hash, size } = value
    const valid =
        (!withFile || isString(file)) &&
        (filename === undefined || isString(filename)) &&
        isString(type) &&
        isUint(size) &&
        (withFile ? isHex64(sha256) : isHash16Hex(hash))
    if (!valid) {
        issues.push({ reason: 'schema', path })
        ok = false
    }
    if (!ok) return
    return value as MediaForm
}

const readRevision = (value: unknown, issues: ProjectIssue[]): RevisionForm | undefined => {
    if (value === undefined) return
    // Unknown keys inside `revision` are ignored: every write replaces it.
    const valid =
        isObject(value) &&
        isId(value.id) &&
        (value.parent === null || isId(value.parent)) &&
        isUint(value.n) &&
        isString(value.savedAt) &&
        isObject(value.device) &&
        isString(value.device.id) &&
        isString(value.device.label) &&
        Array.isArray(value.ancestors) &&
        value.ancestors.every(isId) &&
        (value.replaces === undefined || isString(value.replaces)) &&
        (value.fileName === undefined || isString(value.fileName))
    if (!valid) {
        issues.push({ reason: 'schema', path: 'revision' })
        return
    }
    const { id, parent, n, savedAt, device, ancestors, replaces, fileName, completeFrom } =
        value as Record<string, unknown> & RevisionForm
    return {
        id,
        parent,
        n,
        savedAt,
        device: { id: device.id, label: device.label },
        ancestors: [...ancestors],
        ...(replaces === undefined ? {} : { replaces }),
        ...(fileName === undefined ? {} : { fileName }),
        // A non-string value reads as absent.
        ...(isString(completeFrom) ? { completeFrom } : {}),
    }
}

const readHistory = (value: unknown, issues: ProjectIssue[]): HistoryPointers | undefined => {
    if (value === undefined) return
    if (!isObject(value)) {
        issues.push({ reason: 'schema', path: 'history' })
        return
    }
    let ok = true
    for (const key of Object.keys(value)) {
        // `media` is a retired name (r12 A5): unknown like any other key.
        if (!['manifest', 'chunks', 'entries', 'segments'].includes(key)) {
            issues.push({ reason: 'unknown-key', path: `history.${key}` })
            ok = false
        }
    }
    const { manifest, chunks, entries, segments } = value
    if (
        !isString(manifest) ||
        !isString(chunks) ||
        !isUint(entries) ||
        (segments !== undefined && !(Array.isArray(segments) && segments.every(isString)))
    ) {
        issues.push({ reason: 'schema', path: 'history' })
        return
    }
    if (Array.isArray(segments) && segments.length > SEGMENT_CAP) {
        issues.push({ reason: 'limit', path: 'history.segments' })
        return
    }
    if (!ok) return
    return { manifest, chunks, entries, ...(segments ? { segments: segments } : {}) }
}

const readSummary = (value: unknown): SummaryForm | undefined => {
    // Derived, so a bad or stale copy is ignored, never a reason to open partial.
    if (!isObject(value)) return
    const { noteCount, durationMs, revisionId } = value
    if (!isUint(noteCount) || !isUint(durationMs) || !isString(revisionId)) return
    return { noteCount, durationMs, revisionId }
}

const readEditor = (value: unknown, issues: ProjectIssue[]) => {
    if (value === undefined) return {}
    if (!isObject(value)) {
        issues.push({ reason: 'schema', path: 'editor' })
        return {}
    }
    for (const key of Object.keys(value)) {
        if (key !== 'defaultGuideColors')
            issues.push({ reason: 'unknown-key', path: `editor.${key}` })
    }
    const { defaultGuideColors } = value
    if (defaultGuideColors === undefined) return {}
    if (!Array.isArray(defaultGuideColors) || !defaultGuideColors.every(isUint)) {
        issues.push({ reason: 'schema', path: 'editor.defaultGuideColors' })
        return {}
    }
    return { defaultGuideColors: defaultGuideColors }
}

const readMetadata = (value: unknown, issues: ProjectIssue[]) => {
    if (value === undefined) return {}
    if (!isObject(value)) {
        issues.push({ reason: 'schema', path: 'metadata' })
        return {}
    }
    const metadata: MetadataForm = {}
    const extra: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        const path = `metadata.${key}`
        switch (key) {
            case 'title':
            case 'artists':
            case 'author':
            case 'description':
                if (isString(item)) metadata[key] = item
                else issues.push({ reason: 'schema', path })
                break
            case 'rating':
                if (typeof item === 'number' && Number.isFinite(item)) metadata.rating = item
                else issues.push({ reason: 'schema', path })
                break
            case 'tags': {
                if (!Array.isArray(item)) {
                    issues.push({ reason: 'schema', path })
                    break
                }
                const tags: { title: string; icon?: string }[] = []
                for (const [i, tag] of (item as unknown[]).entries()) {
                    if (
                        !isObject(tag) ||
                        !isString(tag.title) ||
                        (tag.icon !== undefined && !isString(tag.icon))
                    ) {
                        issues.push({ reason: 'schema', path: `${path}[${i}]` })
                        continue
                    }
                    for (const name of Object.keys(tag)) {
                        if (name !== 'title' && name !== 'icon')
                            issues.push({ reason: 'unknown-key', path: `${path}[${i}].${name}` })
                    }
                    tags.push({
                        title: tag.title,
                        ...(isString(tag.icon) ? { icon: tag.icon } : {}),
                    })
                }
                metadata.tags = tags
                break
            }
            case 'cover':
            case 'preview': {
                const media = readMedia(item, path, issues)
                if (media) metadata[key] = media
                break
            }
            default:
                extra[key] = item
        }
    }
    return { metadata, extra }
}

export type ProjectRead = {
    project: ProjectV1
    extra: ProjectExtra
    issues: ProjectIssue[]
}

/**
 * Reads a `project.json` whose `format` is `nxsp` and `version` is 1 (§1.6.11.4); the caller
 * checks those two first. Every unknown or invalid key is an issue, except where v1 keeps or
 * ignores it: unknown top-level and `metadata` keys go to `extra`, unknown keys in `revision`
 * and `summary` are ignored, and a non-string `completeFrom` reads as absent.
 */
export const readProject = (json: Record<string, unknown>): ProjectRead => {
    const issues: ProjectIssue[] = []
    const extra: ProjectExtra = {}
    for (const [key, value] of Object.entries(json)) {
        if (!(PROJECT_KEYS as readonly string[]).includes(key)) extra[key] = value
    }

    const { minor = 0, levelVersion, appVersion, id, lineageId, name, exportName, level } = json
    const required = (ok: boolean, path: string) => {
        if (!ok) issues.push({ reason: 'schema', path })
    }
    required(isUint(minor), 'minor')
    required(Number.isSafeInteger(levelVersion) && (levelVersion as number) >= 1, 'levelVersion')
    required(isString(appVersion), 'appVersion')
    required(isId(id), 'id')
    required(isId(lineageId), 'lineageId')
    required(name === undefined || isString(name), 'name')
    required(exportName === undefined || isString(exportName), 'exportName')
    required(isString(level), 'level')

    const revision = readRevision(json.revision, issues)
    const editor = readEditor(json.editor, issues)
    const bgm = json.bgm === undefined ? undefined : readMedia(json.bgm, 'bgm', issues)
    const history = readHistory(json.history, issues)
    const summary = readSummary(json.summary)
    const { metadata, extra: metadataExtra } = readMetadata(json.metadata, issues)
    if (metadataExtra && Object.keys(metadataExtra).length) extra.metadata = metadataExtra

    // Reserved: any key in `parts` is unknown, and `parts` is never kept.
    const { parts } = json
    if (parts !== undefined) {
        if (!isObject(parts)) issues.push({ reason: 'damaged', path: 'parts' })
        else
            for (const key of Object.keys(parts))
                issues.push({ reason: 'unknown-key', path: `parts.${key}` })
    }

    const project: ProjectV1 = {
        format: NXSP_FORMAT,
        version: NXSP_VERSION,
        minor: isUint(minor) ? minor : 0,
        levelVersion: Number.isSafeInteger(levelVersion) ? (levelVersion as number) : 1,
        appVersion: isString(appVersion) ? appVersion : '',
        id: isString(id) ? id : '',
        lineageId: isString(lineageId) ? lineageId : '',
        ...(revision ? { revision } : {}),
        ...(isString(name) ? { name } : {}),
        ...(isString(exportName) ? { exportName } : {}),
        level: isString(level) ? level : '',
        editor,
        ...(bgm ? { bgm } : {}),
        ...(history ? { history } : {}),
        ...(summary ? { summary } : {}),
        ...(metadata && Object.keys(metadata).length ? { metadata } : {}),
    }
    return { project, extra, issues }
}

/** The summary when it was computed for this revision (Part 0 §0.9.10's rule for derived keys). */
export const currentSummary = (project: ProjectV1) =>
    project.summary && project.summary.revisionId === project.revision?.id
        ? project.summary
        : undefined

/**
 * Where `revision.completeFrom` points, as placed (§1.6.11.6): the value when it is the file's own
 * id or among its `ancestors`, else the file's own id. `undefined` for a file without a revision.
 */
export const placedCompleteFrom = (revision: RevisionForm | undefined) => {
    if (!revision) return
    const { completeFrom, id, ancestors } = revision
    return completeFrom !== undefined && (completeFrom === id || ancestors.includes(completeFrom))
        ? completeFrom
        : id
}

// The pinned `metadata` mapping (§1.6.11.4)

/** A media form's `mediaRef`: the 16-byte prefix of `sha256`, or `hash`. */
export const mediaRefOf = (media: MediaForm, filename = media.filename ?? ''): MediaRef => ({
    hash: media.file === undefined ? media.hash : media.sha256.slice(0, 32),
    filename,
    size: media.size,
    type: media.type,
})

/** A `bgm`'s file name: `filename`, else the entry name after `bgm/` with `file`, else `""`. */
export const bgmFilenameOf = (bgm: MediaForm) =>
    bgm.filename ?? (bgm.file === undefined ? '' : bgm.file.normalize('NFC').slice('bgm/'.length))

/** `metadata`'s level info: absent strings are `""`, absent tags `[]`, an absent `filename` `""`. */
export const levelInfoOf = (metadata: MetadataForm | undefined): LevelInfo => {
    const m = metadata ?? {}
    return {
        title: m.title ?? '',
        artists: m.artists ?? '',
        author: m.author ?? '',
        description: m.description ?? '',
        tags: (m.tags ?? []).map((tag) => ({
            title: tag.title,
            ...(tag.icon === undefined ? {} : { icon: tag.icon }),
        })),
        ...(m.cover ? { cover: mediaRefOf(m.cover) } : {}),
        ...(m.preview ? { preview: mediaRefOf(m.preview) } : {}),
        ...(m.rating === undefined ? {} : { rating: m.rating }),
    }
}

/**
 * The `metadata` a writer writes for level info, with `cover` and `preview` in their forms:
 * empty strings and empty tags left out, and `undefined` when nothing is left.
 */
export const metadataOf = (
    info: LevelInfo,
    media: { cover?: MediaForm; preview?: MediaForm } = {},
): MetadataForm | undefined => {
    const metadata: MetadataForm = {
        ...(info.title ? { title: info.title } : {}),
        ...(info.artists ? { artists: info.artists } : {}),
        ...(info.author ? { author: info.author } : {}),
        ...(info.rating === undefined ? {} : { rating: info.rating }),
        ...(info.tags.length
            ? {
                  tags: info.tags.map((tag) => ({
                      title: tag.title,
                      ...(tag.icon === undefined ? {} : { icon: tag.icon }),
                  })),
              }
            : {}),
        ...(info.description ? { description: info.description } : {}),
        ...(media.cover ? { cover: media.cover } : {}),
        ...(media.preview ? { preview: media.preview } : {}),
    }
    return Object.keys(metadata).length ? metadata : undefined
}

// `summary` (§1.6.11.4)

/**
 * The head's `noteCount` and `durationMs`: the time of the latest note beat, summing the segments
 * between BPM changes in beat order with the first BPM applying from beat 0, each segment
 * `(end − start) * 60000 / bpm`, then `Math.round`; `0` without notes or BPM changes.
 */
export const summaryOf = (records: SnapshotRecords) => {
    const noteCount = noteCountOf(records.kinds)
    let last: number | undefined
    const bpms: (readonly RecordValue[])[] = []
    for (const { kind, records: items } of records.kinds) {
        if (kind === 'slides') {
            for (const { record } of items) {
                for (const note of record as readonly (readonly RecordValue[])[]) {
                    const beat = note[2] as number
                    if (last === undefined || beat > last) last = beat
                }
            }
        } else if (kind === 'bpms') {
            for (const { record } of items) bpms.push(record)
        }
    }
    let time = 0
    if (last !== undefined) {
        for (let i = 0; i < bpms.length; i++) {
            const start = i === 0 ? 0 : (bpms[i]?.[0] as number)
            const end = i + 1 < bpms.length ? (bpms[i + 1]?.[0] as number) : Infinity
            if (last <= start) break
            time += ((Math.min(last, end) - start) * 60000) / (bpms[i]?.[1] as number)
        }
    }
    const durationMs = Math.round(time)
    return {
        noteCount,
        durationMs: Number.isSafeInteger(durationMs) && durationMs > 0 ? durationMs : 0,
    }
}

// Entry names (§1.6.11.4)

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

/** The extensions of the media types `sniff` gives, for names without one. */
const TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/webm': 'webm',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
}

/**
 * A name's ASCII letters, digits, `-`, `_` and `.`, the rest dropped, with dots and spaces at either
 * end dropped (Part 0 §0.9.9) and runs of spaces between as one `-`.
 */
const asciiPart = (text: string) =>
    toWellFormed(text)
        .replace(/[^A-Za-z0-9._ -]/g, '')
        .replace(/^[ .]+|[ .]+$/g, '')
        .replace(/ +/g, '-')

/** The extension an entry name takes: the original's in ASCII, else the type's, else `bin`. */
const extensionOf = (filename: string, type: string) => {
    const at = filename.lastIndexOf('.')
    const own = at > 0 ? asciiPart(filename.slice(at + 1)) : ''
    return own || (TYPE_EXTENSIONS[type] ?? 'bin')
}

/** The longest ASCII stem the writer keeps, so a name stays far below every limit. */
const STEM_LIMIT = 120

/**
 * The BGM's entry name, `bgm/<stem>.<ext>` (§1.6.11.4): the stem is the original name's ASCII
 * part, with Part 0 §0.9.9's replacement (edge dots dropped, a reserved name given a `-`, a long
 * one cut), or `bgm` when nothing is left.
 */
export const bgmEntryName = (filename: string, type: string) => {
    const at = filename.lastIndexOf('.')
    let stem = asciiPart(at > 0 ? filename.slice(0, at) : filename)
        .slice(0, STEM_LIMIT)
        .replace(/\.+$/, '')
    if (RESERVED.test(stem)) stem += '-'
    return `bgm/${stem || 'bgm'}.${extensionOf(filename, type)}`
}

/** A cover's or preview's entry name, `assets/cover.<ext>` or `assets/preview.<ext>`. */
export const assetEntryName = (kind: 'cover' | 'preview', filename: string, type: string) =>
    `assets/${kind}.${extensionOf(filename, type)}`
