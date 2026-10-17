// A minimal window and document for exercising web.ts in Node.

export type FakeWindow = EventTarget & {
    window: FakeWindow
    showSaveFilePicker?: (options: { id?: string; suggestedName?: string }) => Promise<unknown>
    showOpenFilePicker?: (options: { id?: string }) => Promise<unknown[]>
    open: (...args: unknown[]) => void
    saveAs: (blob: Blob, name: string) => void
}

export type FakeDocument = EventTarget & {
    visibilityState: 'visible' | 'hidden'
    createElement: (tag: string) => unknown
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
    win.saveAs = (blob, name) => {
        downloads.push({ name, text: blob.text() })
    }
    const doc = new EventTarget() as FakeDocument
    doc.visibilityState = 'visible'
    let nextInputFile: File | undefined
    doc.createElement = () => {
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
