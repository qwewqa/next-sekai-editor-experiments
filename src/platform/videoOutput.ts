import { realTimers, type Timers } from '../local/locks'
import { BLOB_URL_MS, fileErrorOf } from './handover'
import type { LockService, VideoOutput } from './types'

/** Only files in the export-video directory belong to this store. */
export type VideoStore = {
    create(name: string): Promise<FileSystemFileHandle>
    file(name: string): Promise<File>
    remove(name: string): Promise<void>
    names(): Promise<string[]>
}

export const videoLock = (id: string) => `nse-export-video:${id}`
const validId = /^[a-zA-Z0-9_-]+$/
const stagedName = /^([a-zA-Z0-9_-]+)\.(mp4|webm)$/

/** Owns each staged file's lock through Ready, retention and the deletion attempt. */
export const createVideoOutput = (
    store: VideoStore,
    locks: LockService,
    delivery: Pick<VideoOutput, 'deliver' | 'canShare'>,
    timers: Timers = realTimers,
): VideoOutput => {
    type Job = {
        name: string
        release(): void
        delivered: boolean
        ended: boolean
        timer?: unknown
    }
    const jobs = new Map<string, Job>()
    const files = new WeakMap<File, Job>()

    const remove = async (id: string) => {
        const job = jobs.get(id)
        if (!job) return
        timers.clearTimeout(job.timer)
        try {
            await store.remove(job.name)
        } catch (error) {
            throw fileErrorOf(error)
        } finally {
            // Leave failed deletions unlocked so a later sweep can retry them.
            job.ended = true
            jobs.delete(id)
            job.release()
        }
    }

    return {
        stage: async (id, ext) => {
            if (!validId.test(id)) throw new Error('Invalid video file name')
            const name = `${id}.${ext}`
            let release!: () => void
            const held = new Promise<void>((resolve) => {
                release = resolve
            })
            let acquired!: () => void
            let failed!: (error: unknown) => void
            const ready = new Promise<void>((resolve, reject) => {
                acquired = resolve
                failed = reject
            })
            void locks
                .request(videoLock(id), { ifAvailable: true }, async (available) => {
                    if (!available) throw new Error('Video file is in use')
                    acquired()
                    await held
                })
                .catch(failed)
            await ready
            try {
                const handle = await store.create(name)
                const job: Job = { name, release, delivered: false, ended: false }
                jobs.set(id, job)
                return {
                    handle,
                    endReady: async () => {
                        if (jobs.get(id) !== job || job.ended) return
                        job.ended = true
                        if (!job.delivered) return remove(id)
                        job.timer = timers.setTimeout(() => {
                            void remove(id).catch(() => undefined)
                        }, BLOB_URL_MS)
                    },
                }
            } catch (error) {
                release()
                throw error
            }
        },
        file: async (id) => {
            const job = jobs.get(id)
            if (!job || job.ended) throw new Error('Video is no longer ready')
            try {
                const file = await store.file(job.name)
                files.set(file, job)
                return file
            } catch (error) {
                throw fileErrorOf(error)
            }
        },
        deliver: async (file, name, how) => {
            const job = files.get(file)
            if (!job || job.ended) throw new Error('Video is no longer ready')
            const result = await delivery.deliver(file, name, how)
            if (result === 'delivered') job.delivered = true
            return result
        },
        canShare: delivery.canShare,
        remove,
        sweep: async () => {
            for (const name of await store.names()) {
                const id = stagedName.exec(name)?.[1]
                if (!id) continue
                await locks.request(videoLock(id), { ifAvailable: true }, async (held) => {
                    if (held) await store.remove(name)
                })
            }
        },
    }
}
