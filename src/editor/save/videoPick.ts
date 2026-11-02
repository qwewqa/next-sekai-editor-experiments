import { FileError, type SavePickerType } from '../../platform'
import { environment } from './binding'
import { revokePicked } from './flow'
import { withPickSession, type PickSpec } from './pickSession'

/** An empty picked file, checked under nse-bind before streaming starts. */
export type VideoPick = { handle: FileSystemFileHandle; lastModified: number }

export type PickedVideo =
    | { kind: 'accepted'; pick: VideoPick }
    | { kind: 'failed'; error: FileError }
    | { kind: 'cancelled' | 'dismissed' }

/** Revokes associations to the file and returns after nse-bind is released. */
export const pickVideo = async (options: {
    name: string
    type: SavePickerType
    signal?: AbortSignal
    ui: Pick<PickSpec['ui'], 'preparing'>
}): Promise<PickedVideo> => {
    const env = environment()
    const result = await withPickSession<PickedVideo>(
        {
            env,
            name: options.name,
            surface: 'video',
            commitFirst: false,
            ui: { preparing: options.ui.preparing },
            ...(options.signal ? { signal: options.signal } : {}),
        },
        (session) =>
            session.pick(
                { id: 'nse-video', types: [options.type], excludeAll: true },
                options.name,
                async (picked): Promise<PickedVideo> => {
                    const { target, found } = picked
                    const name = target.handle.name
                    if (picked.filled)
                        throw new FileError('conflict', name + ' changed', found, 'check', name)
                    await revokePicked(env, target.handle, true)
                    return {
                        kind: 'accepted',
                        pick: { handle: target.handle, lastModified: found.lastModified },
                    }
                },
            ),
    )
    return result.kind === 'forked' ? { kind: 'cancelled' } : result
}
