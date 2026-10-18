import { countDayOfUse } from '../days'
import { readMeta, writeMeta } from '../db'
import { deleteHandleRow, HANDLES, splitHandles, withoutHandles } from '../handleRows'
import { fromHex16 } from '../hash'
import type { KvTx } from '../kv/types'
import { clampTime, nextTime } from '../time'
import { storeMarks, type IdentityUnit } from './commit'

// The storage side of the Save core's bindings (Part 1 §1.4.7, owner decision log D5): reading a
// chain's binding again under `nse-bind` (R10), the handles a save picker's pick is compared with
// (R3), a takeover's revocation and pre-bind in one transaction (R5), a revocation storage
// couldn't take applied later (R11), and our own completed Save recorded (§1.4.7).

type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null

/** The stores these transactions touch. */
export const BIND_STORES = ['chains', 'sessions', 'entries', 'meta', HANDLES] as const

/** A chain record as stored, without handles; undefined when there is none. */
export const readChainRecord = async (tx: KvTx, chainId: string) => {
    const chain = await tx.get('chains', chainId)
    return isRow(chain) ? withoutHandles(chain) : undefined
}

/** A stored binding or Export target a picked handle is compared with (R3). */
export type HandleOwner = {
    chainId: string
    role: 'file' | 'exportTarget'
    name: string
    /** The binding's `at`, which a revocation checks is unchanged. */
    at?: number
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

/** Every chain's binding and Export target that has a stored handle, `deleting` chains included. */
export const listHandleOwners = async (tx: KvTx): Promise<HandleOwner[]> => {
    const owners: HandleOwner[] = []
    let hasStore = true
    try {
        tx.describe(HANDLES)
    } catch {
        hasStore = false
    }
    if (!hasStore) return owners
    for (const value of await tx.getAll('chains')) {
        if (!isRow(value) || typeof value.chainId !== 'string') continue
        const chainId = value.chainId
        for (const role of ['file', 'exportTarget'] as const) {
            const field = value[role]
            if (!isRow(field) || typeof field.name !== 'string') continue
            if ((await tx.getKey(HANDLES, [chainId, role])) === undefined) continue
            owners.push({
                chainId,
                role,
                name: field.name,
                ...(typeof field.at === 'number' ? { at: field.at } : {}),
            })
        }
    }
    return owners
}

/** A takeover (R5): another chain's binding or Export target revoked, this chain pre-bound. */
export type TakeOver = {
    owner?: HandleOwner
    /** This chain, bound to the picked file in its empty state; none for Save to File…. */
    preBind?: { chainId: string; file: Row }
    by: string
    at: number
}

/**
 * Revokes the owner, when its field is still the one identified (the same `name` and `at`), with
 * `replaced: { by, at, name }`, `edited` and `hasContent` for a binding (an Export target just
 * goes), and pre-binds this chain, in one transaction. Returns what it did.
 */
export const takeOver = async (tx: KvTx, request: TakeOver) => {
    let revoked = false
    const { owner } = request
    if (owner) {
        const chain = await tx.get('chains', owner.chainId)
        const field = isRow(chain) ? chain[owner.role] : undefined
        if (
            isRow(chain) &&
            isRow(field) &&
            field.name === owner.name &&
            (owner.role !== 'file' || field.at === owner.at)
        ) {
            const record: Row = { ...chain }
            Reflect.deleteProperty(record, owner.role)
            if (owner.role === 'file') {
                record.replaced = { by: request.by, at: request.at, name: owner.name }
                record.edited = true
                record.hasContent = true
            }
            await deleteHandleRow(tx, owner.chainId, owner.role)
            await tx.put('chains', record)
            revoked = true
        }
    }
    let preBound = false
    if (request.preBind) {
        const chain = await tx.get('chains', request.preBind.chainId)
        if (isRow(chain)) {
            const fields = await splitHandles(tx, request.preBind.chainId, {
                file: request.preBind.file,
            })
            await tx.put('chains', { ...chain, file: fields.file })
            preBound = true
        }
    }
    return { revoked, preBound }
}

/** A revocation storage couldn't take (R11): `revoke.<chainId>` in localStorage. */
export type Revocation = { by: string; at: number; name: string; fileAt: number }

/** Applies a revocation while the chain's binding is still the one it names; true when applied. */
export const applyRevocation = async (tx: KvTx, chainId: string, revoke: Revocation) => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain) || !isRow(chain.file) || chain.file.at !== revoke.fileAt) return false
    const record: Row = { ...chain }
    delete record.file
    record.replaced = { by: revoke.by, at: revoke.at, name: revoke.name }
    record.edited = true
    record.hasContent = true
    await deleteHandleRow(tx, chainId, 'file')
    await tx.put('chains', record)
    return true
}

/** A Save's `save` entry as a marker keeps it (hashes as hex). */
export type SaveEntryForm = {
    sessionId: string
    seq: number
    time: number
    label: string
    snapshot: string
    noteCount: number
    revisionId: string
    device: { id: string; label: string }
}

/**
 * Records our own completed Save (§1.4.7): its `save` entry at its reserved `seq` when the chain
 * doesn't hold one there and its session is stored, then the identity unit with its marks. False,
 * writing nothing, when the chain is gone or a mark can't be stored.
 */
export const finishOwnSave = async (
    tx: KvTx,
    chainId: string,
    entry: SaveEntryForm,
    unit: IdentityUnit,
    wall: number = Date.now(),
) => {
    const chain = await tx.get('chains', chainId)
    if (!isRow(chain)) return false
    const session = await tx.get('sessions', entry.sessionId)
    const held = await tx.getKey('entries', [entry.sessionId, entry.seq])
    if (!(await storeMarks(tx, unit.marks))) return false
    if (isRow(session) && session.chainId === chainId && held === undefined) {
        const maxSeen = (await readMeta(tx, 'maxSeenTime')) ?? 0
        const now = nextTime(maxSeen, wall)
        const time = nextTime(maxSeen, clampTime(entry.time, now))
        const day = await countDayOfUse(tx, now)
        await tx.put('entries', {
            sessionId: entry.sessionId,
            seq: entry.seq,
            time,
            day,
            kind: 'save',
            label: entry.label,
            snapshot: fromHex16(entry.snapshot),
            noteCount: entry.noteCount,
            dirty: false,
            kept: true,
            revisionId: entry.revisionId,
            device: entry.device,
        })
        const lastSeq = typeof session.lastSeq === 'number' ? session.lastSeq : 0
        await tx.put('sessions', {
            ...session,
            lastSeq: Math.max(lastSeq, entry.seq),
            entryCount: (typeof session.entryCount === 'number' ? session.entryCount : 0) + 1,
        })
        await writeMeta(tx, 'maxSeenTime', Math.max(time, now))
    }
    const file = { ...unit.file }
    if (isRow(session) && isRow(file.entry) && file.entry.sessionId === entry.sessionId)
        file.entry = { ...file.entry, startedAt: session.startedAt }
    const fields = await splitHandles(tx, chainId, { file })
    const record: Row = {
        ...chain,
        docId: unit.docId,
        revision: unit.revision,
        file: fields.file,
    }
    delete record.replaced
    await tx.put('chains', record)
    return true
}
