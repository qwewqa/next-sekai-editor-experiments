import { builtinResources, type BuiltinSource } from '../builtinResources'
import { builtinChoice, bundledIdOf } from '../choice'
import type { AssetChoice, AssetType, BundledId } from '../types'
import { storedChoice } from './chooser'
import { fields, maxSizeOf, sha1Hex, srlHash, type ResourceField } from './item'
import { displayText, isSrl, openSourcePackage, type FilePackage } from './package'
import { repackedItem } from './repack'
import type { UserAssetMeta, UserAssetStore } from './store'

// Whether a package's asset is in Preview Assets already. A stored item matches when Import would
// store exactly its record: the same repacked item object. Built-in, Default and Next SEKAI 02,
// which are not stored, match by type and by each required resource's SHA-1.

export type AssetIdentity =
    /** Not in Preview Assets: Import brings it in. */
    | { kind: 'new' }
    | { kind: 'stored'; choice: AssetChoice }
    | { kind: 'builtin'; source: BuiltinSource; choice: AssetChoice }

export type IdentityContext = {
    store: UserAssetStore
    /** Whether this platform offers Default (the web with its resource packs). */
    hasDefault: boolean
    /** The Next SEKAI 02 packages this platform offers. */
    bundled: ReadonlySet<BundledId>
    /** How long the stored list may take before every row reads as not stored. */
    storeWaitMs?: number
}

/** How long the list waits for the storage worker: far less than the store's own wait. */
const STORE_WAIT_MS = 2000

/** The stored metas, or undefined when storage takes longer than `ms` or fails. */
const storedWithin = async (store: UserAssetStore, ms: number) => {
    let timer: number | undefined
    try {
        return await Promise.race([
            store.list(),
            new Promise<undefined>((resolve) => (timer = globalThis.setTimeout(resolve, ms))),
        ])
    } catch {
        return
    } finally {
        clearTimeout(timer)
    }
}

/**
 * The resources Import would read, with their SHA-1 from the SRL or, with `compute`, from the
 * entry's bytes; undefined when Import would refuse a required one. The thumbnail counts only
 * when its entry is there, as Import reads it as optional.
 */
const resourcesOf = async (
    pkg: FilePackage,
    type: AssetType,
    item: Record<string, unknown>,
    compute: boolean,
    signal: AbortSignal | undefined,
) => {
    const hashes = new Map<ResourceField, string>()
    const hashOf = async (field: ResourceField, required: boolean) => {
        signal?.throwIfAborted()
        const srl: unknown = item[field]
        if (srl !== undefined && srl !== null && !isSrl(srl)) return !required
        const path = isSrl(srl) ? pkg.resolve(srl) : undefined
        if (path === undefined || !pkg.has(path)) return !required
        let hash = srlHash(isSrl(srl) ? srl : undefined)
        if (hash === undefined) return false
        if (hash === null) {
            if (!compute) return !required
            const bytes = await pkg.entry(path, { type, part: field, maxSize: maxSizeOf(field) })
            if (!bytes) return false
            hash = await sha1Hex(bytes)
        }
        hashes.set(field, hash)
        return true
    }
    if (!(await hashOf('thumbnail', false))) return
    for (const field of fields[type]) if (!(await hashOf(field, true))) return
    return hashes
}

const required = (hashes: ReadonlyMap<ResourceField, string>) =>
    [...hashes].filter(([field]) => field !== 'thumbnail')

/** The built-in source whose item has the same resources, among those this platform offers. */
const builtinMatch = (
    type: AssetType,
    hashes: ReadonlyMap<ResourceField, string>,
    context: IdentityContext,
): AssetIdentity | undefined => {
    const bundled = bundledIdOf(type)
    for (const row of builtinResources) {
        if (row.type !== type) continue
        if (row.source === 'default' && !context.hasDefault) continue
        if (
            row.source === 'nextSekai02' &&
            !(context.hasDefault && bundled && context.bundled.has(bundled))
        )
            continue
        const wanted = Object.entries(row.hashes)
        const have = required(hashes)
        if (have.length !== wanted.length) continue
        if (!wanted.every(([field, hash]) => hashes.get(field as ResourceField) === hash)) continue
        const choice: AssetChoice | undefined =
            row.source === 'builtin'
                ? builtinChoice(context.hasDefault)
                : row.source === 'default'
                  ? { source: 'default' }
                  : bundled && { source: 'bundled', id: bundled }
        if (choice) return { kind: 'builtin', source: row.source, choice }
    }
    return
}

/** The item object inside a stored package; undefined when any part of it cannot be read. */
const storedItem = async (store: UserAssetStore, meta: UserAssetMeta) => {
    try {
        const record = await store.get(meta.key)
        if (!record) return
        return await (await openSourcePackage(record.bytes)).details(meta.type, meta.name)
    } catch {
        return
    }
}

/**
 * Which of a package's assets are in Preview Assets already, row by row. `signal` stops it between
 * reads, rejecting with its AbortError.
 */
export const identifyAssets = async (
    pkg: FilePackage,
    assets: readonly { type: AssetType; name: string }[],
    context: IdentityContext,
    signal?: AbortSignal,
): Promise<AssetIdentity[]> => {
    const metas = (await storedWithin(context.store, context.storeWaitMs ?? STORE_WAIT_MS)) ?? []
    const identities: AssetIdentity[] = []
    for (const { type, name } of assets) {
        signal?.throwIfAborted()
        let identity: AssetIdentity = { kind: 'new' }
        try {
            const item = await pkg.details(type, name)
            const named = metas.filter((meta) => meta.type === type && meta.name === name)
            if (item && named.length) {
                const hashes = await resourcesOf(pkg, type, item, true, signal)
                const wanted =
                    hashes &&
                    JSON.stringify(
                        repackedItem(
                            {
                                type,
                                name,
                                version:
                                    typeof item.version === 'number' ? item.version : undefined,
                                title: displayText(item.title) || name,
                                subtitle: displayText(item.subtitle),
                                author: displayText(item.author),
                            },
                            hashes,
                        ),
                    )
                for (const meta of named) {
                    if (wanted === undefined) break
                    signal?.throwIfAborted()
                    const stored = await storedItem(context.store, meta)
                    if (stored && JSON.stringify(stored) === wanted) {
                        identity = { kind: 'stored', choice: storedChoice(meta) }
                        break
                    }
                }
            }
            if (item && identity.kind === 'new') {
                // Only the SRLs' own hashes: nothing is read for an item that is not stored.
                const hashes = await resourcesOf(pkg, type, item, false, signal)
                identity = (hashes && builtinMatch(type, hashes, context)) ?? identity
            }
        } catch (error) {
            if (signal?.aborted) throw error
            // An item that cannot be read offers Import, which says what is wrong with it.
        }
        identities.push(identity)
    }
    return identities
}
