import type { GroupObject } from '../chart/groups'
import type { StageObject } from '../chart/stages'
import type en from '../i18n/en/index.json'
import { languageTag } from '../i18n/plural'
import { interpolateRaw } from '../utils/interpolate'

// The words of History labels for edits that change something with no chart position (§1.4.19).

type Messages = typeof en

const number = (locale: string, value: number) =>
    new Intl.NumberFormat(languageTag(locale), { maximumFractionDigits: 6 }).format(value)

/** "Set Initial Life to 1,000". */
export const initialLifeText = (m: Messages, locale: string, value: number) =>
    interpolateRaw(m.commands.properties.lifeSet, number(locale, value))

/** "Set BGM Offset to 0.15 s" (the offset is in seconds). */
export const bgmOffsetText = (m: Messages, locale: string, seconds: number) =>
    interpolateRaw(m.commands.bgm.offsetSet, number(locale, seconds))

export type BgmParts = { buffer?: unknown; filename?: unknown; offset: number }

/** What a BGM dialog change says: the file, the offset or, for both, just the BGM. */
export const bgmText = (m: Messages, locale: string, old: BgmParts, next: BgmParts) => {
    if (next.buffer === old.buffer && next.filename === old.filename)
        return bgmOffsetText(m, locale, next.offset)
    return next.offset === old.offset ? m.commands.bgm.fileChanged : m.commands.bgm.changed
}

/** A group's property edit: a rename, or one field named with its new value. */
export const groupEditText = (
    m: Messages,
    locale: string,
    old: GroupObject,
    key: keyof GroupObject,
    value: GroupObject[keyof GroupObject],
) => {
    if (key === 'name') return interpolateRaw(m.workspace.groups.renamed, old.name, String(value))

    const field = m.commands.manageGroups.modal.properties.modal.forceNoteSpeed
    return typeof value === 'number'
        ? interpolateRaw(m.workspace.groups.propertySet, old.name, field, number(locale, value))
        : interpolateRaw(m.workspace.groups.propertyCleared, old.name, field)
}

/** A stage's property edit: a rename, or one field named with its new value. */
export const stageEditText = (
    m: Messages,
    old: StageObject,
    key: keyof StageObject,
    value: StageObject[keyof StageObject],
) => {
    if (key === 'name') return interpolateRaw(m.workspace.stages.renamed, old.name, String(value))

    const form = m.modals.form
    const field =
        key === 'isFromStart'
            ? form.isFromStart.label
            : key === 'isUntilEnd'
              ? form.isUntilEnd.label
              : form.generateSimLines.label
    const shown =
        typeof value === 'boolean'
            ? value
                ? form.toggle.enabled
                : form.toggle.disabled
            : value === 'global'
              ? form.generateSimLines.global
              : form.generateSimLines.isolated
    return interpolateRaw(m.workspace.stages.propertySet, old.name, field, shown)
}
