import { webLockService } from '../local/locks'
import { fileErrorOf, handOver } from './handover'
import { createVideoOutput, type VideoStore } from './videoOutput'

const directory = async (create = false) =>
    (await navigator.storage.getDirectory()).getDirectoryHandle('export-video', { create })

const missing = (error: unknown) => error instanceof DOMException && error.name === 'NotFoundError'

const store: VideoStore = {
    create: async (name) => {
        const dir = await directory(true)
        try {
            await dir.getFileHandle(name)
        } catch (error) {
            if (missing(error)) return dir.getFileHandle(name, { create: true })
            throw error
        }
        throw new Error('Video file already exists')
    },
    file: async (name) => (await (await directory()).getFileHandle(name)).getFile(),
    remove: async (name) => {
        try {
            await (await directory()).removeEntry(name)
        } catch (error) {
            if (!missing(error)) throw error
        }
    },
    names: async () => {
        try {
            const names: string[] = []
            for await (const [name, handle] of (await directory()).entries())
                if (handle.kind === 'file') names.push(name)
            return names
        } catch (error) {
            if (missing(error)) return []
            throw error
        }
    },
}

const shareFile = (file: File, name = file.name) =>
    new File([file], name, { type: file.name.endsWith('.mp4') ? 'video/mp4' : 'video/webm' })

export const webVideoOutput = createVideoOutput(store, webLockService, {
    canShare: (file) => {
        try {
            return (
                typeof navigator.canShare === 'function' &&
                navigator.canShare({ files: [shareFile(file)] })
            )
        } catch {
            return false
        }
    },
    deliver: async (file, name, how) => {
        try {
            if (how === 'download') await handOver(file, name, performance.now(), undefined)
            else await navigator.share({ files: [shareFile(file, name)] })
            return 'delivered'
        } catch (error) {
            if (how === 'share' && error instanceof DOMException && error.name === 'AbortError')
                return 'cancelled'
            throw fileErrorOf(error)
        }
    },
})
