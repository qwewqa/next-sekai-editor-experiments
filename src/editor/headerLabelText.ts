import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import {
    captureName,
    type LevelInfoChange,
    type NativeOperationInput,
    type OwnerChange,
} from '../history/operations'
import type { LevelInfo, MediaRef } from '../state/levelInfo'

export const initialLifeInput = (before: number, after: number) =>
    ({ id: 'nse.header.set', data: { field: 'initialLife', before, after } }) as const

export const bgmOffsetInput = (before: number, after: number) =>
    ({ id: 'nse.header.set', data: { field: 'bgmOffset', before, after } }) as const

export type BgmParts = { buffer?: unknown; filename?: string; offset: number }

export const bgmInput = (old: BgmParts, next: BgmParts): NativeOperationInput => {
    if (next.buffer === old.buffer && next.filename === old.filename)
        return bgmOffsetInput(old.offset, next.offset)
    return {
        id: 'nse.bgm.change',
        data: {
            file: {
                before: old.filename === undefined ? null : captureName(old.filename),
                after: next.filename === undefined ? null : captureName(next.filename),
            },
            ...(next.offset === old.offset
                ? {}
                : { offset: { before: old.offset, after: next.offset } }),
        },
    }
}

export type GroupEditKey = 'name' | 'forceNoteSpeed'
export const groupEditInput = <K extends GroupEditKey>(
    id: number,
    old: GroupObject,
    key: K,
    value: GroupObject[K],
): NativeOperationInput => {
    const target = { kind: 'group', id, name: captureName(old.name) } as const
    return key === 'name'
        ? {
              id: 'nse.owner.rename',
              data: { target, before: target.name, after: captureName(String(value)) },
          }
        : {
              id: 'nse.owner.set',
              data: {
                  target,
                  changes: [
                      {
                          field: key,
                          before: old.forceNoteSpeed ?? null,
                          after: (value as number | undefined) ?? null,
                      },
                  ],
              },
          }
}

export type StageEditKey = 'name' | 'isFromStart' | 'isUntilEnd' | 'generateSimLines'
export const stageEditInput = <K extends StageEditKey>(
    id: number,
    old: StageObject,
    key: K,
    value: StageObject[K],
): NativeOperationInput => {
    const target = { kind: 'stage', id, name: captureName(old.name) } as const
    if (key === 'name')
        return {
            id: 'nse.owner.rename',
            data: { target, before: target.name, after: captureName(String(value)) },
        }
    const change: OwnerChange =
        key === 'generateSimLines'
            ? {
                  field: 'generateSimLines',
                  before: old.generateSimLines,
                  after: value as StageObject['generateSimLines'],
              }
            : key === 'isFromStart'
              ? { field: 'isFromStart', before: old.isFromStart, after: value as boolean }
              : { field: 'isUntilEnd', before: old.isUntilEnd, after: value as boolean }
    return { id: 'nse.owner.set', data: { target, changes: [change] } }
}

const tally = (info: LevelInfo) => {
    const titles = new Map<string, number>()
    for (const { title } of info.tags) titles.set(title, (titles.get(title) ?? 0) + 1)
    return titles
}

const fileOf = (ref: MediaRef | undefined) => (ref ? captureName(ref.filename) : null)

/**
 * The step of one Level Info Apply (§1.4.12), or undefined when nothing changed, which pushes no
 * step. Each field that changed is one change, in field order, with the Initial Life the dialog
 * also holds (`life`). A step that changes only Initial Life is `nse.header.set`, so each id names
 * one result. Tags are compared by title: v1 edits titles only and keeps icons.
 */
export const levelInfoInput = (
    before: LevelInfo,
    after: LevelInfo,
    life?: { before: number; after: number },
): NativeOperationInput | undefined => {
    const changes: LevelInfoChange[] = []
    for (const field of ['title', 'artists', 'author', 'description'] as const)
        if (before[field] !== after[field])
            changes.push({
                field,
                before: captureName(before[field]),
                after: captureName(after[field]),
            })
    if (before.rating !== after.rating)
        changes.push({
            field: 'rating',
            before: before.rating ?? null,
            after: after.rating ?? null,
        })
    const had = tally(before)
    const has = tally(after)
    let added = 0
    let removed = 0
    for (const title of new Set([...had.keys(), ...has.keys()])) {
        const delta = (has.get(title) ?? 0) - (had.get(title) ?? 0)
        if (delta > 0) added += delta
        else removed -= delta
    }
    if (added || removed) changes.push({ field: 'tags', added, removed })
    for (const field of ['cover', 'preview'] as const)
        if (before[field]?.hash !== after[field]?.hash)
            changes.push({ field, before: fileOf(before[field]), after: fileOf(after[field]) })
    if (life && life.before !== life.after)
        changes.push({ field: 'initialLife', before: life.before, after: life.after })
    const [only] = changes
    if (!only) return
    if (changes.length === 1 && only.field === 'initialLife')
        return initialLifeInput(only.before, only.after)
    // The codec takes each field once, in field order.
    changes.sort((a, b) => (a.field < b.field ? -1 : 1))
    return { id: 'nse.levelInfo.set', data: { changes } }
}
