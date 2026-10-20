import type { FolderObject } from '../../chart/folders'
import type { GroupObject } from '../../chart/groups'
import type { StageObject } from '../../chart/stages'
import { canonical } from '../../local/records/canonical'
import { headerRecord } from '../../local/records/records'
import type { State } from '../../state'
import type { BgmMeta } from '../../state/bgm'
import type { LevelInfoTag } from '../../state/levelInfo'
import { getFilename } from '../../utils/file'

export type PropertySectionKind =
    | 'level'
    | 'bgm'
    | 'levelInfo'
    | 'cover'
    | 'preview'
    | 'groups'
    | 'stages'
    | 'groupFolders'
    | 'stageFolders'

export type PropertyField =
    | 'initialLife'
    | 'dynamicStages'
    | 'offset'
    | 'title'
    | 'artists'
    | 'author'
    | 'description'
    | 'tags'
    | 'rating'
    | 'filename'
    | 'size'
    | 'type'
    | 'duration'
    | 'contents'
    | 'name'
    | 'forceNoteSpeed'
    | 'fromStart'
    | 'untilEnd'
    | 'simLines'
    | 'folder'
    | 'order'

export type PropertyReference = {
    kind: 'reference'
    id: number
    name?: string
    folder?: { id: number; name?: string }
}

export type PropertyItem = PropertyReference | { kind: 'tag'; title: string; icon?: string }

/** Unformatted historical values; no decoded media or chart objects are retained here. */
export type PropertyValue =
    | { kind: 'notSet' | 'notPresent' | 'noFolder' | 'emptyName' }
    | { kind: 'text'; value: string }
    | { kind: 'number'; value: number; unit?: 'ms' | 'bytes'; decimalShift?: number }
    | { kind: 'boolean'; value: boolean }
    | { kind: 'simLines'; value: 'global' | 'isolated' }
    | PropertyReference
    | { kind: 'list'; items: readonly PropertyItem[] }

export type PropertyRow = { field: PropertyField; before: PropertyValue; after: PropertyValue }

export type PropertySection = {
    kind: PropertySectionKind
    id?: number
    beforeName?: PropertyReference
    afterName?: PropertyReference
    status?: 'added' | 'removed'
    rows: readonly PropertyRow[]
}

export type PropertyChanges = { sections: readonly PropertySection[]; rowCount: number }

const notSet: PropertyValue = { kind: 'notSet' }
const notPresent: PropertyValue = { kind: 'notPresent' }
const text = (value: string | undefined): PropertyValue =>
    value === undefined || value === '' ? notSet : { kind: 'text', value }
const number = (
    value: number | undefined,
    unit?: 'ms' | 'bytes',
    decimalShift?: number,
): PropertyValue =>
    value === undefined
        ? notSet
        : {
              kind: 'number',
              value,
              ...(unit ? { unit } : {}),
              ...(decimalShift ? { decimalShift } : {}),
          }
/** A name, which may be empty: an empty name is a name, drawn as one, and not Not set. */
const nameValue = (value: string): PropertyValue =>
    value === '' ? { kind: 'emptyName' } : { kind: 'text', value }
const boolean = (value: boolean): PropertyValue => ({ kind: 'boolean', value })
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

const header = (state: State) =>
    canonical(
        headerRecord(state, {
            bgmOffset: state.bgm.offset,
            levelInfo: state.levelInfo,
            ...(state.bgm.meta ? { bgm: state.bgm.meta } : {}),
        }),
    )

const reference = (
    id: number,
    entries: ReadonlyMap<number, { name: string; folderId?: number }>,
    folders?: ReadonlyMap<number, FolderObject>,
): PropertyReference => {
    const entry = entries.get(id)
    const folderId = entry?.folderId
    const folder = folderId === undefined ? undefined : folders?.get(folderId)
    return {
        kind: 'reference',
        id,
        ...(entry ? { name: entry.name } : {}),
        ...(folderId === undefined
            ? {}
            : { folder: { id: folderId, ...(folder ? { name: folder.name } : {}) } }),
    }
}

