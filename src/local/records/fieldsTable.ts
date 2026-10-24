import { enums, kindNames, kindRecords, records } from './schema'

/**
 * `fields-v1.json`'s tree: each record form by name (a positional list of
 * `{ name, type, ref?, acyclic?, optional?, minItems?, default? }`, or `{ type, minItems? }` for a record
 * that is itself an array), `kinds` (each kind's body record), `kindOrder` (the v1 kind order,
 * the one place it's carried: object key order means nothing) and `enums` (each choice set,
 * value → the `levelVersion` that added it). The viewer and both checkers read it.
 */
export const fieldsTable = () => ({ ...records, kinds: kindRecords, kindOrder: kindNames, enums })

const inline = (value: unknown) =>
    JSON.stringify(value)
        .replace(/^\{/, '{ ')
        .replace(/\}$/, ' }')
        .replace(/":/g, '": ')
        .replace(/,"/g, ', "')

const entries = (value: object, line: (item: unknown) => string) =>
    `{\n${Object.entries(value)
        .map(([name, item]) => `        ${JSON.stringify(name)}: ${line(item)}`)
        .join(',\n')}\n    }`

/** One line per field, kind or choice set, so a diff shows each. */
const stringify = (table: Record<string, unknown>) => {
    const items = Object.entries(table).map(([key, value]) => {
        const text = Array.isArray(value)
            ? `[\n${value.map((item) => `        ${inline(item)}`).join(',\n')}\n    ]`
            : Object.hasOwn(value as object, 'type')
              ? inline(value)
              : entries(value as object, inline)
        return `    ${JSON.stringify(key)}: ${text}`
    })
    return `{\n${items.join(',\n')}\n}\n`
}

/**
 * The generated files, by path from the repository root, as `npm run format:gen` writes them: the
 * table, and the independent checker's copy of it (`tools/nxsp_check.py` shares no code with the app).
 */
export const formatFiles = (): Record<string, string> => {
    const table = stringify(fieldsTable())
    return { 'src/local/records/fields-v1.json': table, 'tools/fields-v1.json': table }
}
