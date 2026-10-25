// Copies a seed's chains into many, for Recent Sessions at scale (docs/performance-testing.md,
// "Seeds"):
//   node scripts/perf/seeds.mjs <seed.json> <out.json> <chains> [hours between them, 6]
// Each copy gets new chain, document, lineage and session ids and is shifted earlier by its
// place in the list. The first copy keeps the seed's times. The copies share the seed's chunks and
// nodes, which are keyed by their hash.
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output, countText, hoursText = '6'] = process.argv.slice(2)
if (!input || !output || !countText)
    throw new Error('Usage: node scripts/perf/seeds.mjs <seed.json> <out.json> <chains> [hours]')
const count = Number(countText)
const step = Number(hoursText) * 3600_000
const dump = JSON.parse(readFileSync(input, 'utf8'))
const store = (name) => dump.stores.find((s) => s.name === name)

const chains = store('chains').records.map((r) => r.value)
const byChain = (name, field) => {
    const map = new Map()
    for (const { value } of store(name).records)
        map.set(value[field], [...(map.get(value[field]) ?? []), value])
    return map
}
const sessionsOf = byChain('sessions', 'chainId')
const entriesOf = byChain('entries', 'sessionId')
const blocksOf = byChain('stackBlocks', 'sessionId')
const handlesOf = byChain('handles', 'chainId')
const out = { chains: [], sessions: [], entries: [], stackBlocks: [], handles: [] }
const later = (value, shift, fields) => {
    const copy = { ...value }
    for (const field of fields) if (typeof copy[field] === 'number') copy[field] -= shift
    return copy
}

for (let k = 0; k < count; k++)
    for (const chain of chains) {
        const shift = k * step
        const ids = new Map()
        const id = (old) => {
            if (!ids.has(old)) ids.set(old, k === 0 ? old : randomUUID())
            return ids.get(old)
        }
        const chainId = id(chain.chainId)
        out.chains.push({
            ...later(chain, shift, ['startedAt', 'updatedAt']),
            chainId,
            head: id(chain.head),
            docId: id(chain.docId),
            lineageId: id(chain.lineageId),
            ...(k ? { sourceName: `${chain.sourceName} ${k + 1}` } : {}),
        })
        for (const session of sessionsOf.get(chain.chainId) ?? []) {
            out.sessions.push({
                ...later(session, shift, ['startedAt', 'updatedAt']),
                id: id(session.id),
                chainId,
                ...(session.parent
                    ? { parent: { ...session.parent, id: id(session.parent.id) } }
                    : {}),
            })
            for (const entry of entriesOf.get(session.id) ?? [])
                out.entries.push({ ...later(entry, shift, ['time']), sessionId: id(session.id) })
            for (const block of blocksOf.get(session.id) ?? [])
                out.stackBlocks.push({ ...block, sessionId: id(session.id) })
        }
        for (const handle of handlesOf.get(chain.chainId) ?? [])
            out.handles.push({ ...handle, chainId })
    }

/** IndexedDB's order for these keys: numbers before strings, arrays by element. */
const compareKeys = (a, b) => {
    if (Array.isArray(a)) {
        for (let i = 0; i < Math.min(a.length, b.length); i++) {
            const c = compareKeys(a[i], b[i])
            if (c) return c
        }
        return a.length - b.length
    }
    if (typeof a !== typeof b) return typeof a === 'number' ? -1 : 1
    return a < b ? -1 : a > b ? 1 : 0
}
const keys = {
    chains: (v) => v.chainId,
    sessions: (v) => v.id,
    entries: (v) => [v.sessionId, v.seq],
    stackBlocks: (v) => [v.sessionId, v.block],
    handles: (v) => [v.chainId, v.role],
}
for (const [name, values] of Object.entries(out))
    // A dump lists each store's records in key order, as IndexedDB returns them.
    store(name).records = values
        .map((value) => ({ key: keys[name](value), value }))
        .sort((a, b) => compareKeys(a.key, b.key))
writeFileSync(output, `${JSON.stringify(dump)}\n`)
console.log(
    `${output}: ${out.chains.length} chains, ${out.sessions.length} sessions, ${out.entries.length} entries`,
)
