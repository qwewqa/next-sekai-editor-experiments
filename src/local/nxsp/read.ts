import { LEVEL_VERSION } from '../../levelData/levelVersion'
import { isIgnoredEntry, type ZipEntry } from '../../zip/directory'
import { ZipError } from '../../zip/error'
import { ZipReader } from '../../zip/reader'
import { CHUNK_CAP, inflateStrict } from '../chunkVerify'
import { equalBytes, fromHex16, hash16, sha256, toHex } from '../hash'
import type { SnapshotRecords } from '../records/encode'
import { checkHeader, SchemaError } from '../records/schema'
import { decodeSnapshot } from '../records/snapshot'
import { isObject, JSON_DEPTH_CAP, JsonError, parseJsonBytes } from './json'
import {
    checkPart,
    combineParts,
    type HistoryForm,
    type ManifestForm,
    type SegmentForm,
} from './manifest'
import { readProject, type MediaForm, type ProjectExtra, type ProjectV1 } from './project'
import { NXSP_FORMAT, NXSP_MINOR, NXSP_VERSION } from './version'

// The `.nxsp` reader (§1.5.4, §1.6.11.4, §1.6.11.8): what a file holds, and a report of everything
// it didn't read. Any report makes the open partial; the open decides what to say. Damage (an
// ambiguous file, a cap passed, headers that disagree) means no history; so does a newer `minor`.

/** The reader caps (§1.6.11.4): no conforming writer reaches them. */
export type NxspCaps = {
    project: number
    level: number
    /** The manifest, and each segment. */
    manifest: number
    chunksBin: number
    chunk: number
    media: number
    depth: number
}

export const NXSP_CAPS: NxspCaps = {
    project: 1024 * 1024,
    level: 64 * 1024 * 1024,
    manifest: 256 * 1024 * 1024,
    chunksBin: 2 * 1024 * 1024 * 1024,
    chunk: CHUNK_CAP,
    media: 1024 * 1024 * 1024,
    depth: JSON_DEPTH_CAP,
}

/**
 * What a file holds that this build didn't read, each a reason the open is partial:
 * - `newer-version`: a higher major version, so only the level was read;
 * - `newer-minor`: a `minor` above this build's, so the history wasn't read;
 * - `newer-level`: a `levelVersion` above this build's;
 * - `unknown-entry`, `unknown-key`: content v1 doesn't name (`parts`' keys included);
 * - `invalid-key`: a known `project.json` key of the wrong form;
 * - `newer-history`: a manifest `version`, root `v`, entry kind or kind name this build doesn't know;
 * - `history-unreadable`: history that breaks v1's rules (§1.6.11.5);
 * - `damaged`: an ambiguous or oversized file, or one whose ZIP structure fails (§1.6.11.4);
 * - `media-unreadable`: a media entry missing or failing its size or SHA-256.
 */
export type ReportReason =
    | 'newer-version'
    | 'newer-minor'
    | 'newer-level'
    | 'unknown-entry'
    | 'unknown-key'
    | 'invalid-key'
    | 'newer-history'
    | 'history-unreadable'
    | 'damaged'
    | 'media-unreadable'

export type MediaKind = 'bgm' | 'cover' | 'preview'

export type ReportItem = { reason: ReportReason; path: string; detail?: string; media?: MediaKind }

/** Lazy access to `chunks.bin`: a chunk's stored form, or its canonical bytes verified against its hash. */
export type ChunkAccess = {
    readonly size: number
    stored: (hash: string) => Promise<Uint8Array>
    /** Inflated with the strict end check and the chunk cap, then hashed; throws on a mismatch. */
    read: (hash: string) => Promise<Uint8Array>
}

/** A history the open checked (§1.6.11.8): roots, nodes, the header chunks and the head's chunks. */
export type ReadHistory = HistoryForm & {
    chunks: ChunkAccess
    /** The head snapshot's records, decoded and schema-checked. */
    headRecords: SnapshotRecords
}

