import { ungzip } from 'pako'
import { isChcyLevelData } from '../../../chcy/convert'

/** JSON from bytes that may be gzipped, or undefined. */
export const readJson = (bytes: Uint8Array): unknown => {
    const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b
    try {
        return JSON.parse(new TextDecoder().decode(isGzip ? ungzip(bytes) : bytes))
    } catch {
        return
    }
}

/** This engine's level data by content, gzipped or plain; a ChCy level is not. */
export const isLevelDataContent = (bytes: Uint8Array) => {
    const json = readJson(bytes)
    return (
        typeof json === 'object' &&
        json !== null &&
        'entities' in json &&
        Array.isArray(json.entities) &&
        !isChcyLevelData(json)
    )
}

/** Whether a file starting with this byte may be level data: gzip, or JSON text. */
export const mayBeLevelData = (first: number | undefined) =>
    first !== undefined && [0x1f, 0x7b, 0x20, 0x09, 0x0a, 0x0d, 0xef].includes(first)
