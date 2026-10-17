import { inflateRaw, ungzip } from 'pako'
import { dataStart, readDirectory, type ZipEntry } from '../zip/directory'

export type ScpArchive = {
    get: (path: string) => Uint8Array | undefined
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    getJson: <T>(path: string) => T | undefined
}

export const parseScp = (buffer: ArrayBuffer): ScpArchive => {
    const bytes = new Uint8Array(buffer)

    // The shared central-directory parser; CRCs stay unchecked, as the preview fixture writes zeros.
    let entries: Map<string, ZipEntry>
    try {
        entries = new Map(readDirectory(bytes).map((entry) => [entry.name, entry]))
    } catch {
        throw new Error('Invalid scp file')
    }

    const get = (path: string) => {
        const entry = entries.get(path.startsWith('/') ? path.slice(1) : path)
        if (!entry) return

        let start: number
        try {
            start = dataStart(bytes, entry)
        } catch {
            throw new Error('Invalid scp file')
        }
        const data = bytes.subarray(start, start + entry.compressedSize)

        switch (entry.method) {
            case 0:
                return data
            case 8:
                return inflateRaw(data)
            default:
                throw new Error(`Unsupported compression method: ${entry.method}`)
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
    const getJson = <T>(path: string) => {
        const data = get(path)
        if (!data) return

        return JSON.parse(new TextDecoder().decode(data)) as T
    }

    return { get, getJson }
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const parseGzippedJson = <T>(data: Uint8Array) =>
    JSON.parse(new TextDecoder().decode(ungzip(data))) as T
