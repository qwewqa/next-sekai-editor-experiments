import { deflateRaw } from 'pako'
import { captureEntryDescription, captureStep, OperationDataError } from '../../history/operations'
import type { LevelInfo } from '../../state/levelInfo'
import { crc32 } from '../../zip/crc32'
import { dosFromDate } from '../../zip/writer'
import { isHash16Hex } from '../hash'
import type { RecordValue } from '../records/canonical'
import { rootVersion } from '../records/snapshot'
import { toWellFormed } from '../records/wellFormed'
import { checkDepth, isObject, setKey, wellFormedJson } from './json'
import {
    carriersIn,
    checkPart,
    type ChunkIndexItem,
    type EntryForm,
    type ManifestForm,
    type SegmentForm,
    type UndoStackForm,
} from './manifest'
import {
    ENTRY_LIMIT,
    PlanError,
    ZIP32_LIMIT,
    type PinnedSource,
    type PlanLimit,
    type PlannedEntry,
    type PlanPart,
    type SourceEntry,
    type WritePlan,
} from './plan'
import {
    assetEntryName,
    bgmEntryName,
    metadataOf,
    PROJECT_KEYS,
    SEGMENT_CAP,
    type DeviceForm,
    type HistoryPointers,
    type MediaForm,
    type ProjectExtra,
    type RevisionForm,
} from './project'
import { NXSP_CAPS, type NxspCaps } from './read'
import { MANIFEST_VERSION, minorOf, NXSP_FORMAT, NXSP_VERSION, patchOf } from './version'

// The shared builder (§1.6.11.7), its format half: from what a write holds, already decided by
// the history model (§1.6.11.6), it lays out `project.json`, `level.json`, the segments, the
// manifest, `chunks.bin` and the media by §1.6.11.4–§1.6.11.5's rules, as a plan. It reads no
// clock, random source or device itself, and never a source's bytes.

/** What the builder takes instead of reading a clock, a random source or the device. */
export type BuildContext = {
    /** Wall-clock milliseconds: `revision.savedAt`, and every entry's DOS time. */
    now: number
    newId: () => string
    device: DeviceForm
    appVersion: string
}

/** A media item the write includes: with its bytes (in hand, or copied whole from a source), or as metadata only. */
export type MediaInput =
    | { bytes: Uint8Array; sha256: string; type: string; filename: string }
    | {
          copy: { source: string; entryIndex: number }
          sha256: string
          type: string
          filename: string
      }
    | { hash: string; size: number; type: string; filename: string }

/** A chunk taken from storage or this tab: its stored form, and the row's CRC for the post-build check. */
export type InputChunk = { stored: Uint8Array; crc32: number }

/**
 * The history a write holds. With `append`, the source's history is copied whole first (its
 * segments and `chunks.bin` as copies, its manifest's values carried) and `entries` are the rows
 * after the cut; otherwise `entries` are the whole chronology. Either way the last is this write's
 * `save` entry, and every row without `kept: false` has its root in the file.
 */
export type HistoryInput = {
    /** The append source's token. */
    append?: string
    entries: readonly EntryForm[]
    /** JSON forms by hex hash: every root and node the new rows and the stack need. */
    roots: ReadonlyMap<string, readonly RecordValue[]>
    nodes: ReadonlyMap<string, readonly RecordValue[]>
    chunks: ReadonlyMap<string, InputChunk>
    undoStack: UndoStackForm
    /** Roots to hold that nothing new references. */
    otherRoots?: readonly string[]
}

