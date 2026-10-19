import {
    captureEntryDescription,
    captureStep,
    type EntryDescription,
    type UndoableStep,
} from '../../history/operations'
import { hash16Sync, isHash16Hex, toHex } from '../hash'
import { canonicalBytes, type RecordValue } from '../records/canonical'
import { checkRecord, kindNames, SchemaError, type KindName } from '../records/schema'
import { checkRoot, rootVersion } from '../records/snapshot'
import { RECORDS_V } from '../records/version'
import { isObject } from './json'
import type { DeviceForm } from './project'
import { MANIFEST_VERSION } from './version'

// `history/manifest.json` and the segments (§1.6.11.5): the entry form, the strict schema of every
// part (an unknown key anywhere outside `x` makes the open partial), and what the parts must hold
// together: one value per key, an index that tiles `chunks.bin`, every root and node under its own
// hash and valid, and every reference resolved.

export const ENTRY_KINDS = [
    'init',
    'continue',
    'edit',
    'undo',
    'redo',
    'restore',
    'save',
    'export',
    'recovered',
] as const

export type EntryKindForm = (typeof ENTRY_KINDS)[number]

export type SlotForm = { snapshot: string; step: UndoableStep }

/** An entry as a file holds it: hashes in hex, `dirty` and `kept` only when unusual. */
export type EntryForm = EntryDescription & {
    time: number
    snapshot: string
    noteCount: number
    dirty?: true
    kept?: false
    revisionId?: string
    device?: DeviceForm
    stack?: { keep: number; push: SlotForm[]; index: number }
    x?: Record<string, unknown>
}

/** `[hash, offset, length]`: where a chunk's stored form is in `chunks.bin`. */
export type ChunkIndexItem = [string, number, number]

export type UndoStackForm = { base: number; slots: SlotForm[]; index: number }

export type SegmentForm = {
    entries: EntryForm[]
    roots: Record<string, RecordValue[]>
    nodes: Record<string, RecordValue[]>
    chunks: ChunkIndexItem[]
}

export type ManifestForm = { version: number } & SegmentForm & { undoStack: UndoStackForm }

/**
 * Why a history was not read (§1.6.11.5, §1.6.11.8): `newer` content (a manifest `version`, a
 * root `v`, an entry kind or a root's kind name this build doesn't know), an `unknown-key`
 * outside `x`, or `damaged` history (a broken rule). Each makes the open partial.
 */
export type HistoryIssue = {
    reason: 'newer' | 'unknown-key' | 'damaged'
    path: string
    detail?: string
}

/** The most issues a part or a history reports; past it, one more says how many were left out. */
export const ISSUE_CAP = 20

/** Issues collected up to `ISSUE_CAP`, the rest only counted, so a huge bad part can't fill memory. */
class Issues {
    readonly items: HistoryIssue[] = []
    private more = 0
    private moreReason: HistoryIssue['reason'] = 'damaged'

    get length() {
        return this.items.length + this.more
    }

    push(issue: HistoryIssue) {
        if (this.items.length < ISSUE_CAP) this.items.push(issue)
        else if (this.more++ === 0) this.moreReason = issue.reason
        return this.length
    }

    /** The issues, with "and N more" when some were left out. */
    done(path: string): HistoryIssue[] {
        if (!this.more) return this.items
        return [...this.items, { reason: this.moreReason, path, detail: `and ${this.more} more` }]
    }
}

const isUint = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0
const isString = (value: unknown): value is string => typeof value === 'string'

const unknownKeys = (
    value: Record<string, unknown>,
    known: readonly string[],
    path: string,
    issues: Issues,
) => {
    for (const key of Object.keys(value)) {
        if (!known.includes(key)) issues.push({ reason: 'unknown-key', path: `${path}.${key}` })
    }
}

const ENTRY_KEYS = [
    'kind',
    'time',
    'operation',
    'recoveryContext',
    'step',
    'snapshot',
    'noteCount',
    'dirty',
    'kept',
    'revisionId',
    'device',
    'stack',
    'x',
]

const checkSlot = (value: unknown, path: string, issues: Issues) => {
    if (!isObject(value)) return issues.push({ reason: 'damaged', path })
    unknownKeys(value, ['snapshot', 'step'], path, issues)
    if (!isHash16Hex(value.snapshot)) issues.push({ reason: 'damaged', path })
    try {
        captureStep(value.step)
    } catch {
        issues.push({ reason: 'damaged', path: `${path}.step` })
    }
}

