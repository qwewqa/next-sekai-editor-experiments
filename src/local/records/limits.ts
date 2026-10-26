import { hasLimit, isWithinLimit } from '../../chart/limits'
import type { RecordValue } from './canonical'
import { kindRecords, records, type KindName, type RecordName } from './schema'

// The chart limits, applied where a body record is read: a record past them is damage, as the
// editor would refuse the chart on reopening, and building it could hang the grid.

type Rec = readonly RecordValue[]
type Limited = readonly (readonly [position: number, name: string])[]

const limitedOf = (name: RecordName): Limited => {
    const form = records[name]
    return Array.isArray(form)
        ? (form as readonly { name: string }[]).flatMap((field, position) =>
              hasLimit(field.name) ? [[position, field.name] as const] : [],
          )
        : []
}

const limited = Object.fromEntries(
    Object.entries(kindRecords).map(([kind, form]) => [
        kind,
        limitedOf(form === 'slide' ? 'note' : form),
    ]),
) as Record<KindName, Limited>

const fieldPast = (fields: Limited, record: Rec) => {
    for (const [position, name] of fields) {
        const value = record[position]
        if (typeof value === 'number' && !isWithinLimit(name, value)) return name
    }
}

/** The first field of a body record of the kind that is past its limit; a slide is its notes. */
export const recordPastLimit = (kind: KindName, record: Rec): string | undefined => {
    const fields = limited[kind]
    if (kind !== 'slides') return fieldPast(fields, record)
    for (const note of record as readonly Rec[]) {
        const name = fieldPast(fields, note)
        if (name) return name
    }
}
