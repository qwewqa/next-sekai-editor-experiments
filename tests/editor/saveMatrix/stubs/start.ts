// A stand-in for src/local/start.ts: the storage worker the Save core reads, set by the harness.
import type { StorageWorker } from '../../../../src/local/worker/client'

export let storageWorker: StorageWorker | undefined

export const setStorageWorkerForMatrix = (worker: unknown) => {
    storageWorker = worker as StorageWorker | undefined
}
