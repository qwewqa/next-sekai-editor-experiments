import { interpolateRaw } from '../../../utils/interpolate'
import type { AssetImportError, ImportErrorCode } from '../files/errors'
import { formatImportMessage, type ImportStrings } from '../files/importMessage'
import type { ServerChooserError } from './chooser'

// The words of a server's failures. Kept free of the i18n module so tests can pass
// the English strings in.

export type ServerStrings = ImportStrings & {
    server: {
        unreachable: string
        auth: string
        insecure: string
        checksum: string
        notFound: string
        invalid: string
        status: string
        filesFailed: string
        addressEmpty: string
        addressInvalid: string
        addressCredentials: string
    }
    /** The refusals worded for a server's item ("This item’s …"); the rest read as a file's do. */
    serverImport: Partial<Record<ImportErrorCode, string>>
    offline: string
}

/** The plain message for an item of a server that is refused. */
export const serverItemMessage = (
    error: AssetImportError,
    strings: ServerStrings,
    number: (value: number) => string,
    size: (bytes: number) => string,
) => {
    if (error.code === 'checksum') return strings.server.checksum
    // Details the server does not have: the item is not on it.
    if (error.code === 'missing' && error.detail.part === 'details') return strings.server.notFound
    return formatImportMessage(
        error,
        { ...strings, import: { ...strings.import, ...strings.serverImport } },
        number,
        size,
    )
}

/** What the chooser says under the address, or next to Use. */
export const serverErrorText = (error: ServerChooserError, strings: ServerStrings): string => {
    const { server } = strings
    if (error.kind === 'item') return error.message
    if (error.kind === 'address')
        return {
            empty: server.addressEmpty,
            invalid: server.addressInvalid,
            credentials: server.addressCredentials,
            insecure: server.insecure,
        }[error.code]
    if (error.code === 'offline') return strings.offline
    // The item's files are on another host, such as a CDN: it is named, not "this server".
    if (error.host !== undefined) return interpolateRaw(server.filesFailed, error.host)
    switch (error.code) {
        case 'unreachable':
            return server.unreachable
        case 'auth':
            return server.auth
        case 'insecure':
            return server.insecure
        case 'notFound':
            return server.notFound
        case 'status':
            return interpolateRaw(server.status, String(error.status ?? 0))
        case 'invalid':
        case 'tooBig':
            return server.invalid
    }
}