export type BuildInput = {
    context: BuildContext
    id: string
    lineageId: string
    name?: string
    exportName?: string
    revision: {
        parent: string | null
        n: number
        /** Newest first, at most 1,024. */
        ancestors: readonly string[]
        replaces?: string
        fileName?: string
        /** The value to write with history; absent means the new revision's own id. Placed and clamped here. */
        completeFrom?: string
    }
    levelVersion: number
    /** The level data value `level.json` holds. */
    level: unknown
    editor: { defaultGuideColors?: readonly number[] }
    /** The head's note count and duration (`summaryOf`). */
    summary: { noteCount: number; durationMs: number }
    /** The head's level info; its cover and preview come from `media`. */
    levelInfo: LevelInfo
    /**
     * The head's BGM hash (32 hex), or `null` for a head without BGM; when given, a written `bgm`
     * must be it. Absent, the BGM isn't checked.
     */
    headBgm?: string | null
    media: { bgm?: MediaInput; cover?: MediaInput; preview?: MediaInput }
    extra?: ProjectExtra
    history?: HistoryInput
}

/** A chunk the plan takes as bytes, kept beside the plan for the post-build check (§1.5.6). */
export type PlannedChunk = { hash: string; offset: number; length: number; crc32: number }

export type BuildResult = {
    plan: WritePlan
    revisionId: string
    /** The `project.json` value written. */
    project: Record<string, unknown>
    storageChunks: PlannedChunk[]
}

/** The most entries a v0.6.0 segment holds (§1.6.11.5). */
export const SEGMENT_ENTRIES = 500

/** The most ancestors a v0.6.0 writer writes (Part 0 §0.9.3). */
export const ANCESTOR_LIMIT = 1024

/** `savedAt`: ISO 8601 UTC to the second. */
export const savedAtOf = (now: number) => new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z')

const fail = (message: string, limit?: PlanLimit): never => {
    throw new PlanError(message, limit)
}

/** The reader caps the builder keeps under (§1.6.11.4), and the segment count's. */
export type BuildCaps = NxspCaps & { segments: number }

const encoder = new TextEncoder()

const deflated = (bytes: Uint8Array): PlannedEntry['parts'] => [
    { kind: 'bytes', data: deflateRaw(bytes) },
]

/**
 * A planned entry for new JSON: deflated, with the CRC and size of its uncompressed bytes. Its
 * size and nesting are checked against the caps first, so nothing past them is deflated.
 */
const jsonEntry = (
    name: string,
    value: unknown,
    caps: BuildCaps,
    [cap, limit]: [number, PlanLimit],
): PlannedEntry => {
    const text = JSON.stringify(value)
    try {
        checkDepth(text, caps.depth)
    } catch {
        fail(`${name} nests deeper than ${caps.depth}`, 'depth')
    }
    const bytes = encoder.encode(text)
    if (bytes.length > cap) fail(`${name} is over its cap`, limit)
    return {
        name,
        method: 8,
        crc32: crc32(bytes),
        uncompressedSize: bytes.length,
        parts: deflated(bytes),
    }
}

const sourceOf = (sources: readonly PinnedSource[], token: string) =>
    sources.find((source) => source.token === token) ?? fail(`No source ${token}`)

const sourceEntry = (source: PinnedSource, index: number) =>
    source.entries[index] ?? fail(`No entry ${index} in ${source.token}`)

const entryByName = (source: PinnedSource, name: unknown) => {
    if (typeof name !== 'string') return fail(`${source.token}: no entry name`)
    const key = name.normalize('NFC')
    const [found, ...more] = source.entries.filter((entry) => entry.name.normalize('NFC') === key)
    return found && !more.length ? found : fail(`${source.token}: no single ${name}`)
}

/** A whole-entry copy: as stored, or inflated when the source deflated it and the entry is STORE. */
const copyPart = (source: PinnedSource, entry: SourceEntry, inflate: boolean): PlanPart => ({
    kind: 'copy',
    source: source.token,
    entryIndex: entry.index,
    dataOffset: entry.dataOffset,
    ...(inflate ? { inflate: true as const } : {}),
    check: { kind: 'entryCrc' },
})

/** A whole source entry copied as it is stored, keeping its method. */
const copiedEntry = (name: string, source: PinnedSource, entry: SourceEntry): PlannedEntry => ({
    name,
    method: entry.method,
    crc32: entry.crc32,
    uncompressedSize: entry.uncompressedSize,
    parts: [copyPart(source, entry, false)],
})

