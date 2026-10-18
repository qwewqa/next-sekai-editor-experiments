import type { LevelDataEntity } from '@sonolus/core'
import { ImportRefusal } from '../chart/refusal'
import { ignoredArchetypes, ignoredFields, knownArchetypes } from './known'
import { LEVEL_VERSION } from './levelVersion'
import { getLevelDataRevision, LATEST_REVISION } from './revision'

/** Content this build does not read, found in level data. */
export type ReportEntry =
    /** An archetype neither read nor on the known-but-ignored list. */
    | { kind: 'archetype'; archetype: string; count: number }
    /** A field neither read nor on the known-but-ignored list, on an archetype that is read. */
    | { kind: 'field'; archetype: string; field: string; count: number }
    /** A value of a choice field that this build does not know; the field's default was used. */
    | { kind: 'value'; archetype: string; field: string; value: unknown; count: number }
    /** An engine revision newer than `LATEST_REVISION`. */
    | { kind: 'revision'; revision: number }

/** What the level parser did not consume, counted by what it was. */
export class LevelDataReport {
    private readonly byKey = new Map<string, ReportEntry>()

    get entries(): readonly ReportEntry[] {
        return [...this.byKey.values()]
    }

    get isEmpty() {
        return !this.byKey.size
    }

    get hasUnknownValue() {
        return this.entries.some(({ kind }) => kind === 'value')
    }

    addArchetype(archetype: string) {
        this.count(`archetype\0${archetype}`, { kind: 'archetype', archetype, count: 0 })
    }

    addField(archetype: string, field: string) {
        this.count(`field\0${archetype}\0${field}`, { kind: 'field', archetype, field, count: 0 })
    }

    addValue(archetype: string, field: string, value: unknown) {
        const key = `value\0${archetype}\0${field}\0${typeof value}\0${String(value)}`
        this.count(key, { kind: 'value', archetype, field, value, count: 0 })
    }

    addRevision(revision: number) {
        this.byKey.set('revision', { kind: 'revision', revision })
    }

    /** Refuses as the parser did before it reported: with the first unknown choice value. */
    refuseUnknownValues() {
        for (const entry of this.byKey.values())
            if (entry.kind === 'value') throw new ImportRefusal('unknownValue', entry.field)
    }

    private count(key: string, entry: Extract<ReportEntry, { count: number }>) {
        const found = this.byKey.get(key)
        if (found && 'count' in found) found.count++
        else this.byKey.set(key, { ...entry, count: 1 })
    }
}

// Field names per archetype that the parser reads or reads past on purpose, as of this build.
let allowed: Map<string, Set<string>> | undefined

/** Forgets the memoized field table; for tests that change the ignored tables. */
export const resetAllowedFieldsForTests = () => {
    allowed = undefined
}

const current = (since?: number) => (since ?? 1) <= LEVEL_VERSION

const allowedFields = () =>
    (allowed ??= new Map(
        Object.entries(knownArchetypes)
            .filter(([, archetype]) => current(archetype.since))
            .map(([archetype, { fields }]) => [
                archetype,
                new Set([
                    ...Object.entries(fields)
                        .filter(([, field]) => current(field.since) && !field.unconsumed)
                        .map(([name]) => name),
                    ...(Object.hasOwn(ignoredFields, archetype)
                        ? Object.entries(ignoredFields[archetype] ?? {})
                              .filter(([, ignored]) => current(ignored.since))
                              .map(([name]) => name)
                        : []),
                ]),
            ]),
    ))

/** Reports the unknown archetypes and fields, and a newer engine revision, against the declared table. */
export const reportLevelDataEntities = (
    entities: readonly LevelDataEntity[],
    report: LevelDataReport,
) => {
    const fieldsOf = allowedFields()
    for (const entity of entities) {
        const { archetype, data } = entity
        if (
            Object.hasOwn(ignoredArchetypes, archetype) &&
            current(ignoredArchetypes[archetype]?.since)
        )
            continue

        const fields = fieldsOf.get(archetype)
        if (!fields) {
            report.addArchetype(archetype)
            continue
        }

        for (const key of Object.keys(entity))
            if (!['name', 'archetype', 'data'].includes(key))
                report.addField(archetype, `entity.${key}`)

        const declared = knownArchetypes[archetype]?.fields ?? {}
        const seen = new Set<string>()
        for (const entry of data) {
            const { name } = entry
            if (!fields.has(name)) {
                report.addField(archetype, name)
                continue
            }
            // A field the parser reads from a ref or a value, but not the other kind, or twice.
            const kind = Object.hasOwn(declared, name) ? declared[name]?.kind : undefined
            if (kind && (seen.has(name) || !(kind in entry))) report.addField(archetype, name)
            if (kind && kind in entry)
                for (const key of Object.keys(entry))
                    if (key !== 'name' && key !== kind)
                        report.addField(archetype, `data.${name}.${key}`)
            seen.add(name)
        }
    }

    const revision = getLevelDataRevision(entities)
    if (revision > LATEST_REVISION) report.addRevision(revision)
}
