// What the From a Server field accepts (Part 2, 2.5.3): a server address, a share link to an item
// (`https://{server}/skins/{name}`, or Sonolus's `https://open.sonolus.com/{server}/…`) and a
// sonolus:// deep link. Pure, with no imports, so the release scripts can load it too.

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
    /** Plain http is refused unless the apps allow it for local servers. */
    allowHttp?: boolean
}

const assetCategories = 'skins|particles|backgrounds|effects'
// The types of item a server has that the chooser does not take.
const otherCategories = 'levels|engines|posts|playlists|replays|rooms|users'
const itemPath = new RegExp(`^(.*?)(?:/sonolus)?/(${assetCategories})/([^/]+)$`)
// A list page, or another type's item: only the server counts.
const serverOnlyPath = new RegExp(
    `^(.*?)(?:/sonolus)?/(?:(?:${assetCategories}|${otherCategories})/(?:list|info)|(?:${otherCategories})/[^/]+)$`,
)
const serverPath = /^(.*?)(?:\/sonolus(?:\/info)?)?$/
// Sonolus's share links carry the server address after this host.
const OPEN_HOST = 'open.sonolus.com'

const toUrl = (text: string) => {
    let url: URL
    try {
        url = new URL(text)
    } catch {
        throw new ServerUrlError('invalid')
    }
    if (url.hostname !== OPEN_HOST) return url
    // `https://open.sonolus.com/{server}/{type}s/{name}` opens that item in the app.
    const rest = url.pathname.replace(/^\/+/, '')
    if (rest === '') throw new ServerUrlError('invalid')
    let inner: URL
    try {
        inner = new URL(`https://${rest}${url.search}`)
    } catch {
        throw new ServerUrlError('invalid')
    }
    if (inner.hostname === OPEN_HOST || inner.username || inner.password)
        throw new ServerUrlError('invalid')
    return inner
}

/** Reads the field's text. A bare host counts as https; a deep link is rewritten to https. */
export const parseServerUrl = (input: string, options: ParseOptions = {}): ParsedServerUrl => {
    let text = input.trim()
    if (text === '') throw new ServerUrlError('empty')
    if (/^sonolus:\/\//i.test(text)) text = `https://${text.slice('sonolus://'.length)}`
    else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(text)) text = `https://${text}`

    const url = toUrl(text)
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
    const serverOnly = serverOnlyPath.exec(path)
    if (serverOnly) return { base: origin + (serverOnly[1] ?? '') }
    return { base: origin + (serverPath.exec(path)?.[1] ?? '') }
}

const ipv4Parts = (host: string) => {
    const parts = host.split('.')
    if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return
    const numbers = parts.map(Number)
    return numbers.every((part) => part <= 255) ? numbers : undefined
}

const isLocalIpv4 = ([a = 0, b = 0]: number[]) =>
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)

/** The eight 16-bit groups of an IPv6 literal, or undefined. */
const ipv6Groups = (host: string) => {
    let text = host
    // A dotted IPv4 tail stands for the last two groups.
    const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text)
    if (dotted) {
        const v4 = ipv4Parts(dotted[2] ?? '')
        if (!v4) return
        const [a = 0, b = 0, c = 0, d = 0] = v4
        text = `${dotted[1] ?? ''}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
    }
    const halves = text.split('::')
    if (halves.length > 2) return
    const split = (part: string | undefined) => (part ? part.split(':') : [])
    const head = split(halves[0])
    const tail = split(halves[1])
    const missing = 8 - head.length - tail.length
    if (halves.length === 1 ? missing !== 0 : missing < 1) return
    const filler = Array<string>(halves.length === 1 ? 0 : missing).fill('0')
    const groups = [...head, ...filler, ...tail]
    if (!groups.every((group) => /^[\da-f]{1,4}$/i.test(group))) return
    return groups.map((group) => parseInt(group, 16))
}

/**
 * Whether a host is on this device or its network: `localhost`, a `.local` name, or a loopback,
 * private or link-local address (Part 2, 2.5.3's thumbnails; DECISIONS D11).
 */
export const isLocalHost = (hostname: string) => {
    const host = hostname
        .toLowerCase()
        .replace(/^\[(.*)\]$/, '$1')
        .replace(/\.$/, '')
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
    const v4 = ipv4Parts(host)
    if (v4) return isLocalIpv4(v4)
    if (!host.includes(':')) return false
    const groups = ipv6Groups(host.replace(/%.*$/, ''))
    // Not an address anything would fetch: treated as local, so nothing is fetched.
    if (!groups) return true
    const [first = 0, , , , , sixth = 0, seventh = 0] = groups
    // :: and ::1
    if (groups.slice(0, 7).every((group) => group === 0)) return true
    // fc00::/7 (unique local) and fe80::/10 (link-local)
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return true
    // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) forms
    if (groups.slice(0, 5).every((group) => group === 0) && (sixth === 0 || sixth === 0xffff))
        return isLocalIpv4([seventh >> 8, seventh & 0xff])
    return false
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
