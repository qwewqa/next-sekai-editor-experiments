// The old auto save's keys, which the migration moves into a session,
// and recovery data as a file to keep.

/** The old auto save slot, which the migration moves into a session. */
export const AUTO_SAVE_KEY = 'autoSave.levelData'
/** A slot an older build set aside as unreadable; it stays until downloaded or discarded. */
export const AUTO_SAVE_UNREADABLE_KEY = 'autoSave.unreadable'

const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

const isGzip = (bytes: Uint8Array) => bytes[0] === 0x1f && bytes[1] === 0x8b

const nameOf = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

/** A name any file system takes, as the support gate makes it. */
const safeName = (name: string) =>
    // eslint-disable-next-line no-control-regex
    name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')

const withExtension = (name: string, extension: string) =>
    name.slice(-extension.length).toLowerCase() === extension ? name : name + extension

/**
 * Recovery data as a file to keep (`recovered`): a journal's level data as
 * `.nsld`, the old auto save's v1 form as `.nsld`, raw level data as `.json` unchanged, and
 * anything else as the text it is. The names follow the support gate's: the
 * journal's `descriptor.name`, else `descriptor.sourceName`, else "Untitled"; the slot's
 * `filename`, else "Recovery".
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
                        name: `${safeName(name)}.nsld`,
                    }
                }
            }
            if (typeof value.levelData === 'string') {
                const bytes = fromBase64(value.levelData)
                if (isGzip(bytes))
                    return {
                        blob: new Blob([bytes], { type: 'application/octet-stream' }),
                        name: safeName(
                            withExtension(nameOf(value.filename) ?? 'Recovery', '.nsld'),
                        ),
                    }
            }
            if ('entities' in value)
                return {
                    blob: new Blob([text], { type: 'application/json' }),
                    name: safeName(withExtension(nameOf(value.filename) ?? 'Recovery', '.json')),
                }
        }
    } catch {
        // Damaged; kept as text below.
    }
    return { blob: new Blob([text], { type: 'text/plain' }), name: 'Recovery.txt' }
}
