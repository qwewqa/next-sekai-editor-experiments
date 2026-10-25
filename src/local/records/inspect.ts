import fields from './fields-v1.json'
import type { SnapshotSource } from './snapshot'

// The debug viewer: records are positional, so this names their fields from
// `fields-v1.json`. The dev console, the golden README and record test failures print through it.

type FieldEntry = { name: string; type: string; optional?: boolean }
type Form = FieldEntry[] | { type: string }

const forms = fields as unknown as Record<string, Form | undefined>
const kindRecords = fields.kinds as Record<string, string | undefined>

const inspectType = (type: string, value: unknown): unknown => {
    if (type === 'mediaRefOrEmpty')
        return Array.isArray(value) && value.length === 0 ? [] : inspectRecord('mediaRef', value)
    const at = type.indexOf(':')
    const [kind, name] = at < 0 ? [type, ''] : [type.slice(0, at), type.slice(at + 1)]
    if (kind === 'record') return inspectRecord(name, value)
    if (kind === 'array' && Array.isArray(value))
        return value.map((item: unknown) => (forms[name] ? inspectRecord(name, item) : item))
    return value
}

/**
 * A record as an object with field names. Positions past the form's fields come out as
 * `$<index>`, so a record that breaks the schema still prints.
 */
export const inspectRecord = (name: string, value: unknown): unknown => {
    const form = forms[name]
    if (!form || !Array.isArray(value)) return value
    if (!Array.isArray(form)) return inspectType(form.type, value)
    const out: Record<string, unknown> = {}
    for (const [i, item] of (value as unknown[]).entries()) {
        const field = form[i]
        if (field) out[field.name] = inspectType(field.type, item)
        else out[`$${i}`] = item
    }
    return out
}

/** A body chunk of a kind, each record named. */
export const inspectChunk = (kind: string, chunk: unknown) => {
    const name = kindRecords[kind]
    return name && Array.isArray(chunk)
        ? chunk.map((record: unknown) => inspectRecord(name, record))
        : chunk
}

/** A whole snapshot from its root, with field names, reading as far as its parts are held. */
export const inspectSnapshot = (root: unknown, source: Partial<SnapshotSource>) => {
    const named = inspectRecord('root', root) as {
        header?: string
        kinds?: { name: string; hash: string }[]
    }
    const node = (kind: string, hash: string): unknown => {
        const value = source.node?.(hash)
        const inspected = inspectRecord('node', value) as { depth?: number; hashes?: string[] }
        if (!Array.isArray(inspected.hashes)) return { hash, node: value }
        return {
            hash,
            ...inspected,
            children: inspected.hashes.map((child) =>
                inspected.depth === 1
                    ? node(kind, child)
                    : { hash: child, records: inspectChunk(kind, source.chunk?.(child)) },
            ),
        }
    }
    return {
        root: named,
        header:
            typeof named.header === 'string'
                ? inspectRecord('header', source.chunk?.(named.header))
                : undefined,
        kinds: Array.isArray(named.kinds)
            ? named.kinds.map(({ name, hash }) => ({ name, node: node(name, hash) }))
            : undefined,
    }
}
