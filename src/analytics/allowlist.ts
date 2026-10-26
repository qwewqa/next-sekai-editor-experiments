import { catalogue, COUNT_CAP, MS_CAP, scales, SECONDS_CAP, sources, type Scale } from './catalogue'

// The allowlist the server's monthly totals read (infra/stats/host/allowlist.sql, which
// `npm run analytics:allowlist` writes from this file and a unit test keeps in step). The public
// endpoint accepts anything, so only an event name, a property and a value that the catalogue
// allows are added to the totals, which are kept for good.

/** Umami's browser names (`BROWSERS` in its src/lib/constants.ts at v3.4.1). */
const browsers = [
    'android',
    'aol',
    'bb10',
    'beaker',
    'browser',
    'chrome',
    'chromium-webview',
    'crios',
    'curl',
    'edge',
    'edge-chromium',
    'edge-ios',
    'facebook',
    'firefox',
    'fxios',
    'ie',
    'instagram',
    'ios',
    'ios-webview',
    'kakaotalk',
    'miui',
    'opera',
    'opera-mini',
    'phantomjs',
    'safari',
    'samsung',
    'searchbot',
    'silk',
    'yandexbrowser',
]

/** The system names that `detectOS` of detect-browser returns, which Umami stores as they are. */
const systems = [
    'iOS',
    'Android OS',
    'BlackBerry OS',
    'Windows Mobile',
    'Amazon OS',
    'Windows 3.11',
    'Windows 95',
    'Windows 98',
    'Windows 2000',
    'Windows XP',
    'Windows Server 2003',
    'Windows Vista',
    'Windows 7',
    'Windows 8',
    'Windows 8.1',
    'Windows 10',
    'Windows ME',
    'Open BSD',
    'Sun OS',
    'Linux',
    'Mac OS',
    'Chrome OS',
    'QNX',
    'BeOS',
    'OS/2',
    'Search Bot',
]

/** The device types of Umami's `getDevice`: UAParser's types, and its own desktop and laptop. */
const devices = [
    'desktop',
    'laptop',
    'mobile',
    'tablet',
    'console',
    'smarttv',
    'wearable',
    'embedded',
    'xr',
]

const COUNTRY = '^[A-Z]{2}$'
const LANGUAGE = '^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$'

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const quote = (text: string) => `'${text.replaceAll("'", "''")}'`

/** The names of the built-in commands, from the object literal in `src/editor/commands/index.ts`. */
export const commandNamesFrom = (source: string) => {
    const start = source.indexOf('const builtInCommands = {')
    const end = source.indexOf('\n}\n', start)
    if (start < 0 || end < 0) throw new Error('The built-in commands were not found')
    return source
        .slice(start, end)
        .split('\n')
        .flatMap((line) => /^ {4}([A-Za-z_$][\w$]*)\s*[,:]/.exec(line)?.[1] ?? [])
}

type Row = [event: string, property: string, kind: string, value: string, max: number | null]

/** The rows: `text` and `pattern` are the allowed values, `boolean`, `count` and `time` are numbers. */
export const allowlistRows = (commandNames: readonly string[]) => {
    const rows: Row[] = []
    for (const [event, props] of Object.entries(catalogue)) {
        for (const [property, prop] of Object.entries(props as Record<string, unknown>)) {
            if (prop === 'boolean') rows.push([event, property, 'boolean', '', null])
            else if (prop === 'count') rows.push([event, property, 'count', '', COUNT_CAP])
            else if (prop === 'seconds') rows.push([event, property, 'count', '', SECONDS_CAP])
            else if (prop === 'ms') rows.push([event, property, 'time', '', MS_CAP])
            else if (typeof prop === 'object' && prop !== null) {
                if ('whole' in prop) rows.push([event, property, 'count', '', Number(prop.whole)])
                else if ('scale' in prop)
                    for (const label of scales[prop.scale as Scale])
                        rows.push([event, property, 'text', label, null])
                else if ('oneOf' in prop)
                    for (const value of prop.oneOf as readonly string[])
                        rows.push([event, property, 'text', value, null])
                else if ('pattern' in prop)
                    rows.push([event, property, 'pattern', (prop.pattern as RegExp).source, null])
                else throw new Error(`${event}.${property} has a kind that is not listed`)
            } else throw new Error(`${event}.${property} has a kind that is not listed`)
        }
    }
    // The usage event has one property per command and source.
    const names = commandNames.map(escapeRegex).join('|')
    const usage = sources.join('|')
    rows.push(['usage', '*', 'usage', `^(?:${names})\\.(?:${usage})$`, COUNT_CAP])
    for (const [property, values] of [
        ['browser', browsers],
        ['os', systems],
        ['device', devices],
    ] as const)
        for (const value of values) rows.push(['#session', property, 'text', value, null])
    rows.push(['#session', 'country', 'pattern', COUNTRY, null])
    rows.push(['#session', 'language', 'pattern', LANGUAGE, null])
    return rows
}

/** The text of infra/stats/host/allowlist.sql. */
export const allowlistSql = (commandNames: readonly string[]) => {
    const rows = allowlistRows(commandNames).map(
        ([event, property, kind, value, max]) =>
            `    (${quote(event)}, ${quote(property)}, ${quote(kind)}, ${quote(value)}, ${max ?? 'NULL'})`,
    )
    return `-- Generated by \`npm run analytics:allowlist\` from src/analytics/catalogue.ts. Do not edit.
-- What the monthly totals may hold (retention.sql runs after this file, in the same transaction):
--   event '#session'  the values of Umami's session columns
--   kind text         the value is one of those listed       pattern  it matches the regular expression
--   kind boolean      true or false                          count    a whole number from 0 to max
--   kind time         a whole number of milliseconds, 0 to max
--   kind usage        property '*': a key "<command>.<source>" that matches, with a count to max
CREATE TEMP TABLE nse_allowed (
    event text NOT NULL,
    property text NOT NULL,
    kind text NOT NULL,
    value text NOT NULL,
    max numeric
) ON COMMIT DROP;
INSERT INTO nse_allowed (event, property, kind, value, max) VALUES
${rows.join(',\n')};
CREATE INDEX ON nse_allowed (event, property);
`
}
