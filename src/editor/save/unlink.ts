import { session as currentSession } from '../../history/session'
import { journalWriter } from '../../local/storing'
import { appVersion } from '../../platform'
import { exportMemory } from '../commands/exportLevel/memory'
import { unbindFile } from '../file/state'
import type { Env } from './binding'
import { forgetHandle } from './env'

/**
 * Unlinks the open session's chain from its file `name`: a new `docId` in
 * storage, the session, the journal and the export memory told, and the handle forgotten. The
 * label then reads a separate copy, and the next Save asks for a new file. Used when the chain's
 * own file is damaged: an append met it (Save), or Check found it.
 */
export const unlinkSession = async (env: Env, name: string) => {
    const docId = crypto.randomUUID()
    const record = await env.worker
        .call('unlinkChain', {
            chainId: env.chainId,
            docId,
            appVersion: appVersion().appVersion,
        })
        .catch(() => undefined)
    if (record) {
        env.session.docId = docId
        env.session.chain = record
        journalWriter?.rewrite()
        // A switch landed in the round trip: the session now open is not this chain's.
        if (currentSession.value.sessionId !== env.session.id) {
            forgetHandle(env.chainId)
            return
        }
        unbindFile()
        currentSession.value = { ...currentSession.value, docId, copyOf: { name, bound: true } }
        exportMemory.partial = true
    }
    forgetHandle(env.chainId)
}