const withoutEmpty = (filename: string) => (filename ? { filename } : {})

/** A media item's form, and its entry when the write holds its bytes. */
const planMedia = (
    kind: 'bgm' | 'cover' | 'preview',
    input: MediaInput,
    sources: readonly PinnedSource[],
): { form: MediaForm; entry?: PlannedEntry } => {
    if ('hash' in input) {
        if (!isHash16Hex(input.hash)) fail(`${kind}: hash`)
        return {
            form: {
                ...withoutEmpty(input.filename),
                type: input.type,
                hash: input.hash,
                size: input.size,
            },
        }
    }
    if (!/^[0-9a-f]{64}$/.test(input.sha256)) fail(`${kind}: sha256`)
    const name =
        kind === 'bgm'
            ? bgmEntryName(input.filename, input.type)
            : assetEntryName(kind, input.filename, input.type)
    let entry: PlannedEntry
    if ('bytes' in input) {
        entry = {
            name,
            method: 0,
            crc32: crc32(input.bytes),
            uncompressedSize: input.bytes.length,
            parts: [{ kind: 'bytes', data: input.bytes }],
        }
    } else {
        const source = sourceOf(sources, input.copy.source)
        const from = sourceEntry(source, input.copy.entryIndex)
        entry = {
            name,
            method: 0,
            crc32: from.crc32,
            uncompressedSize: from.uncompressedSize,
            parts: [copyPart(source, from, from.method === 8)],
        }
    }
    const size = entry.uncompressedSize ?? 0
    return {
        form: {
            file: name,
            ...withoutEmpty(input.filename),
            type: input.type,
            sha256: input.sha256,
            size,
        },
        entry,
    }
}

const descriptionOf = <T>(capture: () => T): T => {
    try {
        return capture()
    } catch (error) {
        if (error instanceof OperationDataError) throw new PlanError(error.message)
        throw error
    }
}

/** An entry with its descriptive payload preserved and its keys in wire order. */
const entryForm = (entry: EntryForm): EntryForm => ({
    ...descriptionOf(() => captureEntryDescription(entry)),
    time: entry.time,
    snapshot: entry.snapshot,
    ...(entry.noteCount === undefined ? {} : { noteCount: entry.noteCount }),
    ...(entry.dirty ? { dirty: true as const } : {}),
    ...(entry.kept === false ? { kept: false as const } : {}),
    ...(entry.revisionId === undefined ? {} : { revisionId: toWellFormed(entry.revisionId) }),
    ...(entry.device
        ? { device: { id: toWellFormed(entry.device.id), label: toWellFormed(entry.device.label) } }
        : {}),
    ...(entry.appVersion === undefined ? {} : { appVersion: toWellFormed(entry.appVersion) }),
    ...(entry.stack
        ? {
              stack: {
                  keep: entry.stack.keep,
                  push: entry.stack.push.map((slot) => ({
                      snapshot: slot.snapshot,
                      step: descriptionOf(() => captureStep(slot.step)),
                  })),
                  index: entry.stack.index,
              },
          }
        : {}),
    ...(entry.x === undefined ? {} : { x: wellFormedJson(entry.x) as Record<string, unknown> }),
})

/** A part being filled in first-reference order. */
type Part = {
    entries: EntryForm[]
    roots: Record<string, RecordValue[]>
    nodes: Record<string, RecordValue[]>
    chunks: ChunkIndexItem[]
}

const emptyPart = (): Part => ({ entries: [], roots: {}, nodes: {}, chunks: [] })

