import { FileError, platform, type SavePicker, type SaveResult } from '../../platform'
import { verifyBuilt } from '../../platform/handover'
import { fileError } from '../commands/exportLevel/errorText'
import { rememberWritten, type ExportContext } from '../commands/exportLevel/flow'
import { environment, quickBinding, type Env } from './binding'
import {
    afterOutcome,
    broadcastUpdated,
    DEFAULT_OPTIONS,
    notTakenOver,
    pickUi,
    projectPicked,
    revoke,
    type Outcome,
} from './flow'
import { readOwnFile, withPickSession, type PickedFile, type PickSession } from './pickSession'
import { enqueueSave } from './queue'

// Export Level Data…'s pick, on a pick session: the level data is built and
// verified in the session, which opens the picker and holds `nse-bind` from the pick to the end of
// the write. This module only decides what each kind of picked file is for Export. It keeps
// nothing between calls, and loads on first use.

/** What a pick of Export's picker came to; the follow-up dialogs are `exportByPicker`'s. */
export type PickedLevelData =
    /** The level data was written, and the file is the new target. */
    | { kind: 'written'; result: SaveResult & { status: 'saved' } }
    | { kind: 'dismissed' }
    | { kind: 'cancelled' }
    | { kind: 'failed'; error: FileError }
    /** An opened chart, partial level data or partial open: never written over. */
    | { kind: 'refused'; name: string; reason: 'notLevelData' | 'unsupportedParts' }
    /** The chain's own project was written again instead, so the file is not level data. */
    | { kind: 'ownProject'; name: string }
    /** What the Save core shows about the chain's own file or a takeover, after Export's dialog. */
    | { kind: 'show'; show: () => Promise<void> }

/** Export's save picker: its folder, and the `.nsld` type or "All files" alone. */
const levelDataPicker = (types: ExportContext['types']): SavePicker => ({ id: 'levelData', types })

/** The read the dialog starts: the chain's own file, read now when it may hold more. */
export const startExportRead = () => {
    const env = environment()
    return env && platform.pickSaveFile
        ? readOwnFile(env, quickBinding(env))
        : Promise.resolve({ kind: 'noAccess' } as const)
}

/**
 * Builds and verifies the level data, then runs the picker and the write. A cancel of the dialog
 * counts until the picker returns a file; after that the write runs to its end.
 */
export const pickLevelData = async (ctx: ExportContext): Promise<PickedLevelData> => {
    const env = environment()
    const ended = await withPickSession<PickedLevelData>(
        {
            env,
            name: ctx.suggestedName,
            surface: 'export',
            purpose: 'export',
            commitFirst: false,
            read: ctx.read ?? 'start',
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.committed ? { committed: ctx.committed } : {}),
            ui: {
                preparing: pickUi.preparing,
                download: pickUi.download,
                // Export's dialog closes before an offer shows.
                notPutBack: (name, emptied, downloadable) => {
                    ctx.leave()
                    return ctx.ui.notPutBack(name, emptied, downloadable)
                },
            },
        },
        async (session) => {
            let blob: Blob
            try {
                blob = await session.preparing(async () => {
                    const made = await ctx.build()
                    await verifyBuilt('nsld', made)
                    return made
                })
            } catch (error) {
                return { kind: 'failed', error: fileError(error) }
            }
            session.checkpoint()
            const picked = await session.pick(
                levelDataPicker(ctx.types),
                ctx.suggestedName,
                (file) => levelDataPicked(ctx, session, blob, file),
                blob.size,
            )
            // An offer takes a refusal's place, and the failure's when the file was left empty.
            const offer = session.offered
            if (
                offer &&
                picked.kind !== 'written' &&
                picked.kind !== 'ownProject' &&
                (picked.kind === 'refused' || offer.emptied)
            )
                return { kind: 'cancelled' }
            return picked
        },
    )
    if (ended.kind === 'forked') return { kind: 'cancelled' }
    // The session's own failure (a throw) is shown by `exportByPicker`.
    if (ended.kind === 'failed') return { kind: 'failed', error: ended.error }
    return ended
}

/** A picked file the level data may not be written over, found inside the hold. */
const changed = (name: string, found: PickedFile['found']) =>
    new FileError('conflict', `${name} changed`, found, 'check', name)

/** The pick, inside the session's hold on `nse-bind`: what the file is, and what Export does. */
const levelDataPicked = async (
    ctx: ExportContext,
    session: PickSession,
    blob: Blob,
    picked: PickedFile,
): Promise<PickedLevelData> => {
    const { env } = session
    const { identity, filled } = picked
    const name = picked.target.handle.name
    switch (identity.kind) {
        case 'refused':
            // A chart, level data with parts left out or a partial open's file: the session
            // puts back what the editor holds of it, or offers it.
            return {
                kind: 'refused',
                name,
                reason: identity.reason === 'levelData' ? 'unsupportedParts' : 'notLevelData',
            }
        case 'own':
            // The chain's own project is written again, keeping its identity, never level data.
            return env
                ? ownProject(session, env, picked)
                : { kind: 'refused', name, reason: 'notLevelData' }
        case 'other':
        case 'target':
        case 'unknown': {
            // Written since the pick (a sync client, or its owner): never written over unseen, and
            // nothing is revoked for it.
            if (filled) return { kind: 'failed', error: changed(name, picked.found) }
            // Another chain's file or Export target is taken from it.
            const owner =
                identity.kind === 'other' ||
                (identity.kind === 'target' && identity.owner.chainId !== env?.chainId)
                    ? identity.owner
                    : undefined
            if (owner && env) {
                const done = await revoke(env, owner, undefined)
                if (!done.ok) return shown(env, notTakenOver(name))
                if (done.revoked) broadcastUpdated()
            }
            try {
                const result = await picked.write({ kind: 'nsld', blob })
                if (result.status !== 'saved') return { kind: 'cancelled' }
                await rememberWritten(ctx, result)
                return { kind: 'written', result }
            } catch (error) {
                return { kind: 'failed', error: fileError(error) }
            }
        }
    }
}

const shown = (env: Env, outcome: Outcome): PickedLevelData => ({
    kind: 'show',
    show: () => enqueueSave(() => afterOutcome(env, outcome)),
})

/**
 * A pick of this chain's own `.nxsp`: written again like a Save, with a continuation's
 * first row committed first. When that cannot be done the file is left empty for the session to put
 * back what it read, and the Save core says why.
 */
const ownProject = async (
    session: PickSession,
    env: Env,
    picked: PickedFile,
): Promise<PickedLevelData> => {
    const name = picked.target.handle.name
    const binding = quickBinding(env)
    const { file } = binding
    const reserved = file ? await picked.reserve() : undefined
    const outcome: Outcome =
        file && reserved
            ? await projectPicked(
                  session,
                  env,
                  reserved,
                  undefined,
                  { dialog: 'save', fileName: name, ...DEFAULT_OPTIONS, target: 'copy' },
                  binding,
                  picked,
              )
            : { kind: 'failed', error: new FileError('io', `${name} was not written again`), name }
    return outcome.kind === 'done' ? { kind: 'ownProject', name } : shown(env, outcome)
}
