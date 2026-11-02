import { recordError } from '../../diagnostics'
import { FileError, type SaveResult } from '../../platform'
import { verifyBuilt } from '../../platform/handover'
import { fileError } from '../commands/exportLevel/errorText'
import { rememberWritten, type ExportContext } from '../commands/exportLevel/flow'
import { environment } from './binding'
import { pickUi, revokePicked } from './flow'
import { withPickSession } from './pickSession'

export type PickedLevelData =
    | { kind: 'written'; result: SaveResult & { status: 'saved' } }
    | { kind: 'dismissed' }
    | { kind: 'cancelled' }
    | { kind: 'failed'; error: FileError; reported?: boolean }

/** Builds and verifies level data before the picker, then writes it under nse-bind. */
export const pickLevelData = async (ctx: ExportContext): Promise<PickedLevelData> => {
    const env = environment()
    let reported = false
    const ended = await withPickSession<PickedLevelData>(
        {
            env,
            name: ctx.suggestedName,
            surface: 'export',
            purpose: 'export',
            commitFirst: false,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            ...(ctx.committed ? { committed: ctx.committed } : {}),
            ui: {
                preparing: pickUi.preparing,
                emptied: async (name) => {
                    ctx.leave()
                    await ctx.ui.emptied(name)
                    reported = true
                },
            },
        },
        async (session) => {
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
                    const name = picked.target.handle.name
                    if (picked.filled)
                        return {
                            kind: 'failed',
                            error: new FileError(
                                'conflict',
                                name + ' changed',
                                picked.found,
                                'check',
                                name,
                            ),
                        }
                    await revokePicked(env, picked.target.handle, true)
                    try {
                        const result = await picked.write({ kind: 'nsld', blob })
                        if (result.status !== 'saved') return { kind: 'cancelled' }
                        await rememberWritten(ctx, result).catch(recordError)
                        return { kind: 'written', result }
                    } catch (error) {
                        return { kind: 'failed', error: fileError(error) }
                    }
                },
                blob.size,
            )
        },
    )
    if (ended.kind === 'forked') return { kind: 'cancelled' }
    if (ended.kind === 'failed') return { kind: 'failed', error: fileError(ended.error), reported }
    return ended
}