/** All current canonical header fields, in display order, compared without reading media bytes. */
export const comparePropertyChanges = (
    before: State,
    after: State,
    { expectedDifference = false }: { expectedDifference?: boolean } = {},
): PropertyChanges => {
    const differs = header(before) !== header(after)
    if (!differs) {
        if (expectedDifference) throw new Error('The compared property headers do not differ')
        return { sections: [], rowCount: 0 }
    }
    const sections: PropertySection[] = []
    const section = (
        kind: PropertySectionKind,
        rows: PropertyRow[],
        extra: Omit<PropertySection, 'kind' | 'rows'> = {},
    ) => {
        if (rows.length) sections.push({ kind, ...extra, rows })
    }
    const row = (rows: PropertyRow[], field: PropertyField, a: PropertyValue, b: PropertyValue) => {
        if (!equal(a, b)) rows.push({ field, before: a, after: b })
    }
    const level: PropertyRow[] = []
    row(level, 'initialLife', number(before.initialLife), number(after.initialLife))
    row(level, 'dynamicStages', boolean(before.isDynamicStages), boolean(after.isDynamicStages))
    section('level', level)
    const bgm: PropertyRow[] = []
    row(bgm, 'offset', number(before.bgm.offset, 'ms', 3), number(after.bgm.offset, 'ms', 3))

    // A file reads by its name without the extension, the one name Step Details gives it too: the
    // recorded operations hold names as picked, and the pick takes the extension off.
    const fileName = (ref: BgmMeta, fallback?: string) =>
        text(getFilename({ name: ref.filename }) || fallback)
    const media = (
        kind: 'bgm' | 'cover' | 'preview',
        a: BgmMeta | undefined,
        b: BgmMeta | undefined,
        rows: PropertyRow[] = [],
        names: readonly [string | undefined, string | undefined] = [undefined, undefined],
    ) => {
        const field = (
            key: 'filename' | 'size' | 'type' | 'duration',
            value: (ref: BgmMeta, fallback?: string) => PropertyValue,
        ) => {
            row(rows, key, a ? value(a, names[0]) : notPresent, b ? value(b, names[1]) : notPresent)
        }
        if (a || b) {
            field('filename', fileName)
            field('size', (ref) => number(ref.size, 'bytes'))
            field('type', (ref) => text(ref.type))
            if (kind === 'bgm') field('duration', (ref) => number(ref.durationMs, 'ms'))
            if (a && b && a.hash !== b.hash)
                rows.push({
                    field: 'contents',
                    before: fileName(a, names[0]),
                    after: fileName(b, names[1]),
                })
        }
        const status = !a && b ? 'added' : a && !b ? 'removed' : undefined
        // A row that has both sides (the BGM offset belongs to the level, not to the file) would
        // lose its before value under an Added or Removed badge. Then the section has no badge,
        // and the file's rows read Not set on the side with no file.
        const bothSides = rows.some(
            ({ before, after }) => before.kind !== 'notPresent' && after.kind !== 'notPresent',
        )
        const absent = (value: PropertyValue) => (value.kind === 'notPresent' ? notSet : value)
        section(
            kind,
            status && bothSides
                ? rows.map(({ field, before, after }) => ({
                      field,
                      before: absent(before),
                      after: absent(after),
                  }))
                : rows,
            status && !bothSides ? { status } : {},
        )
    }
    media('bgm', before.bgm.meta, after.bgm.meta, bgm, [before.bgm.filename, after.bgm.filename])
    const info: PropertyRow[] = []
    for (const key of ['title', 'artists', 'author', 'description'] as const)
        row(info, key, text(before.levelInfo[key]), text(after.levelInfo[key]))
    const tags = (items: readonly LevelInfoTag[]): PropertyValue =>
        items.length
            ? {
                  kind: 'list',
                  items: items.map(({ title, icon }) => ({
                      kind: 'tag',
                      title,
                      ...(icon === undefined ? {} : { icon }),
                  })),
              }
            : notSet
    row(info, 'tags', tags(before.levelInfo.tags), tags(after.levelInfo.tags))
    row(info, 'rating', number(before.levelInfo.rating), number(after.levelInfo.rating))
    section('levelInfo', info)
    media('cover', before.levelInfo.cover, after.levelInfo.cover)
    media('preview', before.levelInfo.preview, after.levelInfo.preview)

    type Named = GroupObject | StageObject | FolderObject
    const maps = (
        kind: 'groups' | 'stages' | 'groupFolders' | 'stageFolders',
        a: ReadonlyMap<number, Named>,
        b: ReadonlyMap<number, Named>,
        oldFolders: ReadonlyMap<number, FolderObject>,
        newFolders: ReadonlyMap<number, FolderObject>,
    ) => {
        const ref = (id: number, old: boolean) =>
            reference(id, old ? a : b, old ? oldFolders : newFolders)
        const folder = (id: number | undefined, old: boolean): PropertyValue =>
            id === undefined ? { kind: 'noFolder' } : reference(id, old ? oldFolders : newFolders)
        for (const id of new Set([...a.keys(), ...b.keys()])) {
            const old = a.get(id),
                next = b.get(id)
            const rows: PropertyRow[] = []
            const field = (
                key: PropertyField,
                get: (entry: Named, old: boolean) => PropertyValue,
            ) => {
                row(
                    rows,
                    key,
                    old ? get(old, true) : notPresent,
                    next ? get(next, false) : notPresent,
                )
            }
            field('name', (entry) => nameValue(entry.name))
            // An added or removed folder that sits in no folder has no Folder row to show: it would
            // only say that it is not in one.
            const placed =
                kind === 'groups' ||
                kind === 'stages' ||
                (old !== undefined && next !== undefined) ||
                (old ?? next)?.folderId !== undefined
            if (placed && (!old || !next || old.folderId !== next.folderId))
                field('folder', (entry, old) => folder(entry.folderId, old))
            if (kind === 'groups')
                // Storage holds an unset speed as 0 and reads 0 back as unset, so neither is a speed.
                field('forceNoteSpeed', (entry) => {
                    const speed = (entry as GroupObject).forceNoteSpeed
                    return speed ? number(speed) : notSet
                })
            else if (kind === 'stages') {
                field('fromStart', (entry) => boolean((entry as StageObject).isFromStart))
                field('untilEnd', (entry) => boolean((entry as StageObject).isUntilEnd))
                field('simLines', (entry) => ({
                    kind: 'simLines',
                    value: (entry as StageObject).generateSimLines,
                }))
            } else field('order', (entry) => number((entry as FolderObject).index))
            section(kind, rows, {
                id,
                ...(old ? { beforeName: ref(id, true) } : {}),
                ...(next ? { afterName: ref(id, false) } : {}),
                ...(!old ? { status: 'added' } : !next ? { status: 'removed' } : {}),
            })
        }
        const oldCommon = [...a.keys()].filter((id) => b.has(id))
        const newCommon = [...b.keys()].filter((id) => a.has(id))
        if (!equal(oldCommon, newCommon))
            section(kind, [
                {
                    field: 'order',
                    before: { kind: 'list', items: [...a.keys()].map((id) => ref(id, true)) },
                    after: { kind: 'list', items: [...b.keys()].map((id) => ref(id, false)) },
                },
            ])
    }
    maps('groups', before.groups, after.groups, before.groupFolders, after.groupFolders)
    maps('stages', before.stages, after.stages, before.stageFolders, after.stageFolders)
    maps(
        'groupFolders',
        before.groupFolders,
        after.groupFolders,
        before.groupFolders,
        after.groupFolders,
    )
    maps(
        'stageFolders',
        before.stageFolders,
        after.stageFolders,
        before.stageFolders,
        after.stageFolders,
    )
    const rowCount = sections.reduce((sum, value) => sum + value.rows.length, 0)
    if (!rowCount) throw new Error('The changed property header has no recognized fields')
    return { sections, rowCount }
}

