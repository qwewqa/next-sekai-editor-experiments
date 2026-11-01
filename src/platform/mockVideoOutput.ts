import type { VideoStore } from './videoOutput'

/** In-memory OPFS files for the mock; sync writes become visible without a swap file. */
export const memoryVideoStore = (): VideoStore => {
    const files = new Map<string, Uint8Array<ArrayBuffer>>()
    const bytes = (name: string) => {
        const value = files.get(name)
        if (!value) throw new DOMException('Not found', 'NotFoundError')
        return value
    }
    const file = (name: string) => Promise.resolve(new File([bytes(name)], name))
    return {
        create: (name) => {
            if (files.has(name)) return Promise.reject(new Error('Video file already exists'))
            files.set(name, new Uint8Array())
            let opened = false
            return Promise.resolve({
                kind: 'file',
                name,
                getFile: () => file(name),
                createSyncAccessHandle: () => {
                    if (opened) throw new DOMException('In use', 'NoModificationAllowedError')
                    opened = true
                    let closed = false
                    const check = () => {
                        if (closed) throw new Error('Handle is closed')
                    }
                    return Promise.resolve({
                        write: (data: Uint8Array, { at }: { at: number }) => {
                            check()
                            const old = bytes(name)
                            const next = new Uint8Array(Math.max(old.length, at + data.length))
                            next.set(old)
                            next.set(data, at)
                            files.set(name, next)
                            return data.length
                        },
                        truncate: (size: number) => {
                            check()
                            const next = new Uint8Array(size)
                            next.set(bytes(name).subarray(0, size))
                            files.set(name, next)
                        },
                        flush: check,
                        close: () => {
                            closed = true
                            opened = false
                        },
                    })
                },
            } as unknown as FileSystemFileHandle)
        },
        file,
        remove: (name) => {
            files.delete(name)
            return Promise.resolve()
        },
        names: () => Promise.resolve([...files.keys()]),
    }
}
