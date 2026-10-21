import { centralDirectoryOf } from '../../platform/fingerprint'
import { hashKey } from '../db'
import { fromHex16, toHex } from '../hash'
import { isObject } from '../nxsp/json'
import { unpackHashes } from '../records/rows'
import { reachedHashes, stillBad, type SaveStore } from './bodies'
import { CUT_STORES, readCut, type ChainCut } from './cut'
import { isStoredMediaWhole } from './media'
import { bindingHasHistory, carries, chainRows, isLater, ModelError } from './model'

// Comparing files (Part 0 §0.9.5; Part 1 §1.6.11.6): the relation of two revisions, the content
// predicate "N holds O" from `project.json` and the chain record alone, and the web's Replace
// guard built on it. No manifest is read (past the 1,024-id cap, the apps' lookup is Part 3's).

/** What the predicate reads of a file, or of a chain as its binding records its base. */
export type Facts = {
    revision?: { id: string; ancestors: readonly string[]; completeFrom?: string }
    /** The central directory's CRC, `<cd>`. */
    cd?: string
    /** `history.entries`, or for a chain `file.entry.count`; undefined without history. */
    entries?: number
}

export type Relation = 'same' | 'newer' | 'older' | 'diverged' | 'none'

/** I against H (§0.9.5): same, newer (I descends from H), older, diverged; `none` without revisions. */
export const relation = (i: Facts, h: Facts): Relation => {
    if (!i.revision || !h.revision) return 'none'
    if (i.revision.id === h.revision.id && i.cd !== undefined && i.cd === h.cd) return 'same'
    if (i.revision.ancestors.includes(h.revision.id)) return 'newer'
    if (h.revision.ancestors.includes(i.revision.id)) return 'older'
    return 'diverged'
}

/**
 * "N holds O", rules 1 and 2 (§1.6.11.6): N descends from O or is O, and when O has history, N's
 * `completeFrom` is O's id or one of O's ancestors and N has at least as many entries. Rule 3 (the
 * head's media) is the caller's, where it applies; the Replace guard leaves it out.
 */
export const holdsHistory = (n: Facts, o: Facts) => {
    if (!n.revision || !o.revision) return false
    const descends =
        (n.revision.id === o.revision.id && n.cd !== undefined && n.cd === o.cd) ||
        n.revision.ancestors.includes(o.revision.id)
    if (!descends) return false
    if (o.entries === undefined) return true
    if (n.entries === undefined) return false
    const from = n.revision.completeFrom ?? n.revision.id
    const placed =
        from === n.revision.id || n.revision.ancestors.includes(from) ? from : n.revision.id
    return (
        (placed === o.revision.id || o.revision.ancestors.includes(placed)) &&
        n.entries >= o.entries
    )
}

/** A file's facts from its parsed `project.json` and fingerprint. */
export const fileFacts = (projectJson: unknown, fingerprint: string): Facts => {
    const project = isObject(projectJson) ? projectJson : {}
    const revision = isObject(project.revision) ? project.revision : undefined
    const history = isObject(project.history) ? project.history : undefined
    const cd = centralDirectoryOf(fingerprint)
    return {
        ...(revision && typeof revision.id === 'string' && Array.isArray(revision.ancestors)
            ? {
                  revision: {
                      id: revision.id,
                      ancestors: (revision.ancestors as unknown[]).filter(
                          (id): id is string => typeof id === 'string',
                      ),
                      ...(typeof revision.completeFrom === 'string'
                          ? { completeFrom: revision.completeFrom }
                          : {}),
                  },
              }
            : {}),
        ...(cd === undefined ? {} : { cd }),
        ...(history && typeof history.entries === 'number' ? { entries: history.entries } : {}),
    }
}

/** The chain's base as its binding records it (r12-freeze2 S5). */
export const baseFacts = (cut: ChainCut): Facts => {
    const { revision, file } = cut.chain
    const cd = file?.disk && centralDirectoryOf(file.disk.fingerprint)
    return {
        ...(revision ? { revision: { id: revision.id, ancestors: revision.ancestors } } : {}),
        ...(cd ? { cd } : {}),
        ...(file?.entry && bindingHasHistory(file) ? { entries: file.entry.count } : {}),
    }
}

/**
 * Whether the chain's next write that isn't an append would carry its base: the build's carry test
 * (D25) over the stored rows. A build that then finds damage in storage may still not carry.
 */
export const wouldCarry = (cut: ChainCut) => {
    const entry = cut.chain.file?.entry
    if (!cut.chain.revision || !entry) return false
    try {
        return carries(chainRows(cut), entry, (row) => !row.entry.kept)
    } catch (error) {
        if (error instanceof ModelError) return false
        throw error
    }
}