/** Checks one entry of the entry form; returns false when it can't be used. */
const checkEntry = (value: unknown, path: string, issues: Issues) => {
    const before = issues.length
    if (!isObject(value)) {
        issues.push({ reason: 'damaged', path })
        return false
    }
    unknownKeys(value, ENTRY_KEYS, path, issues)
    const { kind, time, snapshot, noteCount, dirty, kept, revisionId, device, stack, x } = value
    // An unknown kind is newer content: its fields are that kind's, so nothing else is checked.
    if (isString(kind) && !(ENTRY_KINDS as readonly string[]).includes(kind)) {
        issues.push({ reason: 'newer', path: `${path}.kind`, detail: kind })
        return false
    }
    if (!isString(kind)) issues.push({ reason: 'damaged', path: `${path}.kind` })
    const fail = (key: string) => issues.push({ reason: 'damaged', path: `${path}.${key}` })
    // A field another kind has: a key this kind doesn't (§1.6.11.8).
    const foreign = (key: string) => issues.push({ reason: 'unknown-key', path: `${path}.${key}` })
    if (!isUint(time)) fail('time')
    try {
        captureEntryDescription(value)
    } catch {
        fail('description')
    }
    if (!isHash16Hex(snapshot)) fail('snapshot')
    if (!isUint(noteCount)) fail('noteCount')
    if (dirty !== undefined && dirty !== true) fail('dirty')
    if (kept !== undefined && kept !== false) fail('kept')

    // `revisionId` and `device` on `save` entries, `stack` on `recovered` ones: required there, and
    // a schema violation anywhere else.
    if (kind === 'save') {
        if (!isString(revisionId)) fail('revisionId')
        if (!isObject(device) || !isString(device.id) || !isString(device.label)) fail('device')
        else unknownKeys(device, ['id', 'label'], `${path}.device`, issues)
    } else {
        if (revisionId !== undefined) foreign('revisionId')
        if (device !== undefined) foreign('device')
    }
    if (kind === 'recovered') {
        if (
            !isObject(stack) ||
            !isUint(stack.keep) ||
            !isUint(stack.index) ||
            !Array.isArray(stack.push)
        )
            fail('stack')
        else {
            unknownKeys(stack, ['keep', 'push', 'index'], `${path}.stack`, issues)
            for (const [i, slot] of (stack.push as unknown[]).entries())
                checkSlot(slot, `${path}.stack.push[${i}]`, issues)
        }
    } else if (stack !== undefined) foreign('stack')
    if (x !== undefined && !isObject(x)) fail('x')
    return issues.length === before
}

const checkHashMap = (value: unknown, path: string, issues: Issues) => {
    if (!isObject(value)) {
        issues.push({ reason: 'damaged', path })
        return false
    }
    for (const key of Object.keys(value)) {
        if (!isHash16Hex(key)) issues.push({ reason: 'damaged', path: `${path}.${key}` })
    }
    return true
}

const checkChunkIndex = (value: unknown, path: string, issues: Issues) => {
    if (!Array.isArray(value)) {
        issues.push({ reason: 'damaged', path })
        return false
    }
    for (const [i, item] of (value as unknown[]).entries()) {
        if (
            !Array.isArray(item) ||
            item.length !== 3 ||
            !isHash16Hex(item[0]) ||
            !isUint(item[1]) ||
            !isUint(item[2])
        )
            issues.push({ reason: 'damaged', path: `${path}[${i}]` })
    }
    return true
}

/**
 * Checks a segment, or with `manifest` the manifest, against v1's form. A manifest `version` above
 * 1 is newer and checked no further. The value is the part when nothing was found.
 */
