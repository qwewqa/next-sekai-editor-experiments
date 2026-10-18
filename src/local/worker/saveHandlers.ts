import type { WritePlan } from '../nxsp/plan'
import type { SaveStore } from '../save/bodies'
import { setSaveHooksForTests, type SaveOptions, type SaveTarget } from '../save/build'
import { estimateSaveSize } from '../save/estimate'
import { buildSave, setBuiltHookForTests, type SaveSourceFile } from '../save/execute'
import { readReplaceDecision, readSaveNeeds } from '../save/predicate'
import type { WorkerContext } from './handlers'

// The storage worker's methods for the shared writer (Part 1 §1.6.11.6–§1.6.11.7, §1.4.7): a
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
    /** The files pinned at the changed-on-disk check (Part 0 §0.9.1, source integrity). */
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
    const store: SaveStore = {
        read: (stores, fn) => context.core.read(stores, fn),
        write: (stores, fn, options) => context.core.write(stores, fn, options),
    }
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
        estimateSaveSize: ({
            chainId,
            sessionId,
            bgm,
        }: {
            chainId: string
            sessionId?: string
            bgm?: string
        }) =>
            estimateSaveSize(store, chainId, {
                ...(sessionId === undefined ? {} : { sessionId }),
                ...(bgm === undefined ? {} : { bgm }),
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
        /** Whether the chain's own file may hold what storage lacks (R2), from storage alone. */
        saveNeeds: ({ chainId, media }: { chainId: string; media: string[] }) =>
            readSaveNeeds(store, chainId, media),

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
