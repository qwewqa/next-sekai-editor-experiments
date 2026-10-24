import { sha256Sync, toHex } from './hash'
import type { DeviceForm } from './nxsp/project'

// The device a file records is per document: HMAC-SHA-256 of the document's
// `lineageId` under this install's own `deviceId`, which never leaves the install. Files of one
// lineage, which the lineage already links, share it, so this install's own saves read as its own
// across Save As… and reopening; files of two lineages can't be linked to one install by it.

/** This install's `deviceId` and label: what a Save is given, the file's device derived from it. */
export type DeviceSource = { deviceId: string; label: string }

const BLOCK = 64
const encoder = new TextEncoder()

/** HMAC-SHA-256 (RFC 2104) by the synchronous SHA-256. */
export const hmacSha256 = (key: Uint8Array, message: Uint8Array) => {
    const k = key.length > BLOCK ? sha256Sync(key) : key
    const inner = new Uint8Array(BLOCK + message.length)
    const outer = new Uint8Array(BLOCK + 32)
    for (let i = 0; i < BLOCK; i++) {
        const byte = k[i] ?? 0
        inner[i] = byte ^ 0x36
        outer[i] = byte ^ 0x5c
    }
    inner.set(message, BLOCK)
    outer.set(sha256Sync(inner), BLOCK)
    return sha256Sync(outer)
}

/** A document's device id: the HMAC's first 16 bytes as a lowercase UUID version 8 (RFC 9562). */
export const documentDeviceId = (deviceId: string, lineageId: string) => {
    const bytes = hmacSha256(encoder.encode(deviceId), encoder.encode(lineageId)).slice(0, 16)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = toHex(bytes)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The `device` a write of `lineageId` records. */
export const documentDevice = (source: DeviceSource, lineageId: string): DeviceForm => ({
    id: documentDeviceId(source.deviceId, lineageId),
    label: source.label,
})
