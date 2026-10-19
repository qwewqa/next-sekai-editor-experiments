import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import { createHistoryOperation } from '../history/createHistoryOperation'
import {
    bgmInput,
    bgmOffsetInput,
    groupEditInput,
    initialLifeInput,
    stageEditInput,
    type BgmParts,
    type GroupEditKey,
    type StageEditKey,
} from './headerLabelText'

export const initialLifeOperation = (before: number, after: number) =>
    createHistoryOperation(initialLifeInput(before, after))

export const bgmOffsetOperation = (before: number, after: number) =>
    createHistoryOperation(bgmOffsetInput(before, after))

export const bgmOperation = (old: BgmParts, next: BgmParts) =>
    createHistoryOperation(bgmInput(old, next))

export const groupEditOperation = <K extends GroupEditKey>(
    id: number,
    old: GroupObject,
    key: K,
    value: GroupObject[K],
) => createHistoryOperation(groupEditInput(id, old, key, value))

export const stageEditOperation = <K extends StageEditKey>(
    id: number,
    old: StageObject,
    key: K,
    value: StageObject[K],
) => createHistoryOperation(stageEditInput(id, old, key, value))
