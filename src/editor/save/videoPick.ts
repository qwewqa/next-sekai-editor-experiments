import { FileError, type SavePickerType } from '../../platform'
import { environment } from './binding'
import type { PickedLevelData } from './exportPick'
import { ownProject } from './ownPick'
import { withPickSession, type PickSpec } from './pickSession'

/** Only an unknown, empty pick may leave the session as a video destination. */
export type VideoPick = { handle: FileSystemFileHandle; lastModified: number }

export type PickedVideo =
    | { kind: 'accepted'; pick: VideoPick }
    | { kind: 'refused'; name: string; reason: 'known' | 'other' }
    | Extract<
          PickedLevelData,
          { kind: 'ownProject' | 'show' | 'failed' | 'cancelled' | 'dismissed' }
      >

/** Identifies the pick and restores or offers any bytes held. Returns after nse-bind is released. */
export const pickVideo = async (options: {
    name: string
    type: SavePickerType
    read?: PickSpec['read']
    signal?: AbortSignal
    ui: PickSpec['ui']
}): Promise<PickedVideo> => {
    const env = environment()
    const result = await withPickSession<PickedVideo>(
        {
            env,
            name: options.name,
            surface: 'export',
            purpose: 'video',
            commitFirst: false,
            read: options.read ?? 'start',
            ui: options.ui,
            ...(options.signal ? { signal: options.signal } : {}),
        },
        (session) =>
            session.pick(
                { id: 'nse-video', types: [options.type], excludeAll: true },
                options.name,
                async (picked): Promise<PickedVideo> => {
                    const { identity, target, found } = picked
                    const name = target.handle.name
                    if (picked.filled)
                        return {
                            kind: 'failed',
                            error: new FileError(
                                'conflict',
                                `${name} changed`,
                                found,
                                'check',
                                name,
                            ),
                        }
                    switch (identity.kind) {
                        case 'own':
                            return env
                                ? ownProject(session, env, picked)
                                : { kind: 'refused', name, reason: 'known' }
                        case 'other':
                            return { kind: 'refused', name, reason: 'other' }
                        case 'refused':
                        case 'target':
                            return { kind: 'refused', name, reason: 'known' }
                        case 'unknown':
                            return {
                                kind: 'accepted',
                                pick: { handle: target.handle, lastModified: found.lastModified },
                            }
                    }
                },
            ),
    )
    return result.kind === 'forked' ? { kind: 'cancelled' } : result
}