/** A media entry whose size and SHA-256 matched `project.json`. */
export type ReadMedia = { form: MediaForm & { file: string }; entry: ZipEntry; bytes: Blob }

export type NxspRead =
    /** A ZIP without `project.json`, or whose `format` isn't `nxsp`. */
    | { kind: 'not-project' }
    /** Nothing can be opened: not a readable ZIP, or `project.json` or `level.json` unreadable. */
    | { kind: 'unreadable'; report: ReportItem[] }
    | {
          kind: 'nxsp'
          open: 'full' | 'partial'
          /** The parsed `project.json`. */
          projectJson: Record<string, unknown>
          /** Its known fields; absent for a higher major version, where only the level is read. */
          project?: ProjectV1
          extra: ProjectExtra
          /** The parsed `level.json`. */
          level: unknown
          history?: ReadHistory
          media: Partial<Record<MediaKind, ReadMedia>>
          report: ReportItem[]
      }

class ReadFailure extends Error {
    constructor(readonly item: ReportItem) {
        super(item.path)
    }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Reads an entry within a cap; every failure is damage. */
const readEntry = async (reader: ZipReader, entry: ZipEntry, cap: number) => {
    try {
        return await reader.read(entry, { maxSize: cap })
    } catch (error) {
        if (error instanceof ZipError)
            throw new ReadFailure({ reason: 'damaged', path: entry.name, detail: describe(error) })
        throw error
    }
}

const readJson = async (reader: ZipReader, entry: ZipEntry, cap: number, depth: number) => {
    const bytes = await readEntry(reader, entry, cap)
    try {
        return parseJsonBytes(bytes, depth)
    } catch (error) {
        if (error instanceof JsonError)
            throw new ReadFailure({ reason: 'damaged', path: entry.name, detail: error.message })
        throw error
    }
}

const POINTER_PREFIXES = {
    level: 'level.json',
    bgm: 'bgm/',
    cover: 'assets/cover.',
    preview: 'assets/preview.',
    history: 'history/',
} as const

/**
 * Reads a `.nxsp` (§1.5.4). Caps default to §1.6.11.4's; tests pass smaller ones. The result's
 * report lists everything not read; with any item the open is partial.
 */
export const readNxsp = async (
    input: Uint8Array | Blob,
    caps: Partial<NxspCaps> = {},
): Promise<NxspRead> => {
    const cap: NxspCaps = { ...NXSP_CAPS, ...caps }
    const source = input instanceof Blob ? input : new Blob([new Uint8Array(input)])
    const report: ReportItem[] = []
    const damaged = (path: string, detail?: string) =>
        report.push({ reason: 'damaged', path, ...(detail === undefined ? {} : { detail }) })

    let reader: ZipReader
    try {
        reader = await ZipReader.open(source)
    } catch (error) {
        if (!(error instanceof ZipError)) throw error
        return {
            kind: 'unreadable',
            report: [{ reason: 'damaged', path: '', detail: describe(error) }],
        }
    }
    // A scan finds what a cut file still holds: never its history (§1.5.9).
    if (reader.recovered) damaged('', 'central directory')
    for (const name of reader.duplicates) damaged(name, 'two entries with this name')
    for (const name of reader.overlapping) damaged(name, 'overlapping data')

    try {
        const projectEntry = reader.get('project.json')
        if (!projectEntry) {
            if (reader.ambiguous.has('project.json')) return { kind: 'unreadable', report }
            return { kind: 'not-project' }
        }
        const projectJson = await readJson(reader, projectEntry, cap.project, cap.depth)
        if (!isObject(projectJson) || projectJson.format !== NXSP_FORMAT)
            return { kind: 'not-project' }

        const { version } = projectJson
        const newerMajor = Number.isSafeInteger(version) && (version as number) > NXSP_VERSION
        let project: ProjectV1 | undefined
        let extra: ProjectExtra = {}
        if (newerMajor)
            report.push({ reason: 'newer-version', path: 'version', detail: String(version) })
        else {
            if (version !== NXSP_VERSION) report.push({ reason: 'invalid-key', path: 'version' })
            const read = readProject(projectJson)
            project = read.project
            extra = read.extra
            for (const issue of read.issues) {
                const reason =
                    issue.reason === 'unknown-key'
                        ? 'unknown-key'
                        : issue.reason === 'schema'
                          ? 'invalid-key'
                          : 'damaged'
                report.push({ reason, path: issue.path })
            }
            if (project.minor > NXSP_MINOR)
                report.push({ reason: 'newer-minor', path: 'minor', detail: String(project.minor) })
            if (project.levelVersion > LEVEL_VERSION)
                report.push({
                    reason: 'newer-level',
                    path: 'levelVersion',
                    detail: String(project.levelVersion),
                })
        }

        // Pointers: each in its own prefix, no two naming one entry; every other entry is unknown.
        const pointers = project ? pointersOf(project) : []
        const named = new Map<string, string>()
        for (const { path, name, prefix } of pointers) {
            const key = name.normalize('NFC')
            if (
                prefix === 'level.json' ? key !== prefix : !key.startsWith(prefix) || key === prefix
            )
                damaged(path, `outside ${prefix}`)
            if (named.has(key)) damaged(path, `names the entry ${named.get(key) ?? ''} names`)
            named.set(key, path)
        }
        if (!newerMajor) {
            for (const entry of reader.entries) {
                if (isIgnoredEntry(entry) || entry.key === 'project.json' || named.has(entry.key))
                    continue
                report.push({ reason: 'unknown-entry', path: entry.name })
            }
        }

        // The level: from `level.json` always, the one name its pointer may hold.
        const levelEntry = reader.get('level.json')
        if (!levelEntry) {
            damaged('level.json', 'missing')
            return { kind: 'unreadable', report }
        }
        const level = await readJson(reader, levelEntry, cap.level, cap.depth)
        if (isObject(level)) {
            for (const key of Object.keys(level)) {
                if (key !== 'bgmOffset' && key !== 'entities')
                    report.push({ reason: 'unknown-key', path: `level.json.${key}` })
            }
        }

        const media: Partial<Record<MediaKind, ReadMedia>> = {}
        let history: ReadHistory | undefined
        if (project) {
            for (const kind of ['bgm', 'cover', 'preview'] as const) {
                const form = kind === 'bgm' ? project.bgm : project.metadata?.[kind]
                if (form?.file === undefined) continue
                const item = await readMedia(reader, form, kind, cap)
                if ('item' in item) report.push(item.item)
                else media[kind] = item
            }

            const isDamaged = report.some(({ reason }) => reason === 'damaged')
            const newerMinor = report.some(({ reason }) => reason === 'newer-minor')
            if (project.history && !isDamaged && !newerMinor) {
                const read = await readHistory(reader, project.history, cap)
                if ('history' in read) history = read.history
                else report.push(...read.items)
            }
        }

        return {
            kind: 'nxsp',
            open: report.length ? 'partial' : 'full',
            projectJson,
            ...(project ? { project } : {}),
            extra,
            level,
            ...(history ? { history } : {}),
            media,
            report,
        }
    } catch (error) {
        if (!(error instanceof ReadFailure)) throw error
        report.push(error.item)
        return { kind: 'unreadable', report }
    }
}

type Pointer = { path: string; name: string; prefix: string }

/** Every pointer in `project.json` (§1.6.11.4), with the prefix it must stay in. */
const pointersOf = (project: ProjectV1): Pointer[] => {
    const pointers: Pointer[] = [
        { path: 'level', name: project.level, prefix: POINTER_PREFIXES.level },
    ]
    if (project.bgm?.file !== undefined)
        pointers.push({ path: 'bgm.file', name: project.bgm.file, prefix: POINTER_PREFIXES.bgm })
    for (const kind of ['cover', 'preview'] as const) {
        const file = project.metadata?.[kind]?.file
        if (file !== undefined)
            pointers.push({
                path: `metadata.${kind}.file`,
                name: file,
                prefix: POINTER_PREFIXES[kind],
            })
    }
    const { history } = project
    if (history) {
        pointers.push({
            path: 'history.manifest',
            name: history.manifest,
            prefix: POINTER_PREFIXES.history,
        })
        pointers.push({
            path: 'history.chunks',
            name: history.chunks,
            prefix: POINTER_PREFIXES.history,
        })
        for (const [i, name] of (history.segments ?? []).entries())
            pointers.push({
                path: `history.segments[${i}]`,
                name,
                prefix: POINTER_PREFIXES.history,
            })
    }
    return pointers
}

/** A media entry, its size and full SHA-256 checked against `project.json` (§1.5.4). */
const readMedia = async (
    reader: ZipReader,
    form: MediaForm & { file: string },
    kind: MediaKind,
    cap: NxspCaps,
): Promise<ReadMedia | { item: ReportItem }> => {
    const path = kind === 'bgm' ? 'bgm.file' : `metadata.${kind}.file`
    const entry = reader.get(form.file)
    if (!entry || entry.isDirectory)
        return { item: { reason: 'media-unreadable', path, media: kind, detail: 'missing' } }
    if (entry.size > cap.media)
        return { item: { reason: 'damaged', path: entry.name, detail: 'over the media cap' } }
    let bytes: Uint8Array
    try {
        bytes = await reader.read(entry, { maxSize: cap.media })
    } catch (error) {
        if (!(error instanceof ZipError)) throw error
        return { item: { reason: 'damaged', path: entry.name, detail: describe(error) } }
    }
    if (bytes.length !== form.size || toHex(await sha256(bytes)) !== form.sha256)
        return {
            item: { reason: 'media-unreadable', path, media: kind, detail: 'size or SHA-256' },
        }
    return { form, entry, bytes: new Blob([new Uint8Array(bytes)]) }
}

/** Reads and checks the history (§1.6.11.5, §1.6.11.8): its parts, then the open's checks. */
const readHistory = async (
    reader: ZipReader,
    pointers: NonNullable<ProjectV1['history']>,
    cap: NxspCaps,
): Promise<{ history: ReadHistory } | { items: ReportItem[] }> => {
    const unreadable = (path: string, detail?: string) => ({
        items: [
            {
                reason: 'history-unreadable' as const,
                path,
                ...(detail === undefined ? {} : { detail }),
            },
        ],
    })
    const entryOf = (name: string) => {
        const entry = reader.get(name)
        if (!entry || entry.isDirectory)
            throw new ReadFailure({ reason: 'history-unreadable', path: name, detail: 'missing' })
        return entry
    }
    const issuesToItems = (issues: ReturnType<typeof checkPart>['issues']): ReportItem[] =>
        issues.map(({ reason, path, detail }) => ({
            reason:
                reason === 'damaged'
                    ? 'history-unreadable'
                    : reason === 'newer'
                      ? 'newer-history'
                      : 'unknown-key',
            path,
            ...(detail === undefined ? {} : { detail }),
        }))

    try {
        const segments: SegmentForm[] = []
        for (const [i, name] of (pointers.segments ?? []).entries()) {
            const value = await readJson(reader, entryOf(name), cap.manifest, cap.depth)
            const { part, issues } = checkPart(value, `segments[${i}]`, false)
            if (!part) return { items: issuesToItems(issues) }
            segments.push(part)
        }
        const manifestValue = await readJson(
            reader,
            entryOf(pointers.manifest),
            cap.manifest,
            cap.depth,
        )
        const checked = checkPart(manifestValue, 'manifest', true)
        if (!checked.part) return { items: issuesToItems(checked.issues) }

        const chunksEntry = entryOf(pointers.chunks)
        if (chunksEntry.size > cap.chunksBin)
            throw new ReadFailure({
                reason: 'damaged',
                path: chunksEntry.name,
                detail: 'over the chunks.bin cap',
            })
        const combined = combineParts(segments, checked.part as ManifestForm, {
            entries: pointers.entries,
            chunksSize: chunksEntry.size,
        })
        if (!combined.history) return { items: issuesToItems(combined.issues) }
        const history = combined.history
        const chunks = chunkAccess(reader, chunksEntry, history.index, cap)

        // What the open checks at once: every header chunk, and the head's chunks, decoded.
        const parsed = new Map<string, unknown>()
        const parsedChunk = async (hash: string) => {
            const known = parsed.get(hash)
            if (known !== undefined) return known
            const value = parseJsonBytes(await chunks.read(hash), cap.depth)
            parsed.set(hash, value)
            return value
        }
        for (const [key, root] of history.roots) {
            try {
                checkHeader(await parsedChunk(root[1] as string))
            } catch (error) {
                return unreadable(`roots.${key}`, describe(error))
            }
        }
        // `combineParts` resolved every reference, so the head's root and nodes are there.
        const headRoot = history.roots.get(history.head) ?? []
        try {
            for (const [, top] of headRoot[2] as [string, string][]) {
                const node = history.nodes.get(top) ?? []
                const children = node[2] as string[]
                const leaves =
                    node[1] === 0
                        ? children
                        : children.flatMap((child) => history.nodes.get(child)?.[2] as string[])
                for (const chunk of leaves) await parsedChunk(chunk)
            }
            const headRecords = decodeSnapshot(headRoot, {
                node: (hash) => history.nodes.get(hash),
                chunk: (hash) => parsed.get(hash),
            })
            return { history: { ...history, chunks, headRecords } }
        } catch (error) {
            if (
                error instanceof SchemaError ||
                error instanceof JsonError ||
                error instanceof Error
            )
                return unreadable(`roots.${history.head}`, describe(error))
            throw error
        }
    } catch (error) {
        if (error instanceof ReadFailure)
            return {
                items: [
                    {
                        ...error.item,
                        reason:
                            error.item.reason === 'damaged'
                                ? 'history-unreadable'
                                : error.item.reason,
                    },
                ],
            }
        throw error
    }
}

/**
 * `chunks.bin`, read lazily: a STORE entry by slices of the file (its CRC is never read whole; each
 * chunk is verified by its hash instead), a DEFLATE one (an OS re-zip) inflated once, capped at its
 * declared size.
 */
const chunkAccess = (
    reader: ZipReader,
    entry: ZipEntry,
    index: ReadonlyMap<string, { offset: number; length: number }>,
    cap: NxspCaps,
): ChunkAccess => {
    let whole: Promise<Uint8Array> | undefined
    let file: Promise<Blob> | undefined
    const range = async (offset: number, length: number) => {
        if (entry.method === 0) {
            if (entry.compressedSize !== entry.size) throw new ZipError('size', entry.name)
            file ??= reader.stored(entry)
            return new Uint8Array(await (await file).slice(offset, offset + length).arrayBuffer())
        }
        whole ??= reader.read(entry, { maxSize: cap.chunksBin })
        return (await whole).slice(offset, offset + length)
    }
    const stored = async (hash: string) => {
        const place = index.get(hash)
        if (!place) throw new Error(`No chunk ${hash}`)
        return range(place.offset, place.length)
    }
    return {
        size: entry.size,
        stored,
        read: async (hash) => {
            const canonical = inflateStrict(await stored(hash), cap.chunk)
            if (!equalBytes(await hash16(canonical), fromHex16(hash)))
                throw new Error(`Chunk ${hash} does not hash to its name`)
            return canonical
        },
    }
}