export const checkPart = (
    value: unknown,
    path: string,
    manifest: boolean,
): { part?: SegmentForm | ManifestForm; issues: HistoryIssue[] } => {
    const issues = new Issues()
    if (!isObject(value)) return { issues: [{ reason: 'damaged', path }] }
    if (manifest) {
        const { version } = value
        if (!Number.isSafeInteger(version) || (version as number) < 1)
            return { issues: [{ reason: 'damaged', path: `${path}.version` }] }
        if (version !== MANIFEST_VERSION)
            return {
                issues: [{ reason: 'newer', path: `${path}.version`, detail: String(version) }],
            }
    }
    const keys = [
        'entries',
        'roots',
        'nodes',
        'chunks',
        ...(manifest ? ['version', 'undoStack'] : []),
    ]
    unknownKeys(value, keys, path, issues)
    const { entries, roots, nodes, chunks } = value
    if (!Array.isArray(entries)) issues.push({ reason: 'damaged', path: `${path}.entries` })
    else
        for (const [i, entry] of (entries as unknown[]).entries())
            checkEntry(entry, `${path}.entries[${i}]`, issues)
    checkHashMap(roots, `${path}.roots`, issues)
    checkHashMap(nodes, `${path}.nodes`, issues)
    checkChunkIndex(chunks, `${path}.chunks`, issues)
    if (manifest) {
        const { undoStack } = value
        if (
            !isObject(undoStack) ||
            !isUint(undoStack.base) ||
            !isUint(undoStack.index) ||
            !Array.isArray(undoStack.slots)
        )
            issues.push({ reason: 'damaged', path: `${path}.undoStack` })
        else {
            unknownKeys(undoStack, ['base', 'slots', 'index'], `${path}.undoStack`, issues)
            for (const [i, slot] of (undoStack.slots as unknown[]).entries())
                checkSlot(slot, `${path}.undoStack.slots[${i}]`, issues)
        }
    }
    return issues.length
        ? { issues: issues.done(path) }
        : { part: value as SegmentForm | ManifestForm, issues: [] }
}