/** Lays out the history's parts (§1.6.11.5): which entries, roots, nodes and chunks each holds. */
const planHistory = (history: HistoryInput, sources: readonly PinnedSource[]) => {
    const placedRoots = new Set<string>()
    const placedNodes = new Set<string>()
    const placedChunks = new Set<string>()
    const rootVs = new Set<number>()
    // The `x` carriers of the source's segments, which are copied whole.
    const sourceCarriers = new Set<string>()
    const entryKinds = new Set<string>()
    let cursor = 0
    const newChunks: Uint8Array[] = []
    const storageChunks: PlannedChunk[] = []

    // An append: the source's segments as copies, its `chunks.bin` as the prefix, its manifest's values.
    let source: PinnedSource | undefined
    let copiedSegments: SourceEntry[] = []
    let chunksPrefix: SourceEntry | undefined
    let carried: Part | undefined
    let carriedAsSegment = false
    let sourceEntries = 0
    if (history.append !== undefined) {
        source = sourceOf(sources, history.append)
        const project = source.projectJson
        const pointers =
            isObject(project) && isObject(project.history)
                ? project.history
                : fail('Append source without history')
        const parsed = source.manifest ?? fail('Append source without a manifest')
        const segmentNames = Array.isArray(pointers.segments)
            ? (pointers.segments as unknown[])
            : []
        if (segmentNames.length !== parsed.segments.length) fail('Append source segments')
        const from = source
        copiedSegments = segmentNames.map((name) => entryByName(from, name))
        chunksPrefix = entryByName(from, pointers.chunks)
        cursor = chunksPrefix.uncompressedSize

        const known = [
            ...parsed.segments.map((segment) => checkPart(segment, 'segment', false)),
            checkPart(parsed.manifest, 'manifest', true),
        ]
        if (known.some(({ part }) => !part)) fail('Append source history does not read')
        for (const segment of parsed.segments) carriersIn(segment, sourceCarriers)
        for (const { part } of known) {
            const { entries, roots, nodes, chunks } = part as SegmentForm
            sourceEntries += entries.length
            for (const entry of entries) entryKinds.add(entry.kind)
            for (const [key, root] of Object.entries(roots)) {
                placedRoots.add(key)
                rootVs.add(rootVersion(root) ?? 0)
            }
            for (const key of Object.keys(nodes)) placedNodes.add(key)
            for (const [hash] of chunks) placedChunks.add(hash)
        }
        const manifest = parsed.manifest as ManifestForm
        carried = {
            entries: manifest.entries,
            roots: manifest.roots,
            nodes: manifest.nodes,
            chunks: manifest.chunks,
        }
        carriedAsSegment = manifest.entries.length >= SEGMENT_ENTRIES
    }

    const rootOf = (hash: string) => history.roots.get(hash)
    const nodeOf = (hash: string) => history.nodes.get(hash)

    /** The nodes and chunks a root reaches, or `undefined` when one is in neither the file nor the input. */
    const closure = (hash: string) => {
        const root = rootOf(hash)
        if (!root) return
        const nodes: string[] = []
        const chunks: string[] = [root[1] as string]
        for (const [, top] of root[2] as [string, string][]) {
            const node = nodeOf(top)
            if (!node) {
                if (placedNodes.has(top)) continue
                return
            }
            nodes.push(top)
            const children = node[2] as string[]
            if (node[1] === 0) pushAll(chunks, children)
            else
                for (const child of children) {
                    const leaf = nodeOf(child)
                    if (!leaf) {
                        if (placedNodes.has(child)) continue
                        return
                    }
                    nodes.push(child)
                    pushAll(chunks, leaf[2] as string[])
                }
        }
        if (chunks.some((chunk) => !placedChunks.has(chunk) && !history.chunks.has(chunk))) return
        return { root, nodes, chunks }
    }

    const placeChunk = (hash: string, part: Part) => {
        if (placedChunks.has(hash)) return
        const chunk = history.chunks.get(hash) ?? fail(`Chunk ${hash} has no source`)
        placedChunks.add(hash)
        const length = chunk.stored.length
        part.chunks.push([hash, cursor, length])
        storageChunks.push({ hash, offset: cursor, length, crc32: chunk.crc32 })
        newChunks.push(chunk.stored)
        cursor += length
    }

    /** Places a root with its header chunk, kinds, nodes and chunks; `required` fails when it can't. */
    const visit = (hash: string, part: Part, required: boolean) => {
        if (placedRoots.has(hash)) return
        const reach = closure(hash)
        if (!reach) {
            if (required) fail(`Root ${hash} has no source or is incomplete`)
            return
        }
        placedRoots.add(hash)
        rootVs.add(rootVersion(reach.root) ?? 0)
        part.roots[hash] = [...reach.root]
        for (const node of reach.nodes) {
            if (placedNodes.has(node)) continue
            placedNodes.add(node)
            part.nodes[node] = [...(nodeOf(node) ?? fail(`Node ${node}`))]
        }
        for (const chunk of reach.chunks) placeChunk(chunk, part)
    }

    const walkEntries = (entries: readonly EntryForm[], part: Part) => {
        for (const entry of entries) {
            entryKinds.add(entry.kind)
            part.entries.push(entryForm(entry))
            const required = entry.kept !== false
            visit(entry.snapshot, part, required)
            for (const slot of entry.stack?.push ?? []) visit(slot.snapshot, part, required)
        }
    }

    const parts: Part[] = []
    const manifestPart = emptyPart()
    if (carried) {
        if (carriedAsSegment) parts.push(carried)
        else {
            pushAll(manifestPart.entries, carried.entries)
            Object.assign(manifestPart.roots, carried.roots)
            Object.assign(manifestPart.nodes, carried.nodes)
            pushAll(manifestPart.chunks, carried.chunks)
        }
        walkEntries(history.entries, manifestPart)
    } else {
        // The partition, pinned: segments of 500 while more than 500 remain.
        const { entries } = history
        let at = 0
        while (entries.length - at > SEGMENT_ENTRIES) {
            const part = emptyPart()
            walkEntries(entries.slice(at, at + SEGMENT_ENTRIES), part)
            parts.push(part)
            at += SEGMENT_ENTRIES
        }
        walkEntries(entries.slice(at), manifestPart)
    }
    for (const slot of history.undoStack.slots) visit(slot.snapshot, manifestPart, true)
    for (const hash of [...(history.otherRoots ?? [])].sort()) visit(hash, manifestPart, true)

    const last = history.entries.at(-1)
    if (last?.kind !== 'save') fail('The chronology does not end with this write’s save entry')
    const { base, index, slots } = history.undoStack
    if (index < base || index >= base + slots.length) fail('The undo stack’s index is out of range')

    return {
        source,
        copiedSegments,
        chunksPrefix,
        parts,
        manifestPart,
        newChunks,
        storageChunks,
        rootVs,
        entryKinds,
        sourceCarriers,
        total: sourceEntries + history.entries.length,
    }
}

