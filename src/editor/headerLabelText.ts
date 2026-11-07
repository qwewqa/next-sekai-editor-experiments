import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import {
    captureName,
    type LevelInfoChange,
    type NativeOperationInput,
    type OwnerChange,
} from '../history/operations'
import type { LevelInfo, LevelInfoTag, MediaRef } from '../state/levelInfo'

export const initialLifeInput = (before: number, after: number) =>
    ({ id: 'nse.header.set', data: { field: 'initialLife', before, after } }) as const

export const bgmOffsetInput = (before: number, after: number) =>
    ({ id: 'nse.header.set', data: { field: 'bgmOffset', before, after } }) as const

export type BgmParts = { buffer?: unknown; waveform?: unknown; filename?: string; offset: number }

export const bgmInput = (old: BgmParts, next: BgmParts): NativeOperationInput => {
    if (
        next.buffer === old.buffer &&
        next.waveform === old.waveform &&
        next.filename === old.filename
    )
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

const fileOf = (ref: MediaRef | undefined) => (ref ? captureName(ref.filename) : null)

/** A file field changed: other content, or the same content under another name. */
const fileChanged = (before: MediaRef | undefined, after: MediaRef | undefined) =>
    before?.hash !== after?.hash || before?.filename !== after?.filename

/**
 * What changed among the tags, or undefined. By title: those added and removed, and whether the
 * kept tags moved (`reordered`).
 */
const tagsChange = (before: readonly LevelInfoTag[], after: readonly LevelInfoTag[]) => {
    if (before.length === after.length && before.every((tag, i) => tag.title === after[i]?.title))
        return
    const take = (tags: readonly LevelInfoTag[], room: Map<string, number>) => {
        const kept: string[] = []
        for (const { title } of tags) {
            const left = room.get(title) ?? 0
            if (!left) continue
            room.set(title, left - 1)
            kept.push(title)
        }
        return kept
    }
    const count = (tags: readonly LevelInfoTag[]) => {
        const titles = new Map<string, number>()
        for (const { title } of tags) titles.set(title, (titles.get(title) ?? 0) + 1)
        return titles
    }
    const had = count(before)
    const has = count(after)
    const shared = new Map<string, number>()
    let added = 0
    let removed = 0
    for (const title of new Set([...had.keys(), ...has.keys()])) {
        const now = has.get(title) ?? 0
        const was = had.get(title) ?? 0
        shared.set(title, Math.min(now, was))
        if (now > was) added += now - was
        else removed += was - now
    }
    const kept = take(before, new Map(shared))
    const stays = take(after, new Map(shared))
    const reordered = kept.some((title, i) => title !== stays[i])
    return {
        field: 'tags',
        added,
        removed,
        ...(reordered ? { reordered: true as const } : {}),
    } as const
}

/**
 * The step of one Level Info Apply, or undefined when nothing changed, which pushes no
 * step. Each field that changed is one change, in the dialog's field order, with the Initial Life
 * the dialog also holds (`life`). A field whose before equals its after is skipped. A step that
 * changes only Initial Life is `nse.header.set`, so each id names one result. Anything that
 * changes the state is recorded: a tag's order, and a cover or preview of the same content under
 * another file name.
 */
export const levelInfoInput = (
    before: LevelInfo,
    after: LevelInfo,
    life?: { before: number; after: number },
): NativeOperationInput | undefined => {
    const changes: LevelInfoChange[] = []
    const text = (field: 'title' | 'artists' | 'author' | 'description') => {
        if (before[field] !== after[field])
            changes.push({
                field,
                before: captureName(before[field]),
                after: captureName(after[field]),
            })
    }
    text('title')
    text('artists')
    text('author')
    if (before.rating !== after.rating)
        changes.push({
            field: 'rating',
            before: before.rating ?? null,
            after: after.rating ?? null,
        })
    const tags = tagsChange(before.tags, after.tags)
    if (tags) changes.push(tags)
    text('description')
    for (const field of ['cover', 'preview'] as const)
        if (fileChanged(before[field], after[field]))
            changes.push({ field, before: fileOf(before[field]), after: fileOf(after[field]) })
    if (life && life.before !== life.after)
        changes.push({ field: 'initialLife', before: life.before, after: life.after })
    const [only] = changes
    if (!only) return
    if (changes.length === 1 && only.field === 'initialLife')
        return initialLifeInput(only.before, only.after)
    return { id: 'nse.levelInfo.set', data: { changes } }
}