export type ReplaceDecision = {
    /** "It holds earlier Timeline steps that this browser no longer has.": Replace disabled. */
    holdsBase: boolean
    relation: Relation
}

/**
 * The Replace guard (§0.9.6; r12-history-critique §2): Replace is disabled when the file on disk
 * holds the chain's base (rules 1 and 2, O the base as the binding records it) and the write
 * wouldn't carry it, so the only durable holder of earlier versions is never overwritten.
 */
export const replaceDecision = (cut: ChainCut, disk: Facts): ReplaceDecision => {
    const base = baseFacts(cut)
    return {
        // A base without history holds no earlier steps: nothing for a write to carry or lose.
        holdsBase:
            bindingHasHistory(cut.chain.file) && holdsHistory(disk, base) && !wouldCarry(cut),
        relation: relation(disk, base),
    }
}

/** The Replace guard for a chain in storage, against the file on disk's `project.json`. */
export const readReplaceDecision = async (
    store: SaveStore,
    chainId: string,
    projectJson: unknown,
    fingerprint: string,
): Promise<ReplaceDecision | undefined> => {
    const cut = await store.read(CUT_STORES, (tx) => readCut(tx, chainId))
    return cut && replaceDecision(cut, fileFacts(projectJson, fingerprint))
}

/**
 * Damage storage already knows of: every chain's `badChunks` (bodies are shared between chains,
 * so another chain's build may have found it), as hex. `stillBad` says which still are (SP-1).
 */
export const knownDamage = async (store: SaveStore) => {
    const chains = await store.read(['chains'], (tx) => tx.getAll('chains'))
    const known = new Set<string>()
    for (const chain of chains)
        if (isObject(chain) && chain.badChunks instanceof Uint8Array)
            for (const hash of unpackHashes(chain.badChunks)) known.add(toHex(hash))
    return known
}

/**
 * Whether a kept row up to the cut needs a body of `bad`: a state the base held that a write from
 * storage would leave out while the carry test passes, since it counts flags, not bodies (SP-1).
 */
export const keptRowsNeed = async (store: SaveStore, cut: ChainCut, bad: ReadonlySet<string>) => {
    const entry = cut.chain.file?.entry
    if (!entry || !bindingHasHistory(cut.chain.file) || !bad.size) return false
    let rows
    try {
        rows = chainRows(cut)
    } catch (error) {
        if (error instanceof ModelError) return false
        throw error
    }
    const roots = new Set<string>()
    for (const row of rows) {
        if (!row.entry.kept || isLater(row, entry)) continue
        roots.add(toHex(row.entry.snapshot))
        for (const slot of row.entry.stack?.push ?? []) roots.add(toHex(slot.snapshot))
    }
    if ([...roots].some((hex) => bad.has(hex))) return true
    const reached = await reachedHashes(store, roots)
    return [...bad].some((hex) => reached.has(hex))
}

/** What a write from storage would leave out that the chain's own file may hold (R2). */
export type SaveNeeds = {
    /**
     * The next write from storage carries the base's `completeFrom` (D25's carry test), and no
     * damage storage knows of is under a kept row the base held.
     */
    carries: boolean
    /** Of the head's media given (by hash), those the media store doesn't hold. */
    lacking: string[]
}

/**
 * Whether reading the chain's own file before a picker could keep anything (§1.4.7 R2): rows of
 * its base storage lacks, or head media storage lacks. Read from storage alone, so a dialog knows
 * whether to ask for read access before it reads the file.
 */
export const readSaveNeeds = async (
    store: SaveStore,
    chainId: string,
    media: readonly string[],
): Promise<SaveNeeds> => {
    const cut = await store.read(CUT_STORES, (tx) => readCut(tx, chainId))
    const lacking = await store.read(['media'], async (tx) => {
        const missing: string[] = []
        for (const hash of media)
            if ((await tx.getKey('media', hashKey(fromHex16(hash)))) === undefined)
                missing.push(hash)
        return missing
    })
    // Damage storage already knows of is short too: the carry test and a key can't see it (SP-1).
    const known = await knownDamage(store)
    const bad = known.size ? await stillBad(store, [...known]) : new Set<string>()
    for (const hash of media)
        if (known.has(hash) && !lacking.includes(hash) && !(await isStoredMediaWhole(store, hash)))
            lacking.push(hash)
    const carried =
        !cut ||
        !bindingHasHistory(cut.chain.file) ||
        (wouldCarry(cut) && !(await keptRowsNeed(store, cut, bad)))
    return { carries: carried, lacking }
}
