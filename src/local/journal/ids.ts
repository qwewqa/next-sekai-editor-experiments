import { sha256, sha256Sync, toHex } from '../hash'

// Ids replay derives from the journal (§1.6.4 #7), the same on every run: a kill between replay's
// commit and the key's delete runs it again at the next load, which then finds what it made
// instead of making a second recovery chain or `recovered` row.

const encoder = new TextEncoder()

/** A UUID's form of a digest's first 16 bytes, as RFC 9562's version 8 (custom). */
const uuidOf = (digest: Uint8Array) => {
    const bytes = digest.slice(0, 16)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = toHex(bytes)
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A recovery session's ids, from the journal's session, `seq` and `writtenAt`. */
export const recoveryIds = (journal: { sessionId: string; seq: number; writtenAt: number }) => {
    const { sessionId, seq, writtenAt } = journal
    const of = (what: string) =>
        uuidOf(sha256Sync(encoder.encode(['recovery', what, sessionId, seq, writtenAt].join('\0'))))
    return { chainId: of('chain'), docId: of('doc'), sessionId: of('session') }
}

/** A `recovered` row's id, from the key's name and its text as it was. */
export const recoveredId = async (from: string, text: string) =>
    uuidOf(await sha256(encoder.encode(['recovered', from, text].join('\0'))))
