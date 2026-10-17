import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { readZip } from '../../builtin-assets/zip.mjs'

const root = new URL('../../', import.meta.url)

/** A committed Built-in SCP as its entries. */
export const readBuiltin = (type) =>
    readZip(readFileSync(new URL(`public/builtin/${type}.scp`, root)))

/** The item of a Built-in SCP and getters for its resources by field. */
export function readBuiltinItem(type) {
    const entries = readBuiltin(type)
    const item = JSON.parse(entries.get(`sonolus/${type}s/nse-builtin`)).item
    const resource = (field) => entries.get(item[field].url.slice(1))
    const json = (field) => JSON.parse(gunzipSync(resource(field)))
    return { entries, item, resource, json }
}

export const readFixture = () =>
    JSON.parse(readFileSync(new URL('tests/fixtures/next-sekai-names.json', root), 'utf8'))
