import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import { captureName, type NativeOperationInput, type OwnerChange } from '../history/operations'

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
export const groupEditInput = (
    id: number,
    old: GroupObject,
    key: GroupEditKey,
    value: GroupObject[GroupEditKey],
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
                  changes: [{ field: key, before: old.forceNoteSpeed ?? null, after: (value as number | undefined) ?? null }],
              },
          }
}

export type StageEditKey = 'name' | 'isFromStart' | 'isUntilEnd' | 'generateSimLines'
export const stageEditInput = (
    id: number,
    old: StageObject,
    key: StageEditKey,
    value: StageObject[StageEditKey],
): NativeOperationInput => {
    const target = { kind: 'stage', id, name: captureName(old.name) } as const
    if (key === 'name')
        return {
            id: 'nse.owner.rename',
            data: { target, before: target.name, after: captureName(String(value)) },
        }
    const change: OwnerChange = key === 'generateSimLines'
        ? { field: key, before: old[key], after: value as StageObject['generateSimLines'] }
        : { field: key, before: old[key], after: value as boolean }
    return { id: 'nse.owner.set', data: { target, changes: [change] } }
}