/**
 * Builds the plan of a `.nxsp` (§1.6.11.4–§1.6.11.7). Throws `PlanError` on anything a v1
 * writer must not write: a reference without a source, a ZIP64 threshold, a value the minor
 * table lacks.
 */
export const planNxsp = (
    input: BuildInput,
    sources: readonly PinnedSource[] = [],
    capsOverride: Partial<BuildCaps> = {},
): BuildResult => {
    const caps: BuildCaps = { ...NXSP_CAPS, segments: SEGMENT_CAP, ...capsOverride }
    const { context, history } = input
    const revisionId = context.newId()
    const savedAt = savedAtOf(context.now)
    const modified = dosFromDate(new Date(savedAt))
    const ancestors = [...input.revision.ancestors]
    if (ancestors.length > ANCESTOR_LIMIT) fail('More than 1,024 ancestors')

    // Media: the head's, with its bytes or as metadata only.
    const media: Partial<
        Record<'bgm' | 'cover' | 'preview', { form: MediaForm; entry?: PlannedEntry }>
    > = {}
    for (const kind of ['bgm', 'cover', 'preview'] as const) {
        const item = input.media[kind]
        if (item) media[kind] = planMedia(kind, item, sources)
    }
    for (const kind of ['cover', 'preview'] as const) {
        const ref = input.levelInfo[kind]
        const form = media[kind]?.form
        if (!ref !== !form) fail(`The head’s ${kind} and the write’s disagree`)
        if (
            ref &&
            form &&
            (form.file === undefined ? form.hash : form.sha256.slice(0, 32)) !== ref.hash
        )
            fail(`The head’s ${kind} and the write’s disagree`)
    }
    // A written BGM is the head's (left out is allowed: unticked).
    const bgmForm = media.bgm?.form
    if (
        input.headBgm !== undefined &&
        bgmForm &&
        (bgmForm.file === undefined ? bgmForm.hash : bgmForm.sha256.slice(0, 32)) !== input.headBgm
    )
        fail('The head’s BGM and the write’s disagree')

    const laid = history ? planHistory(history, sources) : undefined
    const segmentEntries: PlannedEntry[] = []
    let manifestEntry: PlannedEntry | undefined
    let historyManifest: ManifestForm | undefined
    let chunksEntry: PlannedEntry | undefined
    let pointers: HistoryPointers | undefined
    if (laid && history) {
        const { source, copiedSegments, chunksPrefix, parts, manifestPart } = laid
        for (const entry of copiedSegments) {
            const name = `history/segments/${segmentEntries.length + 1}.json`
            segmentEntries.push(copiedEntry(name, source ?? fail('No append source'), entry))
        }
        for (const part of parts) {
            const name = `history/segments/${segmentEntries.length + 1}.json`
            const value: SegmentForm = {
                entries: part.entries,
                roots: part.roots,
                nodes: part.nodes,
                chunks: part.chunks,
            }
            segmentEntries.push(jsonEntry(name, value, caps, [caps.manifest, 'part']))
        }
        const manifest: ManifestForm = {
            version: MANIFEST_VERSION,
            entries: manifestPart.entries,
            roots: manifestPart.roots,
            nodes: manifestPart.nodes,
            chunks: manifestPart.chunks,
            undoStack: {
                base: history.undoStack.base,
                slots: history.undoStack.slots.map((slot) => ({
                    snapshot: slot.snapshot,
                    step: descriptionOf(() => captureStep(slot.step)),
                })),
                index: history.undoStack.index,
            },
        }
        // The builder checks its own parts against the reader's schema.
        for (const [value, isManifest] of [
            ...parts.map((part) => [part, false] as const),
            [manifest, true] as const,
        ]) {
            const { issues } = checkPart(value, isManifest ? 'manifest' : 'segment', isManifest)
            if (issues.length) fail(`The history breaks v1: ${issues[0]?.path ?? ''}`)
        }
        historyManifest = manifest
        manifestEntry = jsonEntry('history/manifest.json', manifest, caps, [caps.manifest, 'part'])

        const newBytes = concat(laid.newChunks)
        const chunkParts: PlanPart[] = []
        let crc = 0
        let size = 0
        if (chunksPrefix && source) {
            chunkParts.push(copyPart(source, chunksPrefix, chunksPrefix.method === 8))
            crc = chunksPrefix.crc32
            size = chunksPrefix.uncompressedSize
        }
        if (newBytes.length || !chunkParts.length)
            chunkParts.push({ kind: 'bytes', data: newBytes })
        chunksEntry = {
            name: 'history/chunks.bin',
            method: 0,
            crc32: crc32(newBytes, crc),
            uncompressedSize: size + newBytes.length,
            parts: chunkParts,
        }
        pointers = {
            manifest: 'history/manifest.json',
            chunks: 'history/chunks.bin',
            entries: laid.total,
            ...(segmentEntries.length
                ? { segments: segmentEntries.map((entry) => entry.name) }
                : {}),
        }
    }

    // `completeFrom`, placed and clamped (§1.6.11.6), with history only.
    let completeFrom: string | undefined
    if (history) {
        const value = input.revision.completeFrom ?? revisionId
        completeFrom =
            value === revisionId || ancestors.includes(value)
                ? value
                : (ancestors.at(-1) ?? revisionId)
    }

    const revision: RevisionForm = {
        id: revisionId,
        parent: input.revision.parent,
        n: input.revision.n,
        savedAt,
        device: { id: toWellFormed(context.device.id), label: toWellFormed(context.device.label) },
        ancestors,
        ...(input.revision.replaces === undefined ? {} : { replaces: input.revision.replaces }),
        ...(input.revision.fileName === undefined
            ? {}
            : { fileName: toWellFormed(input.revision.fileName) }),
        ...(completeFrom === undefined ? {} : { completeFrom }),
    }

    const bodyEntries = [
        ...segmentEntries,
        ...(manifestEntry ? [manifestEntry] : []),
        ...(chunksEntry ? [chunksEntry] : []),
        ...(media.cover?.entry ? [media.cover.entry] : []),
        ...(media.preview?.entry ? [media.preview.entry] : []),
        ...(media.bgm?.entry ? [media.bgm.entry] : []),
    ]
    const names = ['project.json', 'level.json', ...bodyEntries.map((entry) => entry.name)]
    let minor: number
    let patch: number
    try {
        // The `x` carriers the write holds, carried ones too: the table gives their `patch`.
        const carriers = new Set(laid?.sourceCarriers)
        for (const part of laid?.parts ?? []) carriersIn(part, carriers)
        carriersIn(historyManifest, carriers)
        patch = patchOf({ zipEntries: names, carriers })
        minor = minorOf({
            levelVersion: input.levelVersion,
            rootVs: laid?.rootVs ?? [],
            ...(laid ? { manifestVersion: MANIFEST_VERSION } : {}),
            entryKinds: laid?.entryKinds ?? [],
            zipEntries: names,
        })
    } catch (error) {
        // Content this build can't fully read is never written (§1.6.11.6).
        throw new PlanError(error instanceof Error ? error.message : String(error))
    }

    const metadata = metadataOf(input.levelInfo, {
        ...(media.cover ? { cover: media.cover.form } : {}),
        ...(media.preview ? { preview: media.preview.form } : {}),
    })
    const project = projectValue(
        {
            format: NXSP_FORMAT,
            version: NXSP_VERSION,
            minor,
            patch,
            levelVersion: input.levelVersion,
            appVersion: context.appVersion,
            id: input.id,
            lineageId: input.lineageId,
            revision,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.exportName === undefined ? {} : { exportName: input.exportName }),
            level: 'level.json',
            editor: input.editor.defaultGuideColors?.length
                ? { defaultGuideColors: [...input.editor.defaultGuideColors] }
                : {},
            ...(media.bgm ? { bgm: media.bgm.form } : {}),
            ...(pointers ? { history: pointers } : {}),
            summary: { ...input.summary, revisionId },
            ...(metadata ? { metadata } : {}),
        },
        input.extra,
    )

    const entries: PlannedEntry[] = [
        jsonEntry('project.json', project, caps, [caps.project, 'project']),
        jsonEntry('level.json', input.level, caps, [caps.level, 'level']),
        ...bodyEntries,
    ]
    checkLimits(entries, sources, caps)
    return {
        plan: { modified, entries },
        revisionId,
        project,
        storageChunks: laid?.storageChunks ?? [],
    }
}

