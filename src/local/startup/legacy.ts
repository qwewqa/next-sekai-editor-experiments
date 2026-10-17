import { storageKey } from '../../storage'
import { JOURNAL_TOTAL_LIMIT } from '../journal/store'

// The old auto save's keys and the legacy recovery slot (Part 1 §1.8, §1.6.11.3). For the first
// releases after Stage 1 the open session's whole state is also kept under `legacyRecovery`, in
// the old auto save's v1 form, as insurance against a bug in the new pipeline: written from the
// hide journal's level data, otherwise at idle every 30–60 s, and once by the migration from the
// old slot's value. It counts in the journal's budget and is the first thing left out.

/** Today's auto save slot, which the migration moves into a session. */
export const AUTO_SAVE_KEY = 'autoSave.levelData'
/** A slot an older build set aside as unreadable; it stays until downloaded or discarded. */
export const AUTO_SAVE_UNREADABLE_KEY = 'autoSave.unreadable'
/** The legacy recovery slot; the migration never reads it. */
export const LEGACY_RECOVERY_KEY = 'legacyRecovery'

/** Builds from this version stop writing the legacy slot and remove it (r12-arch-core M2). */
export const LEGACY_SLOT_UNTIL = '0.6.3'

/**
 * `legacyRecovery`'s value: either form `autoSaveSchema` accepts (§1.6.11.3). The v1 form's
 * `levelData` is base64 of the gzipped level data; the other form is raw level data.
 */
export type LegacyRecovery =
    | { version: 1; filename?: string; levelData: string; defaultGuideColors?: number[] }
    | { bgmOffset: number; entities: unknown[] }

const release = (version: string) =>
    (version.split('+')[0] ?? version).split('.').map((part) => Number.parseInt(part, 10) || 0)

/** Whether a build of this version still writes the legacy slot. */
export const writesLegacySlot = (appVersion: string) => {
    const [a = 0, b = 0, c = 0] = release(appVersion)
    const [x = 0, y = 0, z = 0] = release(LEGACY_SLOT_UNTIL)
    return a !== x ? a < x : b !== y ? b < y : c < z
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

const local = (): Store | undefined => {
    try {
        return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
        return undefined
    }
}

/**
 * Writes the legacy slot when it fits the journals' budget beside every pending journal, and reads
 * it back; true only when it verified. Left out (and an older copy removed) when it doesn't fit.
 */
export const writeLegacyRecovery = (
    text: string,
    store: Store | undefined = local(),
    prefix = storageKey(''),
) => {
    if (!store) return false
    const key = prefix + LEGACY_RECOVERY_KEY
    try {
        let others = 0
        const journals = `${prefix}journal.`
        for (let i = 0; i < store.length; i++) {
            const name = store.key(i)
            if (name?.startsWith(journals))
                others += name.length + (store.getItem(name)?.length ?? 0)
        }
        if (others + key.length + text.length > JOURNAL_TOTAL_LIMIT) {
            store.removeItem(key)
            return false
        }
        store.setItem(key, text)
        return store.getItem(key) === text
    } catch {
        return false
    }
}

/** Removes the legacy slot once builds stop writing it. */
export const removeLegacyRecovery = (store: Store | undefined = local()) => {
    try {
        store?.removeItem(storageKey(LEGACY_RECOVERY_KEY))
    } catch {
        // Left for a later load.
    }
}

/** The legacy slot's v1 form from a journal's gzipped level data (§1.6.11.3). */
export const legacyFromJournal = (
    journal: {
        levelDataGz: string
        editorMetadata?: { defaultGuideColors?: number[] }
    },
    filename: string | undefined,
): LegacyRecovery => ({
    version: 1,
    ...(filename ? { filename } : {}),
    levelData: journal.levelDataGz,
    ...(journal.editorMetadata?.defaultGuideColors
        ? { defaultGuideColors: journal.editorMetadata.defaultGuideColors }
        : {}),
})

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b

const nameOf = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/**
 * Recovery data as a file to keep (§1.8, §1.6.11.2's `recovered`): a journal's level data as
 * `.nsld`, the old auto save's v1 form as `.nsld`, raw level data as `.json` unchanged, and
 * anything else as the text it is. The names follow the support gate's (§1.6.11.3): the
 * journal's `descriptor.name`, else `descriptor.sourceName`, else "Untitled"; the slot's
 * `filename`, else "Untitled".
 */
export const toRecoveryFile = (text: string): { blob: Blob; name: string } => {
    try {
        const data: unknown = JSON.parse(text)
        if (typeof data === 'object' && data !== null) {
            const value = data as Record<string, unknown>
            if (typeof value.levelDataGz === 'string') {
                const descriptor = (value.descriptor ?? {}) as Record<string, unknown>
                const bytes = fromBase64(value.levelDataGz)
                if (isGzip(bytes)) {
                    const name =
                        nameOf(descriptor.name) ?? nameOf(descriptor.sourceName) ?? 'Untitled'
                    return {
                        blob: new Blob([bytes], { type: 'application/octet-stream' }),
                        name: `${name}.nsld`,
                    }
                }
            }
            if (typeof value.levelData === 'string') {
                const bytes = fromBase64(value.levelData)
                if (isGzip(bytes))
                    return {
                        blob: new Blob([bytes], { type: 'application/octet-stream' }),
                        name: `${nameOf(value.filename) ?? 'Untitled'}.nsld`,
                    }
            }
            if ('entities' in value)
                return {
                    blob: new Blob([text], { type: 'application/json' }),
                    name: 'Untitled.json',
                }
        }
    } catch {
        // Damaged; kept as text below.
    }
    return { blob: new Blob([text], { type: 'text/plain' }), name: 'Recovery.txt' }
}
