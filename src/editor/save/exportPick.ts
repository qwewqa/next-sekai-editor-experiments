import { recordError } from '../../diagnostics'
import { FileError, type SaveResult } from '../../platform'
import { verifyBuilt } from '../../platform/handover'
import { fileError } from '../commands/exportLevel/errorText'
import { rememberWritten, type ExportContext } from '../commands/exportLevel/flow'
import { environment } from './binding'
import { preparingUi, revokePicked } from './flow'
import { named, withPickSession, type PickSession } from './pickSession'

export type PickedLevelData =
    | { kind: 'written'; result: SaveResult & { status: 'saved' } }
    | { kind: 'dismissed' }
    | { kind: 'cancelled' }
    | { kind: 'failed'; error: FileError; emptied?: boolean }

/** Builds and verifies level data before the picker, then writes it under nse-bind. */
export const pickLevelData = async (ctx: ExportContext): Promise<PickedLevelData> => {
    const env = environment()
    let picking: Pick<PickSession, 'emptied'> = { emptied: false }
    const ended = await withPickSession<PickedLevelData>(
        {
            env,
            name: ctx.suggestedName,
            surface: 'export',
            commitFirst: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.committed ? { committed: ctx.committed } : {}),
            checkEmptied: true,
            ui: preparingUi,
        },
        async (session) => {
            picking = session
            const blob = await session.preparing(async () => {
                const made = await ctx.build()
                await verifyBuilt('nsld', made)
                return made
            })
            session.checkpoint()
            return session.pick(
                { id: 'levelData', types: ctx.types },
                ctx.suggestedName,
                async (picked): Promise<PickedLevelData> => {
                    if (picked.changed) return { kind: 'failed', error: picked.changed }
                    await revokePicked(env, picked.target.handle, true)
                    try {
                        const result = await picked.write({ kind: 'nsld', blob })
                        if (result.status !== 'saved') return { kind: 'cancelled' }
                        await rememberWritten(ctx, result).catch(recordError)
                        return { kind: 'written', result }
                    } catch (error) {
                        return {
                            kind: 'failed',
                            error: named(fileError(error), picked.target.handle.name),
                        }
                    }
                },
                blob.size,
            )
        },
    )
    if (ended.kind === 'forked') return { kind: 'cancelled' }
    if (ended.kind === 'failed')
        return { kind: 'failed', error: fileError(ended.error), emptied: picking.emptied }
    return ended
}
