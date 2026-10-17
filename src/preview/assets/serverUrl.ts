// What the From a Server field accepts (Part 2, 2.5.3): a server address, a share link to an item
// and a sonolus:// deep link. Pure, with no imports, so the release scripts can load it too.

export const serverCategories = ['skins', 'particles', 'backgrounds', 'effects'] as const
export type ServerCategory = (typeof serverCategories)[number]

export type ServerUrlErrorCode = 'empty' | 'invalid' | 'credentials' | 'insecure'

export class ServerUrlError extends Error {
    readonly code: ServerUrlErrorCode
    // Written without a parameter property, so Node can load this file as it is.
    constructor(code: ServerUrlErrorCode) {
        super(code)
        this.name = 'ServerUrlError'
        this.code = code
    }
}

export type ParsedServerUrl = {
    /** The server address: scheme, host and path, with no trailing slash and no `/sonolus`. */
    base: string
    /** A share link names one item. */
    item?: { category: ServerCategory; name: string }
}

export type ParseOptions = {
    /** Plain http is refused on the web (mixed content); the apps allow it for local servers. */
    allowHttp?: boolean
}

const itemPath = /^(.*?)(?:\/sonolus)?\/(skins|particles|backgrounds|effects)\/([^/]+)$/
const serverPath = /^(.*?)(?:\/sonolus(?:\/info)?)?$/

/** Reads the field's text. A bare host counts as https; a deep link is rewritten to https. */
export const parseServerUrl = (input: string, options: ParseOptions = {}): ParsedServerUrl => {
    let text = input.trim()
    if (text === '') throw new ServerUrlError('empty')
    if (/^sonolus:\/\//i.test(text)) text = `https://${text.slice('sonolus://'.length)}`
    else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`

    let url: URL
    try {
        url = new URL(text)
    } catch {
        throw new ServerUrlError('invalid')
    }
    if (url.protocol === 'http:') {
        if (!options.allowHttp) throw new ServerUrlError('insecure')
    } else if (url.protocol !== 'https:') throw new ServerUrlError('invalid')
    if (url.username || url.password) throw new ServerUrlError('credentials')

    const path = url.pathname.replace(/\/+$/, '')
    const origin = url.origin
    const match = itemPath.exec(path)
    if (match && match[3] !== 'list' && match[3] !== 'info') {
        let name: string
        try {
            name = decodeURIComponent(match[3] ?? '')
        } catch {
            throw new ServerUrlError('invalid')
        }
        return {
            base: origin + (match[1] ?? ''),
            item: { category: match[2] as ServerCategory, name },
        }
    }
    // The address of a category's own endpoints (`…/sonolus/skins/list`) names the server.
    const listing = /^(.*?)\/sonolus\/(?:skins|particles|backgrounds|effects)\/(?:list|info)$/.exec(
        path,
    )
    if (listing) return { base: origin + (listing[1] ?? '') }
    return { base: origin + (serverPath.exec(path)?.[1] ?? '') }
}

/**
 * The details endpoint of a share link or an API link to one item of a category, with its query,
 * for `release-assets.mjs`. Plain http is allowed there.
 */
export const itemDetailsUrl = (source: string, category: ServerCategory) => {
    let parsed: ParsedServerUrl
    try {
        parsed = parseServerUrl(source, { allowHttp: true })
    } catch {
        throw new Error('Preview item URL must use HTTP or HTTPS without credentials')
    }
    if (!/^https?:\/\//i.test(source.trim()))
        throw new Error('Preview item URL must use HTTP or HTTPS without credentials')
    if (parsed.item?.category !== category) throw new Error(`Expected a ${category} item URL`)
    return `${parsed.base}/sonolus/${category}/${encodeURIComponent(parsed.item.name)}${new URL(source).search}`
}

/** A server address as the lists show it, without the scheme: `nse.qwewqa.dev/builtin-server`. */
export const displayOrigin = (origin: string) => origin.replace(/^https?:\/\//i, '')
