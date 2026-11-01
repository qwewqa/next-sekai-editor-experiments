import { FileError } from '../../platform'
import { quickBinding, type Env } from './binding'
import type { PickedLevelData } from './exportPick'
import { afterOutcome, DEFAULT_OPTIONS, projectPicked, type Outcome } from './flow'
import type { PickedFile, PickSession } from './pickSession'
import { enqueueSave } from './queue'

export const shown = (env: Env, outcome: Outcome): Extract<PickedLevelData, { kind: 'show' }> => ({
    kind: 'show',
    show: () => enqueueSave(() => afterOutcome(env, outcome)),
})

/**
 * A pick of this chain's own `.nxsp`: written again like a Save, after trying to commit a
 * continuation's first row. When that cannot be done the file is left empty for the session to put
 * back what it read, and the Save core says why.
 */
export const ownProject = async (
    session: PickSession,
    env: Env,
    picked: PickedFile,
): Promise<Extract<PickedLevelData, { kind: 'ownProject' | 'show' }>> => {
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
