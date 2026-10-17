import { LOCAL_HEADER_SIZE, dataStart, readDirectory, type ZipEntry } from '../../zip/directory'
import { parseScp } from '../scp'
import { AssetError } from './types'

/** The package's last bytes, where its central directory is: one request lists every entry. */
const TAIL_SIZE = 32 * 1024
/** What a local header's extra field may add to the least range of an entry. */
const HEADER_SLACK = 512

export type RangedScp = {
    /** An entry's bytes, or undefined when the package has none by that path. */
    get: (path: string) => Promise<Uint8Array | undefined>
}

const wholeScp = (buffer: ArrayBuffer): RangedScp => {
    const archive = parseScp(buffer)
    return { get: (path) => Promise.resolve(archive.get(path)) }
}

/**
 * Opens a package for reading a few entries without downloading all of it: the tail first, then
 * the ranges the entries need. A server that ignores ranges sends the whole file, which is read as is.
 * Resolves undefined when the file is absent or the signal aborts.
 */
export const openRangedScp = async (
    url: string,
    signal: AbortSignal,
): Promise<RangedScp | undefined> => {
    const request = async (range: string) => {
        const response = await fetch(url, { signal, headers: { Range: range } })
        if (response.status === 404) return
        if (!response.ok && response.status !== 206)
            throw new AssetError('unavailable', `${url}: HTTP ${response.status}`)
        return { response, body: new Uint8Array(await response.arrayBuffer()) }
    }
    const whole = async (first?: Awaited<ReturnType<typeof request>>) => {
        if (first?.response.status === 200) return wholeScp(first.body.buffer)
        const response = await fetch(url, { signal })
        if (response.status === 404) return
        if (!response.ok) throw new AssetError('unavailable', `${url}: HTTP ${response.status}`)
        return wholeScp(await response.arrayBuffer())
    }

    // The range a response covers, and the file's size; some servers misread a suffix range.
    const covered = (read: NonNullable<Awaited<ReturnType<typeof request>>>) => {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
            read.response.headers.get('Content-Range') ?? '',
        )
        const [start, end, total] = (match?.slice(1) ?? []).map(Number)
        return read.response.status === 206 && start !== undefined
            ? { start, end: end!, total: total! }
            : undefined
    }
    let tail = await request(`bytes=-${TAIL_SIZE}`)
    if (signal.aborted || !tail) return
    let range = covered(tail)
    if (!range) return whole(tail)
    if (range.end !== range.total - 1) {
        // The size is right even where the bytes are not: ask for the tail by position.
        tail = await request(`bytes=${Math.max(0, range.total - TAIL_SIZE)}-${range.total - 1}`)
        if (signal.aborted || !tail) return
        range = covered(tail)
        if (!range || range.end !== range.total - 1) return whole(tail)
    }
    const { total } = range
    if (tail.body.length !== range.end - range.start + 1) return whole()

    // The file's size, with only the parts read so far filled in.
    const bytes = new Uint8Array(total)
    bytes.set(tail.body, total - tail.body.length)
    let entries: Map<string, ZipEntry>
    try {
        entries = new Map(readDirectory(bytes).map((entry) => [entry.name, entry]))
    } catch {
        // A directory the tail does not hold in full.
        return whole()
    }

    const fetchRange = async (start: number, end: number) => {
        const read = await request(`bytes=${start}-${end - 1}`)
        if (!read) throw new AssetError('missing', `${url}: not found`)
        if (read.response.status !== 206 || read.body.length !== end - start)
            throw new AssetError('unavailable', `${url}: range not served`)
        bytes.set(read.body, start)
    }

    return {
        get: async (path) => {
            const entry = entries.get(path.startsWith('/') ? path.slice(1) : path)
            if (!entry) return
            if (entry.localOffset < total - tail.body.length) {
                const least = LOCAL_HEADER_SIZE + entry.rawName.length + entry.compressedSize
                const end = Math.min(total, entry.localOffset + least + HEADER_SLACK)
                await fetchRange(entry.localOffset, end)
                // A longer extra field leaves the rest of the data to read.
                const dataEnd = dataStart(bytes, entry) + entry.compressedSize
                if (dataEnd > end) await fetchRange(end, Math.min(total, dataEnd))
                if (signal.aborted) return
            }
            return parseScp(bytes.buffer).get(path)
        },
    }
}