/** `project.json`'s value: v1 keys in order, strings well-formed, then `extra`'s keys. */
const projectValue = (known: Record<string, unknown>, extra: ProjectExtra | undefined) => {
    const value = wellFormedJson(known) as Record<string, unknown>
    if (!extra) return value
    const { metadata: extraMetadata, ...top } = wellFormedJson(extra) as ProjectExtra
    for (const [key, item] of Object.entries(top)) {
        // `parts` is never kept, and a v1 key in `extra` would be a bug: both are left out.
        if (!(PROJECT_KEYS as readonly string[]).includes(key)) setKey(value, key, item)
    }
    if (isObject(extraMetadata)) {
        const metadata = isObject(value.metadata) ? value.metadata : {}
        for (const [key, item] of Object.entries(extraMetadata)) {
            if (!Object.hasOwn(metadata, key) && !METADATA_NAMES.includes(key))
                setKey(metadata, key, item)
        }
        if (Object.keys(metadata).length) value.metadata = metadata
    }
    return value
}

const METADATA_NAMES = [
    'title',
    'artists',
    'author',
    'rating',
    'tags',
    'description',
    'cover',
    'preview',
]

/** Appends one at a time: a spread of a long list would pass the engine's argument limit. */
const pushAll = <T>(to: T[], from: readonly T[]) => {
    for (const item of from) to.push(item)
}

