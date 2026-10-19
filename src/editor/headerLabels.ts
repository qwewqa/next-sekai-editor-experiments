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

export const groupEditOperation = (
    id: number,
    old: GroupObject,
    key: GroupEditKey,
    value: GroupObject[GroupEditKey],
) => createHistoryOperation(groupEditInput(id, old, key, value))

export const stageEditOperation = (
    id: number,
    old: StageObject,
    key: StageEditKey,
    value: StageObject[StageEditKey],
) => createHistoryOperation(stageEditInput(id, old, key, value))