export const PROPERTY_PAGE_SIZE = 100

export const propertySectionKey = (section: PropertySection) =>
    `${section.kind}:${section.id ?? 'all'}`
export const propertyRowKey = (section: PropertySection, row: PropertyRow) =>
    `${propertySectionKey(section)}:${row.field}`

/** Reveals only the requested rows; formatting belongs after this slice. */
export const propertyPage = (changes: PropertyChanges, limit = PROPERTY_PAGE_SIZE) => {
    let remaining = Math.max(0, Math.floor(limit))
    const sections: PropertySection[] = []
    for (const section of changes.sections) {
        if (!remaining) break
        const rows = section.rows.slice(0, remaining)
        sections.push({ ...section, rows })
        remaining -= rows.length
    }
    return {
        sections,
        shown: sections.reduce((sum, section) => sum + section.rows.length, 0),
        total: changes.rowCount,
    }
}

export const propertyItems = (
    value: Extract<PropertyValue, { kind: 'list' }>,
    limit = PROPERTY_PAGE_SIZE,
) => ({
    items: value.items.slice(0, Math.max(0, Math.floor(limit))),
    total: value.items.length,
})

export { formatPropertyNumber } from '../../utils/formatPropertyNumber'

/** A tag's icon, or Not set when it has none or an empty one. */
export const propertyTagIcon = (tag: Extract<PropertyItem, { kind: 'tag' }>) => text(tag.icon)