const concat = (chunks: readonly Uint8Array[]) => {
    const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
    let at = 0
    for (const chunk of chunks) {
        out.set(chunk, at)
        at += chunk.length
    }
    return out
}

/** What a planned entry's stored data comes to, from its parts and the sources' directories. */
export const storedSize = (entry: PlannedEntry, sources: readonly PinnedSource[]) =>
    entry.parts.reduce((total, part) => {
        if (part.kind === 'bytes') return total + part.data.length
        const from = sourceEntry(sourceOf(sources, part.source), part.entryIndex)
        return total + (part.inflate ? from.uncompressedSize : from.compressedSize)
    }, 0)

/** The cap an entry's uncompressed size stays within, by its name (§1.6.11.4). */
const capOf = (name: string, caps: BuildCaps): [number, PlanLimit] | undefined => {
    if (name === 'project.json') return [caps.project, 'project']
    if (name === 'level.json') return [caps.level, 'level']
    if (name === 'history/chunks.bin') return [caps.chunksBin, 'chunks']
    if (name.startsWith('history/')) return [caps.manifest, 'part']
    if (name.startsWith('bgm/')) return [caps.media, 'bgm']
    if (name.startsWith('assets/cover.')) return [caps.media, 'cover']
    if (name.startsWith('assets/preview.')) return [caps.media, 'preview']
}

