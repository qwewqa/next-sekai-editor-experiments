import { i18n } from '../../i18n'
import { languageTag } from '../../i18n/plural'
import { settings } from '../../settings'
import { interpolateRaw } from '../../utils/interpolate'
import {
    formatPropertyNumber,
    type PropertyField,
    type PropertyReference,
    type PropertySectionKind,
    type PropertyValue,
} from './propertyChanges'

export const propertySectionLabel = (kind: PropertySectionKind) => {
    const strings = i18n.value
    return {
        level: strings.commands.properties.title,
        bgm: strings.commands.bgm.title,
        levelInfo: strings.historyChanges.levelInfo,
        cover: strings.historyChanges.fields.cover,
        preview: strings.historyChanges.fields.previewAudio,
        groups: strings.commands.manageGroups.modal.properties.modal.title,
        stages: strings.commands.manageStages.modal.properties.modal.title,
        groupFolders: strings.historyChanges.groupFolder,
        stageFolders: strings.historyChanges.stageFolder,
    }[kind]
}

export const propertyFieldLabel = (field: PropertyField) => {
    const strings = i18n.value
    return {
        ...strings.historyChanges.fields,
        initialLife: strings.commands.properties.modal.life,
        dynamicStages: strings.history.dynamicStages.title,
        offset: strings.commands.bgm.modal.offset,
        filename: strings.commands.bgm.modal.file,
        forceNoteSpeed: strings.commands.manageGroups.modal.properties.modal.forceNoteSpeed,
        name: strings.modals.form.name.label,
        fromStart: strings.modals.form.isFromStart.label,
        untilEnd: strings.modals.form.isUntilEnd.label,
        simLines: strings.modals.form.generateSimLines.label,
        folder: strings.historyChanges.folder,
        order: strings.historyChanges.order,
        contents: strings.historyChanges.contentsChanged,
    }[field]
}

export const propertyCount = (value: number) =>
    new Intl.NumberFormat(languageTag(settings.locale)).format(value)

/** An empty name, quoted empty as it is in prose. */
const emptyName = () => interpolateRaw(i18n.value.history.quoted, '')

export const propertyReferenceText = (value: PropertyReference) => {
    const strings = i18n.value
    // A name is the user's own: never an id, never Not set (which says no name was given).
    const name = (entry: { name?: string }) =>
        entry.name === undefined ? strings.historyChanges.notPresent : entry.name || emptyName()
    return value.folder
        ? interpolateRaw(strings.workspace.folders.path, name(value.folder), name(value))
        : name(value)
}

export const propertyValueText = (
    value: Exclude<PropertyValue, { kind: 'list' }>,
    field?: PropertyField,
): string => {
    const strings = i18n.value
    switch (value.kind) {
        case 'notSet':
            return strings.historyChanges.notSet
        case 'notPresent':
            return strings.historyChanges.notPresent
        case 'noFolder':
            return strings.workspace.folders.none
        case 'emptyName':
            return emptyName()
        case 'text':
            return value.value
        case 'reference':
            return propertyReferenceText(value)
        case 'boolean':
            return value.value
                ? strings.modals.form.toggle.enabled
                : strings.modals.form.toggle.disabled
        case 'simLines':
            return strings.modals.form.generateSimLines[value.value]
        case 'number': {
            const locale = languageTag(settings.locale)
            const exact = formatPropertyNumber(value.value, locale, value.decimalShift ?? 0)
            if (!value.unit || field === 'offset') return exact
            let inserted = false
            return new Intl.NumberFormat(locale, {
                style: 'unit',
                unit: value.unit === 'bytes' ? 'byte' : 'millisecond',
                unitDisplay: 'short',
            })
                .formatToParts(value.value)
                .map((part) => {
                    if (part.type === 'unit' || part.type === 'literal') return part.value
                    if (inserted) return ''
                    inserted = true
                    return exact
                })
                .join('')
        }
    }
}
