import { interpolateRaw } from '../../../utils/interpolate'
import type { AssetImportError, ImportErrorCode } from '../files/errors'
import { formatImportMessage, type ImportStrings } from '../files/importMessage'
import type { ServerChooserError } from './chooser'

// The words of a server's failures (Part 2, 2.5.3). Kept free of the i18n module so tests can pass
// the English strings in.

export type ServerStrings = ImportStrings & {
    server: {
        blocked: string
        blockedRoute: string
        blockedOwners: string
        unreachable: string
        auth: string
        insecure: string
        checksum: string
        notFound: string
        invalid: string
        status: string
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
) =>
    error.code === 'checksum'
        ? strings.server.checksum
        : formatImportMessage(
              error,
              { ...strings, import: { ...strings.import, ...strings.serverImport } },
              number,
          )

export type ServerErrorText = {
    text: string
    /** For a server that sends no CORS headers: what to do instead, and what its owner can do. */
    route?: string
    owners?: string
}

/** What the chooser says under the address field. */
export const serverErrorText = (
    error: ServerChooserError,
    strings: ServerStrings,
): ServerErrorText => {
    const { server } = strings
    if (error.kind === 'item') return { text: error.message }
    if (error.kind === 'address')
        return {
            text: {
                empty: server.addressEmpty,
                invalid: server.addressInvalid,
                credentials: server.addressCredentials,
                insecure: server.insecure,
            }[error.code],
        }
    switch (error.code) {
        case 'offline':
            return { text: strings.offline }
        case 'blocked':
            return {
                text: server.blocked,
                route: server.blockedRoute,
                owners: server.blockedOwners,
            }
        case 'unreachable':
            return { text: server.unreachable }
        case 'auth':
            return { text: server.auth }
        case 'insecure':
            return { text: server.insecure }
        case 'notFound':
            return { text: server.notFound }
        case 'status':
            return { text: interpolateRaw(server.status, String(error.status ?? 0)) }
        case 'invalid':
        case 'tooBig':
            return { text: server.invalid }
    }
}