/** A history whose parts were checked and put together (§1.6.11.5). */
export type HistoryForm = {
    /** The chronology: the segments' entries in order, then the manifest's. */
    entries: EntryForm[]
    roots: Map<string, RecordValue[]>
    nodes: Map<string, RecordValue[]>
    /** Where each chunk's stored form is in `chunks.bin`. */
    index: Map<string, { offset: number; length: number }>
    undoStack: UndoStackForm
    /** The head snapshot: `undoStack.slots[index − base].snapshot`. */
    head: string
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Puts checked parts together (segments in order, the manifest last) and checks what they must
 * hold together (§1.6.11.5): one value per key, the index tiling `chunks.bin` exactly, every root
 * and node hashing to its key and valid, every reference resolved, the stack in range, and
 * `history.entries` equal to the entry count.
 */
export const combineParts = (
    segments: readonly SegmentForm[],
    manifest: ManifestForm,
    expected: { entries: number; chunksSize: number },
): { history?: HistoryForm; issues: HistoryIssue[] } => {
    const issues = new Issues()
    const damaged = (path: string, detail?: string) =>
        issues.push({ reason: 'damaged', path, ...(detail === undefined ? {} : { detail }) })
    const entries: EntryForm[] = []
    const roots = new Map<string, RecordValue[]>()
    const nodes = new Map<string, RecordValue[]>()
    const index = new Map<string, { offset: number; length: number }>()
    let next = 0
    for (const [p, part] of [...segments, manifest].entries()) {
        // One at a time: a spread of a huge part would pass the engine's argument limit.
        for (const entry of part.entries) entries.push(entry)
        for (const [map, values, name] of [
            [roots, part.roots, 'roots'],
            [nodes, part.nodes, 'nodes'],
        ] as const) {
            for (const [key, value] of Object.entries(values)) {
                const known = map.get(key)
                if (known !== undefined && !sameValue(known, value))
                    damaged(`${name}.${key}`, 'two values')
                map.set(key, value)
            }
        }
        for (const [hash, offset, length] of part.chunks) {
            if (index.has(hash)) damaged(`chunks.${hash}`, 'listed twice')
            if (offset !== next) damaged(`chunks.${hash}`, `part ${p + 1} does not tile chunks.bin`)
            index.set(hash, { offset, length })
            next = offset + length
        }
    }
    if (next !== expected.chunksSize) damaged('chunks', 'does not end at the end of chunks.bin')
    if (entries.length !== expected.entries) damaged('history.entries', `${entries.length} entries`)

    // Every root and node under its own hash, of a known `v`, valid (§1.6.11.1).
    const nodeKinds = new Map<string, { kind: KindName; depth: number }>()
    for (const [key, json] of nodes) {
        try {
            checkRecord('node', json)
            const [kind, depth] = json as [KindName, number]
            if (depth !== 0 && depth !== 1) throw new SchemaError('node.depth', 'expected 0 or 1')
            if (toHex(hash16Sync(canonicalBytes(json))) !== key)
                throw new SchemaError('node', 'hash')
            nodeKinds.set(key, { kind, depth })
        } catch (error) {
            if (isUnknownKind(json))
                issues.push({ reason: 'newer', path: `nodes.${key}`, detail: String(json[0]) })
            else damaged(`nodes.${key}`, error instanceof Error ? error.message : undefined)
        }
    }
    for (const [key, { kind, depth }] of nodeKinds) {
        for (const child of nodes.get(key)?.[2] as string[]) {
            if (depth === 0) {
                if (!index.has(child)) damaged(`nodes.${key}`, `chunk ${child} missing`)
            } else {
                const leaf = nodeKinds.get(child)
                if (leaf?.kind !== kind || leaf.depth !== 0)
                    damaged(`nodes.${key}`, `child ${child} missing or invalid`)
            }
        }
    }
    for (const [key, json] of roots) {
        const v = rootVersion(json)
        if (v !== undefined && v > RECORDS_V) {
            issues.push({ reason: 'newer', path: `roots.${key}`, detail: `v ${v}` })
            continue
        }
        try {
            checkRoot(json)
            if (toHex(hash16Sync(canonicalBytes(json))) !== key)
                throw new SchemaError('root', 'hash')
        } catch (error) {
            if (hasUnknownKindName(json)) issues.push({ reason: 'newer', path: `roots.${key}` })
            else damaged(`roots.${key}`, error instanceof Error ? error.message : undefined)
            continue
        }
        // Every node's direct references were checked once, including orphan nodes.
        const [, header, kinds] = json as [number, string, [KindName, string][]]
        if (!index.has(header)) damaged(`roots.${key}`, `header chunk ${header} missing`)
        for (const [kind, top] of kinds) {
            if (nodeKinds.get(top)?.kind !== kind)
                damaged(`roots.${key}`, `node ${top} missing or of another kind`)
        }
    }

    // References: every row without `kept: false`, its pushes, and every stack slot.
    const held = (hash: string, path: string) => {
        if (!roots.has(hash)) damaged(path, `root ${hash} missing`)
    }
    for (const [i, entry] of entries.entries()) {
        if (entry.kept === false) continue
        held(entry.snapshot, `entries[${i}]`)
        for (const [j, slot] of (entry.stack?.push ?? []).entries())
            held(slot.snapshot, `entries[${i}].stack.push[${j}]`)
    }
    const { undoStack } = manifest
    for (const [i, slot] of undoStack.slots.entries()) held(slot.snapshot, `undoStack.slots[${i}]`)
    const head = undoStack.slots[undoStack.index - undoStack.base]?.snapshot
    if (undoStack.index < undoStack.base || head === undefined)
        damaged('undoStack.index', 'out of range')

    if (issues.length || head === undefined) return { issues: issues.done('history') }
    return { history: { entries, roots, nodes, index, undoStack, head }, issues: [] }
}

const isUnknownKind = (json: unknown) =>
    Array.isArray(json) &&
    typeof json[0] === 'string' &&
    !(kindNames as readonly string[]).includes(json[0])

const hasUnknownKindName = (json: unknown) =>
    Array.isArray(json) &&
    Array.isArray(json[2]) &&
    (json[2] as unknown[]).some((pair) => isUnknownKind(pair))

/** Distinct chunks in first-use order, visiting each stored node only once. */
export function* distinctRootChunks(
    history: Pick<HistoryForm, 'roots' | 'nodes'>,
    roots: Iterable<string>,
): Generator<string> {
    const seenRoots = new Set<string>()
    const seenNodes = new Set<string>()
    const seenChunks = new Set<string>()
    function* node(hash: string): Generator<string> {
        if (seenNodes.has(hash)) return
        seenNodes.add(hash)
        const json = history.nodes.get(hash)
        if (!json) return
        for (const child of json[2] as string[]) {
            if (json[1] === 1) yield* node(child)
            else if (!seenChunks.has(child)) {
                seenChunks.add(child)
                yield child
            }
        }
    }
    for (const hash of roots) {
        if (seenRoots.has(hash)) continue
        seenRoots.add(hash)
        const root = history.roots.get(hash)
        if (!root) continue
        const header = root[1] as string
        if (!seenChunks.has(header)) {
            seenChunks.add(header)
            yield header
        }
        for (const [, top] of root[2] as [string, string][]) yield* node(top)
    }
}