/**
 * Refuses, from planned sizes, a file a v1 reader would call damaged: past a reader cap (an
 * entry's size, the segment count) or needing ZIP64 (§1.6.11.4); and names that break v1.
 */
const checkLimits = (
    entries: readonly PlannedEntry[],
    sources: readonly PinnedSource[],
    caps: BuildCaps,
) => {
    if (entries.length >= ENTRY_LIMIT) fail('65,535 entries or more', 'zip64')
    const segments = entries.filter((entry) => entry.name.startsWith('history/segments/')).length
    if (segments > caps.segments) fail(`More than ${caps.segments} segments`, 'segments')
    const parts = entries
        .filter(
            (entry) =>
                entry.name.startsWith('history/segments/') ||
                entry.name === 'history/manifest.json',
        )
        .reduce((total, entry) => total + (entry.uncompressedSize ?? storedSize(entry, sources)), 0)
    if (parts > caps.history) fail('The history’s parts are over their cap together', 'history')
    const seen = new Set<string>()
    let offset = 0
    let directory = 0
    for (const entry of entries) {
        if (
            !/^[\x21-\x7e]+$/.test(entry.name) ||
            entry.name.startsWith('/') ||
            entry.name.split('/').includes('..') ||
            entry.name.endsWith('/')
        )
            fail(`Entry name ${entry.name}`)
        if (seen.has(entry.name)) fail(`Two entries named ${entry.name}`)
        seen.add(entry.name)
        const name = encoder.encode(entry.name).length
        const stored = storedSize(entry, sources)
        const size = entry.uncompressedSize ?? stored
        const cap = capOf(entry.name, caps)
        if (cap && size > cap[0]) fail(`${entry.name} is over its cap`, cap[1])
        if (offset >= ZIP32_LIMIT || stored >= ZIP32_LIMIT || size >= ZIP32_LIMIT)
            fail('A size or offset of 4 GB or more', 'zip64')
        offset += 30 + name + stored
        directory += 46 + name
    }
    if (offset >= ZIP32_LIMIT || directory >= ZIP32_LIMIT)
        fail('A size or offset of 4 GB or more', 'zip64')
}
