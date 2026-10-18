import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import { i18n } from '../i18n'
import { settings } from '../settings'
import {
    bgmOffsetText,
    bgmText,
    groupEditText,
    initialLifeText,
    stageEditText,
    type BgmParts,
} from './headerLabelText'

// Live History labels (they follow the language) for edits with no chart position.

export const initialLifeLabel = (value: number) => () =>
    initialLifeText(i18n.value, settings.locale, value)

export const bgmOffsetLabel = (seconds: number) => () =>
    bgmOffsetText(i18n.value, settings.locale, seconds)

export const bgmLabel = (old: BgmParts, next: BgmParts) => () =>
    bgmText(i18n.value, settings.locale, old, next)

export const groupEditLabel =
    (old: GroupObject, key: keyof GroupObject, value: GroupObject[keyof GroupObject]) => () =>
        groupEditText(i18n.value, settings.locale, old, key, value)

export const stageEditLabel =
    (old: StageObject, key: keyof StageObject, value: StageObject[keyof StageObject]) => () =>
        stageEditText(i18n.value, old, key, value)
