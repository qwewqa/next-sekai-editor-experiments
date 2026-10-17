import { i18n } from '../../i18n'
import { appVersion, platform } from '../../platform'
import { interpolateRaw } from '../../utils/interpolate'
import type { StorageWorker } from '../worker/client'
import { transfer } from '../worker/rpc'
import { startupApplyJournals, type JournalOutcome } from './replay'

// The startup hook for `startupApplyJournals` (Part 1 §1.11.3): after the handshake, before this
// tab's own session starts storing. Step 4's recovery order replaces it.

declare global {
    // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
    interface Window {
        /** What replay did at this load, for specs, when a storage test flag is seeded. */
        nseJournalTest?: { outcomes: JournalOutcome[]; ms: number }
    }
}

/** A call's timeout: the usual 10 s and a second more per MB, as a flush's. */
const timeoutFor = (bytes: number) => 10_000 + bytes / 1000

export const applyJournalsAtStart = async (worker: StorageWorker, test: boolean) => {
    const start = performance.now()
    let outcomes: JournalOutcome[] = []
    try {
        outcomes = await startupApplyJournals({
            store: platform.journal,
            locks: platform.locks,
            appVersion: appVersion().appVersion,
            // In the locale at write time (§1.10 #7).
            label: (dropped) =>
                dropped
                    ? interpolateRaw(i18n.value.entry.recoveredDropped, String(dropped))
                    : i18n.value.entry.recovered,
            worker: {
                applyJournal: (batch) =>
                    worker.call('applyJournal', transfer(batch, [batch.text.buffer]), {
                        timeoutMs: timeoutFor(batch.text.byteLength),
                    }),
                keepRecovered: (item) =>
                    worker.call('keepRecovered', item, { timeoutMs: timeoutFor(item.text.length) }),
            },
        })
    } catch (error) {
        // Every key stays for the next load.
        console.error('Journals could not be replayed', error)
    }
    for (const outcome of outcomes)
        if (outcome.kind === 'failed')
            console.error('A journal could not be replayed', outcome.error)
    if (test) window.nseJournalTest = { outcomes, ms: performance.now() - start }
    return outcomes
}
