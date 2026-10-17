import {
    ignoredArchetypes,
    ignoredFields,
    knownArchetypes,
    type KnownChoice,
    type KnownField,
} from '../../src/levelData/known'

/** A sorted list of numbers as ranges: `1-3,51`. */
const ranges = (values: number[]) => {
    const parts: string[] = []
    for (let i = 0; i < values.length; i++) {
        let end = i
        while (values[end + 1] === (values[end] ?? 0) + 1) end++
        parts.push(end > i ? `${values[i]}-${values[end]}` : String(values[i]))
        i = end
    }
    return parts.join(',')
}

const choiceLine = (choice: KnownChoice, version: number) => {
    const values = Object.entries(choice.values)
        .filter(([, since]) => since <= version)
        .map(([value]) => Number(value))
        .sort((a, b) => a - b)
    const extra = (choice.ranges ?? [])
        .filter(({ since }) => since <= version)
        .map(({ min, max }) => `${min}..${max}`)
    return `choice ${[ranges(values), ...extra].filter(Boolean).join(',')} default ${choice.default}`
}

const fieldLine = (name: string, field: KnownField, version: number) =>
    [
        name,
        field.kind,
        field.required ? 'required' : 'optional',
        ...(field.choice ? [choiceLine(field.choice, version)] : []),
        ...(field.unconsumed ? ['unconsumed'] : []),
    ].join(' ')

type Group = { names: string[]; fields: string[] }

/** Archetypes with the same lines share a group, so the 68 note archetypes are one. */
const grouped = (lines: Map<string, string[]>): Group[] => {
    const groups = new Map<string, Group>()
    for (const [name, fields] of lines) {
        const key = fields.join('\n')
        const group = groups.get(key) ?? { names: [], fields }
        group.names.push(name)
        groups.set(key, group)
    }
    return [...groups.values()]
}

/** The declared table as it stood at a levelVersion: what a pin test compares. */
export const tableAt = (version: number) => ({
    known: grouped(
        new Map(
            Object.entries(knownArchetypes)
                .filter(([, archetype]) => (archetype.since ?? 1) <= version)
                .map(([name, archetype]) => [
                    name,
                    Object.entries(archetype.fields)
                        .filter(([, field]) => (field.since ?? 1) <= version)
                        .map(([field, known]) => fieldLine(field, known, version)),
                ]),
        ),
    ),
    ignoredArchetypes: Object.entries(ignoredArchetypes)
        .filter(([, ignored]) => (ignored.since ?? 1) <= version)
        .map(([name]) => name),
    ignoredFields: grouped(
        new Map(
            Object.entries(ignoredFields)
                .map(([name, fields]): [string, string[]] => [
                    name,
                    Object.entries(fields)
                        .filter(([, ignored]) => (ignored.since ?? 1) <= version)
                        .map(([field]) => field),
                ])
                .filter(([, fields]) => fields.length),
        ),
    ),
})
