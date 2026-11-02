import type { JsonValue } from '../../history/operations'
import { deleteHandleRow, HANDLES, splitHandles, withoutHandles } from '../handleRows'
import type { KvTx } from '../kv/types'
import { keptNameOf } from '../names'
import {
    clearIdentityExport,
    sessionVersionReader,
    storeMarks,
    unitApplies,
    writableSession,
    type IdentityUnit,
} from './commit'

// Storage operations for Save: reading bindings and handle owners, revoking matching
// associations and recording completed writes.

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** A chain losing its file takes the file's stem as its name, over any it had. */
const keepName = (record: Row, fileName: string) => {
    const name = keptNameOf(record.name, fileName)
    if (name !== undefined) record.name = name
}

/** The stores these transactions touch. */
export const BIND_STORES = ['chains', 'sessions', 'entries', HANDLES] as const

/** A chain record as stored, without handles; undefined when there is none. */
export const readChainRecord = async (tx: KvTx, chainId: string) => {
    const chain = await tx.get('chains', chainId)
    return isRow(chain) ? withoutHandles(chain) : undefined
}

/** A stored binding or Export target: what a pick is compared with. */
export type HandleOwner = {
    chainId: string
    role: 'file' | 'exportTarget'
    name: string
    /** The binding's `at`, which a revocation checks is unchanged. */
    at?: number
    /** Whether a handle is stored for it. */
    handle: boolean
}

/** Each stored session's `startedAt`, as a binding's cut needs it. */
export const readSessionStarts = async (tx: KvTx, sessionIds: readonly string[]) => {
    const starts: Record<string, number> = {}
    for (const id of sessionIds) {
        const session = await tx.get('sessions', id)
        if (isRow(session) && typeof session.startedAt === 'number') starts[id] = session.startedAt
    }
    return starts
}

/** Every chain's binding and Export target, `deleting` chains included. */
export const listHandleOwners = async (tx: KvTx): Promise<HandleOwner[]> => {
    const owners: HandleOwner[] = []
    for (const value of await tx.getAll('chains')) {
        if (!isRow(value) || typeof value.chainId !== 'string') continue
        const chainId = value.chainId
        for (const role of ['file', 'exportTarget'] as const) {
            const field = value[role]
            if (!isRow(field) || typeof field.name !== 'string') continue
            owners.push({
                chainId,
                role,
                name: field.name,
                ...(typeof field.at === 'number' ? { at: field.at } : {}),
                handle: (await tx.getKey(HANDLES, [chainId, role])) !== undefined,
            })
        }
    }
    return owners
}

/** A binding or Export target to revoke, for the chain `by` at `at`. */
export type Revocation = {
    owner: HandleOwner
    by: string
    at: number
}

/**
 * Revokes the owner, when its field is still the one listed (the same `name` and `at`), with
 * `replaced: { by, at, name }`, `edited` and `hasContent` for a binding (an Export target just
 * goes). Returns whether it revoked the association.
 */
export const revokeOwner = async (tx: KvTx, { owner, by, at }: Revocation) => {
    const chain = await tx.get('chains', owner.chainId)
    const field = isRow(chain) ? chain[owner.role] : undefined
    if (
        !isRow(chain) ||
        !isRow(field) ||
        field.name !== owner.name ||
        (owner.role === 'file' && field.at !== owner.at)
    )
        return { revoked: false }
    const record: Row = { ...chain }
    Reflect.deleteProperty(record, owner.role)
    if (owner.role === 'file') {
        keepName(record, owner.name)
        record.replaced = { by, at, name: owner.name }
        record.edited = true
        record.hasContent = true
    }
    await deleteHandleRow(tx, owner.chainId, owner.role)
    await tx.put('chains', record)
    return { revoked: true }
}

/** A Save's `save` entry as a marker keeps it (hashes as hex). */
export type SaveEntryForm = {
    sessionId: string
    seq: number
    time: number
    operation: JsonValue
    snapshot: string
    noteCount: number
    revisionId: string
    device: { id: string; label: string }
    /** The app version that wrote it (optional on read, as in the entry form). */
    appVersion?: string
}

/** Our own completed Save, as `recordOwnSave` takes it. */
export type OwnSaveRecord = {
    chainId: string
    /** The recording tab's session: the chain's head, or an unstored continuation of it. */
    writer: { sessionId: string; parentId?: string }
    /** The marker's unit: `file` with its handle, `disk` and `event: 'saved'`; `from` required. */
    unit: IdentityUnit & { from: NonNullable<IdentityUnit['from']> }
}

/**
 * Why a Save was not recorded: `gone` (no such chain), `notHead` (the chain's head is neither the
 * writer nor, while the writer is unstored, its parent), `unsupported` (the head is a version this
 * build cannot write), `importing` (a session of the chain still imports), `stale` (the record no
 * longer holds the binding the Save started from), `marks` (a mark could not be stored).
 */
export type OwnSaveRecorded =
    'recorded' | 'gone' | 'notHead' | 'unsupported' | 'stale' | 'marks' | 'importing'

/**
 * Records our own completed Save's binding and nothing else: the chain
 * record (`docId`, `revision`, `file` with its cut and `disk`, the Export clear), its handle row
 * and the write's marks, in one transaction. No entry is written, so no session changes and no
 * row is created below a `lastSeq`: the Save has no Saved row in the Timeline, its state is the one
 * before it. The cut counts the file's rows, the `save` row among them, also though the chain
 * lacks it: a cut may only under-claim, and the next write that isn't an append then
 * fails the carry test (save/model.ts `carryStatus`) and says "may not be included" once.
 */
export const recordOwnSave = async (
    tx: KvTx,
    { chainId, writer, unit }: OwnSaveRecord,
): Promise<OwnSaveRecorded> => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain)) return 'gone'
    const read = sessionVersionReader(tx)
    const { head } = chain
    const continues =
        writer.parentId !== undefined &&
        head === writer.parentId &&
        (await read(writer.sessionId)) === undefined
    if (typeof head !== 'string' || (head !== writer.sessionId && !continues)) return 'notHead'
    if (!writableSession(await read(head))) return 'unsupported'
    for (const session of await tx.index('sessions', 'chainId').getAll(chainId))
        if (isRow(session) && session.importPending === true) return 'importing'
    if (!unitApplies(chain, unit)) return 'stale'
    if (!(await storeMarks(tx, unit.marks, read))) return 'marks'
    const file = { ...unit.file }
    if (isRow(file.entry)) {
        const session = await read(String(file.entry.sessionId))
        if (isRow(session) && typeof session.startedAt === 'number')
            file.entry = { ...file.entry, startedAt: session.startedAt }
    }
    const fields = await splitHandles(tx, chainId, { file })
    const record: Row = {
        ...chain,
        docId: unit.docId,
        revision: unit.revision,
        file: fields.file,
    }
    await clearIdentityExport(tx, chainId, record, unit)
    delete record.replaced
    await tx.put('chains', record)
    return 'recorded'
}
