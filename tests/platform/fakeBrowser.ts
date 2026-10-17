// A minimal window and document for exercising web.ts in Node.

export type FakeWindow = EventTarget & {
    window: FakeWindow
    showSaveFilePicker?: (options: { id?: string; suggestedName?: string }) => Promise<unknown>
    showOpenFilePicker?: (options: { id?: string }) => Promise<unknown[]>
    open: (...args: unknown[]) => void
}

export type FakeDocument = EventTarget & {
    visibilityState: 'visible' | 'hidden'
    createElement: (tag: string) => unknown
    body: { append: (element: unknown) => void }
}

export const installFakeBrowser = (storage: Record<string, string> = {}) => {
    const events: string[] = []
    const opened: unknown[][] = []
    const downloads: { name: string; text: Promise<string> }[] = []
    const win = new EventTarget() as FakeWindow
    win.window = win
    win.open = (...args) => {
        opened.push(args)
    }
    // A download is an anchor clicked with a Blob URL.
    const blobs = new Map<string, Blob>()
    URL.createObjectURL = (blob) => {
        const url = `blob:fake/${blobs.size}`
        blobs.set(url, blob as Blob)
        return url
    }
    URL.revokeObjectURL = (url) => {
        blobs.delete(url)
    }
    // The download's release timer must not hold a test process open.
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((handler: () => void, delay?: number) => {
        const timer = realSetTimeout(handler, delay)
        if ((delay ?? 0) >= 30_000) timer.unref()
        return timer
    }) as typeof setTimeout
    const doc = new EventTarget() as FakeDocument
    doc.visibilityState = 'visible'
    let nextInputFile: File | undefined
    doc.body = { append: () => undefined }
    doc.createElement = (tag) => {
        if (tag === 'a') {
            const link = {
                href: '',
                download: '',
                rel: '',
                click: () => {
                    downloads.push({ name: link.download, text: blobs.get(link.href)!.text() })
                },
                remove: () => undefined,
            }
            return link
        }
        const input = {
            type: '',
            files: undefined as File[] | undefined,
            onchange: undefined as (() => void) | undefined,
            oncancel: undefined as (() => void) | undefined,
            click: () => {
                queueMicrotask(() => {
                    if (nextInputFile) {
                        input.files = [nextInputFile]
                        input.onchange?.()
                    } else input.oncancel?.()
                })
            },
        }
        return input
    }
    const localStorage = {
        getItem: (key: string) => storage[key] ?? null,
    }
    for (const [name, value] of Object.entries({ window: win, document: doc, localStorage }))
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })

    return {
        window: win,
        document: doc,
        events,
        opened,
        downloads,
        setInputFile: (file: File | undefined) => {
            nextInputFile = file
        },
    }
}

/** A handle recording its calls, with optional failures and gates. */
export const recordingHandle = (
    events: string[],
    options: { failWrite?: boolean; onWrite?: () => Promise<void> } = {},
) =>
    ({
        name: 'chart',
        createWritable: () => {
            events.push('create')
            return Promise.resolve({
                write: async (blob: Blob) => {
                    events.push(`write:${await blob.text()}`)
                    await options.onWrite?.()
                    if (options.failWrite) throw new DOMException('Disk full', 'QuotaExceededError')
                },
                close: () => {
                    events.push('close')
                    return Promise.resolve()
                },
                abort: () => {
                    events.push('abort')
                    return Promise.resolve()
                },
            })
        },
    }) as unknown as FileSystemFileHandle
