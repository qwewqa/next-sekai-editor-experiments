import { hashKey } from '../db'
import { fromHex16, toHex } from '../hash'
import { KeyRange } from '../kv/types'
import type { WritePlan } from '../nxsp/plan'
import { loadBodies, type SaveStore } from '../save/bodies'
import { setSaveHooksForTests, type SaveOptions, type SaveTarget } from '../save/build'
import { estimateSaveSize } from '../save/estimate'
import { buildSave, setBuiltHookForTests, type SaveSourceFile } from '../save/execute'
import { readReplaceDecision, readSaveNeeds } from '../save/predicate'
import type { WorkerContext } from './handlers'
import type { CallScope } from './rpc'

// The storage worker's methods for the shared writer: a
// Save's build, the Save dialogs' size estimate, and the conflict dialog's Replace guard. The
// pinned files cross the channel as `File` references; the worker inspects and copies through
// them, and returns the built file, already checked.

/** A Save's options as the page posts them: the worker mints the revision ids. */
export type BuildSaveOptions = Omit<SaveOptions, 'context'> & {
    context: Omit<SaveOptions['context'], 'newId'>
}

export type BuildSaveRequest = {
    chainId: string
    target: SaveTarget
    options: BuildSaveOptions
    /** The files pinned at the changed-on-disk check (source integrity). */
    sources?: SaveSourceFile[]
}

/** Flips a byte of a built file's last part, for the post-build check's spec. */
const flipLastBytes = async (blob: Blob) => {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const at = Math.max(0, bytes.length - 200)
    bytes[at] = (bytes[at] ?? 0) ^ 1
    return new Blob([bytes])
}

/** Drops an append's `chunks.bin` prefix copy, for the append assertion's spec. */
const breakAppend = (plan: WritePlan): WritePlan => ({
    ...plan,
    entries: plan.entries.map((entry) =>
        entry.name === 'history/chunks.bin'
            ? { ...entry, parts: entry.parts.filter((part) => part.kind === 'bytes') }
            : entry,
    ),
})

export const saveHandlers = (context: WorkerContext) => {
    /** The store, with each transaction ticking the call's progress when a scope is given. */
    const storeOf = (scope?: CallScope): SaveStore => {
        const progress = scope ? { tick: scope.tick } : {}
        return {
            read: (stores, fn) => context.core.read(stores, fn, progress),
            write: (stores, fn, options) =>
                context.core.write(stores, fn, { ...options, ...progress }),
        }
    }
    const store = storeOf()
    return {
        buildSave: ({ chainId, target, options, sources = [] }: BuildSaveRequest) =>
            buildSave(
                store,
                chainId,
                target,
                {
                    ...options,
                    context: { ...options.context, newId: () => crypto.randomUUID() },
                },
                sources,
            ),
        /**
         * Each read moves the call's progress: an estimate made while an open's import writes the
         * chain waits for its transactions, and must not be taken for a hung worker.
         */
        estimateSaveSize: (
            {
                chainId,
                sessionId,
                bgm,
            }: {
                chainId: string
                sessionId?: string
                bgm?: string
            },
            scope?: CallScope,
        ) =>
            estimateSaveSize(storeOf(scope), chainId, {
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(bgm === undefined ? {} : { bgm }),
                ...(scope ? { tick: scope.tick } : {}),
            }),
        replaceDecision: ({
            chainId,
            projectJson,
            fingerprint,
        }: {
            chainId: string
            projectJson: unknown
            fingerprint: string
        }) => readReplaceDecision(store, chainId, projectJson, fingerprint),
        /** Whether the chain's own file may hold what storage lacks, from storage alone. */
        saveNeeds: ({ chainId, media }: { chainId: string; media: string[] }) =>
            readSaveNeeds(store, chainId, media),

        /**
         * Of `hashes`, those the media store holds ("held"): one key read each, so a
         * Save dialog never waits on the chain's cut for its BGM row.
         */
        mediaHeld: (hashes: string[]) =>
            store.read(['media'], async (tx) => {
                const held: string[] = []
                for (const hash of hashes)
                    if ((await tx.getKey('media', hashKey(fromHex16(hash)))) !== undefined)
                        held.push(hash)
                return held
            }),

        /**
         * Test: a stored chunk gone bad without any build seeing it: a byte of a
         * chunk the row's state needs and no other stored row's state does. Resolves its hash, or
         * undefined when every chunk of that state is shared.
         */
        testDamage: async ({ sessionId, seq }: { sessionId: string; seq: number }) => {
            if (!context.test) throw new Error('Test hooks need a test flag')
            const rows = (await context.core.read(['entries'], (tx) =>
                tx.getAll('entries', KeyRange.bound(['', -Infinity], ['￿', Infinity])),
            )) as { sessionId: string; seq: number; snapshot: Uint8Array }[]
            const target = rows.find((row) => row.sessionId === sessionId && row.seq === seq)
            if (!target) return
            const hex = toHex(target.snapshot)
            const others = rows.map((row) => toHex(row.snapshot)).filter((each) => each !== hex)
            const own = await loadBodies(store, [hex])
            const shared = await loadBodies(store, others)
            const chunk = [...own.chunks.keys()].find((key) => !shared.chunks.has(key))
            if (!chunk) return
            const key = hashKey(fromHex16(chunk))
            await context.core.write(['chunks'], async (tx) => {
                const row = (await tx.get('chunks', key)) as Record<string, unknown> & {
                    bytes: Uint8Array
                }
                const bytes = row.bytes.slice()
                bytes[0] = (bytes[0] ?? 0) ^ 0x5a
                await tx.put('chunks', { ...row, bytes }, key)
            })
            return chunk
        },

        /**
         * Test: a stored row made `kept: false` and its root removed, as a "not kept" row reads
         * (the specs' storage-short cases).
         */
        testThin: ({ sessionId, seq }: { sessionId: string; seq: number }) => {
            if (!context.test) throw new Error('Test hooks need a test flag')
            return context.core.write(['entries', 'nodes'], async (tx) => {
                const row = (await tx.get('entries', [sessionId, seq])) as
                    Record<string, unknown> | undefined
                if (!row || !(row.snapshot instanceof Uint8Array)) return false
                await tx.put('entries', { ...row, kept: false })
                await tx.delete('nodes', hashKey(row.snapshot))
                return true
            })
        },
        /** Test: alters what the next builds do (the append assertion's and the post-build check's specs). */
        testSaveHooks: ({
            breakAppend: broken,
            flipBuilt,
        }: {
            breakAppend?: boolean
            flipBuilt?: boolean
        }) => {
            if (!context.test) throw new Error('Test hooks need a test flag')
            setSaveHooksForTests(broken ? { plan: breakAppend } : {})
            setBuiltHookForTests(flipBuilt ? { built: flipLastBytes } : {})
            return true
        },
    }
}

export type SaveHandlers = ReturnType<typeof saveHandlers>
