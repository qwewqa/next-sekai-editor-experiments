import { easeFunctionOf, easeMode, easeTypeOf, type Ease } from '../../ease'
import { propertyField } from '../../editor/workspace/properties/fields'
import { languageTag, pluralForm } from '../../i18n/plural'
import { formatPropertyNumber } from '../../utils/formatPropertyNumber'
import type { FieldId, FieldValue, NameText, OwnerChange, OwnerReference } from '../operations'
import type { OperationStrings, OperationTextContext } from './types'

export const numberText = (value: number, context: OperationTextContext, shift = 0) =>
    formatPropertyNumber(value, languageTag(context.locale), shift)

export const message = (
    context: OperationTextContext,
    template: string,
    ...values: (string | number)[]
) =>
    pluralForm(context.locale, template, values[0]?.toString()).replace(
        /\{(\d+)\}/g,
        (placeholder, index: string) => {
            const value = values[Number(index)]
            return typeof value === 'number' ? numberText(value, context) : (value ?? placeholder)
        },
    )

export const nameText = (name: NameText) => `${name.text}${name.truncated ? '…' : ''}`

/** A name inside a sentence, quoted the way the locale quotes; an empty name is quoted empty. */
export const quoted = (text: string, context: OperationTextContext) =>
    message(context, context.strings.history.quoted, text)

/** A field label inside a sentence; some locales quote it so a trailing particle cannot double. */
export const quotedField = (label: string, context: OperationTextContext) =>
    message(context, context.strings.history.quotedField, label)

export const proseName = (name: NameText, context: OperationTextContext) =>
    quoted(nameText(name), context)

export const ownerName = (owner: OwnerReference, context: OperationTextContext, prose = true) =>
    prose ? proseName(owner.name, context) : nameText(owner.name)

export const operationFieldLabel = (
    field: FieldId,
    context: OperationTextContext,
    { prose = false }: { prose?: boolean } = {},
) => {
    const definition = propertyField.get(field)
    if (!definition) throw new Error(`Missing operation field label: ${field}`)
    const label = definition.qualifiedLabel?.(context.strings) ?? definition.label(context.strings)
    return prose ? quotedField(label, context) : label
}

export const ownerFieldLabel = (
    field: OwnerChange['field'],
    context: OperationTextContext,
    { prose = false }: { prose?: boolean } = {},
) => {
    const t = context.strings
    const label = {
        forceNoteSpeed: t.commands.manageGroups.modal.properties.modal.forceNoteSpeed,
        isFromStart: t.modals.form.isFromStart.label,
        isUntilEnd: t.modals.form.isUntilEnd.label,
        generateSimLines: t.modals.form.generateSimLines.label,
    }[field]
    return prose ? quotedField(label, context) : label
}

export const ownerValueText = (value: OwnerChange['after'], context: OperationTextContext) => {
    if (value === null) return context.strings.historyChanges.notSet
    if (typeof value === 'number') return numberText(value, context)
    if (typeof value === 'boolean') return booleanText(value, context)
    return context.strings.modals.form.generateSimLines[value]
}

export const booleanText = (value: boolean, context: OperationTextContext) =>
    context.strings.modals.form.toggle[value ? 'enabled' : 'disabled']

const easeText = (t: OperationStrings, value: Ease) => {
    const mode = easeMode(value)
    const name = easeFunctionOf(value)
    return mode && name
        ? `${t.modals.form.ease[name]} ${t.modals.form.ease[mode]}`
        : t.modals.form.ease[easeTypeOf(value)]
}

type EnumField = {
    [F in FieldId]: FieldValue<F> extends string ? F : never
}[FieldId]
const enumText: { [F in EnumField]: (t: OperationStrings, value: FieldValue<F>) => string } = {
    timeScaleEase: easeText,
    eventEase: easeText,
    connectorEase: easeText,
    timeScaleTransition: (t, value) => t.modals.form.timeScaleTransition[value],
    cameraZoomVerticalAlign: (t, value) => t.modals.form.cameraZoomVerticalAlign[value],
    divisionParity: (t, value) => t.modals.form.divisionParity[value],
    judgmentLineColor: (t, value) => t.modals.form.colors[value],
    judgmentLineStyle: (t, value) => t.modals.form.judgmentLineStyle[value],
    leftBorderStyle: (t, value) => t.modals.form.borderStyle[value],
    rightBorderStyle: (t, value) => t.modals.form.borderStyle[value],
    anchor: (t, value) => t.modals.form.anchor[value],
    noteType: (t, value) => t.modals.form.noteType[value],
    flickDirection: (t, value) => t.modals.form.flickDirection[value],
    noteStyle: (t, value) =>
        value === 'default' ? t.modals.form.noteStyle.default : t.modals.form.colors[value],
    connectorStyle: (t, value) =>
        value === 'default' ? t.modals.form.noteStyle.default : t.modals.form.colors[value],
    sfx: (t, value) => t.modals.form.sfx[value],
    connectorType: (t, value) => t.modals.form.connectorType[value],
    connectorLayer: (t, value) => t.modals.form.connectorLayer[value],
    connectorPresentation: (t, value) => t.modals.form.connectorPresentation[value],
}

export const operationValueText = (
    field: FieldId,
    value: FieldValue<FieldId>,
    context: OperationTextContext,
) => {
    if (typeof value === 'number') return numberText(value, context)
    if (typeof value === 'boolean') return booleanText(value, context)
    if (typeof value === 'object') return ownerName(value, context)
    const render = enumText[field as EnumField]
    return render(context.strings, value as never)
}

export const joinFields = (values: readonly string[], context: OperationTextContext) =>
    new Intl.ListFormat(languageTag(context.locale), { type: 'conjunction' }).format(values)

export const joinSentences = (values: readonly string[], context: OperationTextContext) =>
    values.reduce(
        (previous, value) =>
            previous
                ? message(context, context.strings.modals.form.sentenceJoin, previous, value)
                : value,
        '',
    )
