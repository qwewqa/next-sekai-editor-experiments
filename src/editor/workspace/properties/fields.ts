import { easeFunctionOf, easeMode, easeTypeOf, mergeEases, type Ease } from '../../../ease'
import type { i18n } from '../../../i18n'
import type { EntityType } from '../../../state/entities'
import type { EditableObject } from '../../../state/operations/editable'
import type { NoteFields } from '../../../state/operations/properties/noteFields'
import { withoutUnit } from '../../../utils/unitLabel'
import type { BrushProperties } from '../../tools/brush'
import type { Aggregate } from '../../utils/aggregate'

type Localization = (typeof i18n)['value']

export type PropertyKey = keyof EditableObject

/** Where a field sits in the Selection section. */
export type PropertySection = 'position' | 'values' | 'connector' | 'organization' | 'advanced'

/** The group the brush lists a property under. */
export type BrushGroup =
    | 'general'
    | 'note'
    | 'connector'
    | 'timeScale'
    | 'camera'
    | 'mask'
    | 'pivot'
    | 'style'
    | 'transform'
    | 'event'

export const brushGroups: readonly BrushGroup[] = [
    'general',
    'note',
    'connector',
    'timeScale',
    'camera',
    'mask',
    'pivot',
    'style',
    'transform',
    'event',
]

/** Groups that only exist with dynamic stages. */
const stageGroups: ReadonlySet<BrushGroup> = new Set([
    'camera',
    'mask',
    'pivot',
    'style',
    'transform',
    'event',
])

export type SelectionContext = {
    /** How many objects of each kind the fields are for. */
    counts: Partial<Record<EntityType, number>>
    noteFields: Partial<NoteFields>
    isDynamicStages: boolean
}

export type PropertyField = {
    key: PropertyKey
    section: PropertySection
    label: (t: Localization) => string
    /** The label where the panel's context is missing, as in History and Brush's Remove. */
    qualifiedLabel?: (t: Localization) => string
    /** Shown in Selection for this selection. */
    show: (context: SelectionContext) => boolean
    /** Value labels for the collapsed connector summary and enum toggles. */
    valueLabel?: (t: Localization, value: never) => string
    ease?: boolean
    /** Only exists with dynamic stages. */
    dynamicStages?: boolean
    /**
     * In a selection of several kinds: `only` shows the field once in General when two or more
     * kinds' blocks show it and the whole selection allows it (Beat: at most one BPM change and
     * one time scale), otherwise in each block that shows it; `also` shows it in each kind's
     * block and once more in General when two or more blocks show it.
     */
    general?: 'only' | 'also'
    /** Brushable properties: the group the brush lists them under, and the value an added row starts from. */
    brush?: { group: BrushGroup; initial: unknown }
}

const note =
    (key: keyof NoteFields) =>
    ({ counts, noteFields }: SelectionContext) =>
        !!counts.note && noteFields[key] !== false

const type =
    (...types: EntityType[]) =>
    (context: SelectionContext) =>
        types.some((type) => context.counts[type])

const eventJoints: EntityType[] = [
    'cameraEventJoint',
    'stageMaskEventJoint',
    'stagePivotEventJoint',
    'stageStyleEventJoint',
    'stageTransformEventJoint',
]

const easeLabel = (t: Localization, ease: Ease) => {
    const mode = easeMode(ease)
    const name = easeFunctionOf(ease)
    return mode && name
        ? `${t.modals.form.ease[name]} ${t.modals.form.ease[mode]}`
        : t.modals.form.ease[easeTypeOf(ease)]
}

const styleLabel = (t: Localization, style: string) =>
    style === 'default'
        ? t.modals.form.noteStyle.default
        : ((t.modals.form.colors as Record<string, string>)[style] ?? style)

const optionLabel =
    (get: (t: Localization) => Record<string, string>) => (t: Localization, value: string) =>
        get(t)[value] ?? value

const fields: PropertyField[] = [
    // Position: where the objects sit on the chart.
    {
        key: 'beat',
        section: 'position',
        label: (t) => t.modals.form.beat.label,
        // One typed beat never puts several BPM changes, or several time scales, on one beat.
        show: ({ counts }) => (counts.bpm ?? 0) <= 1 && (counts.timeScale ?? 0) <= 1,
        general: 'only',
    },
    {
        key: 'editorLane',
        section: 'position',
        label: (t) => t.modals.form.editorLane.label,
        show: type('timeScale', 'stageStyleEventJoint'),
        general: 'also',
    },
    {
        key: 'left',
        section: 'position',
        label: (t) => t.modals.form.left.label,
        show: note('left'),
    },
    {
        key: 'size',
        section: 'position',
        label: (t) => t.modals.form.size.label,
        show: note('size'),
        brush: { group: 'note', initial: 3 },
    },
    {
        key: 'cameraLeft',
        section: 'position',
        label: (t) => t.modals.form.cameraLeft.label,
        qualifiedLabel: (t) => t.modals.form.cameraLeft.qualified,
        show: type('cameraEventJoint'),
    },
    {
        key: 'cameraSize',
        section: 'position',
        label: (t) => t.modals.form.cameraSize.label,
        qualifiedLabel: (t) => t.modals.form.cameraSize.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 12 },
    },
    {
        key: 'maskLeft',
        section: 'position',
        label: (t) => t.modals.form.maskLeft.label,
        show: type('stageMaskEventJoint'),
    },
    {
        key: 'maskSize',
        section: 'position',
        label: (t) => t.modals.form.maskSize.label,
        show: type('stageMaskEventJoint'),
        brush: { group: 'mask', initial: 12 },
    },
    {
        key: 'pivotLane',
        section: 'position',
        label: (t) => t.modals.form.pivotLane.label,
        show: type('stagePivotEventJoint'),
    },
    {
        key: 'xTranslation',
        section: 'position',
        label: (t) => t.modals.form.xTranslation.label,
        show: type('stageTransformEventJoint'),
    },
    {
        key: 'yTranslation',
        section: 'position',
        label: (t) => t.modals.form.yTranslation.label,
        show: type('stageTransformEventJoint'),
        brush: { group: 'transform', initial: 0 },
    },

    // Values specific to each object type.
    {
        key: 'bpm',
        section: 'values',
        label: (t) => t.modals.form.bpm.label,
        show: type('bpm'),
    },
    {
        key: 'meter',
        section: 'values',
        label: (t) => t.modals.form.meter.label,
        show: type('bpm'),
    },
    {
        key: 'timeScale',
        section: 'values',
        label: (t) => t.modals.form.timeScale.label,
        show: type('timeScale'),
        brush: { group: 'timeScale', initial: 1 },
    },
    {
        key: 'skip',
        section: 'values',
        label: (t) => t.modals.form.skip.label,
        show: type('timeScale'),
        brush: { group: 'timeScale', initial: 0 },
    },
    {
        key: 'timeScaleEase',
        section: 'values',
        label: (t) => t.modals.form.timeScaleEase.label,
        qualifiedLabel: (t) => t.modals.form.timeScaleEase.qualified,
        show: type('timeScale'),
        valueLabel: easeLabel,
        ease: true,
        brush: { group: 'timeScale', initial: 'none' },
    },
    {
        key: 'timeScaleTransition',
        section: 'values',
        label: (t) => t.modals.form.timeScaleTransition.label,
        qualifiedLabel: (t) => t.modals.form.timeScaleTransition.qualified,
        show: type('timeScale'),
        valueLabel: optionLabel((t) => t.modals.form.timeScaleTransition),
        brush: { group: 'timeScale', initial: 'timeScale' },
    },
    {
        key: 'hideNotes',
        section: 'values',
        label: (t) => t.modals.form.hideNotes.label,
        show: type('timeScale'),
        brush: { group: 'timeScale', initial: false },
    },
    {
        key: 'cameraZoom',
        section: 'values',
        label: (t) => t.modals.form.cameraZoom.label,
        qualifiedLabel: (t) => t.modals.form.cameraZoom.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 1 },
    },
    {
        key: 'cameraZoomTargetLane',
        section: 'values',
        label: (t) => t.modals.form.cameraZoomTargetLane.label,
        qualifiedLabel: (t) => t.modals.form.cameraZoomTargetLane.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 0 },
    },
    {
        key: 'cameraZoomTargetY',
        section: 'values',
        label: (t) => t.modals.form.cameraZoomTargetY.label,
        qualifiedLabel: (t) => t.modals.form.cameraZoomTargetY.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 0 },
    },
    {
        key: 'cameraZoomVerticalAlign',
        section: 'values',
        label: (t) => t.modals.form.cameraZoomVerticalAlign.label,
        qualifiedLabel: (t) => t.modals.form.cameraZoomVerticalAlign.qualified,
        show: type('cameraEventJoint'),
        valueLabel: optionLabel((t) => t.modals.form.cameraZoomVerticalAlign),
        brush: { group: 'camera', initial: 'default' },
    },
    {
        key: 'cameraRotation',
        section: 'values',
        label: (t) => t.modals.form.cameraRotation.label,
        qualifiedLabel: (t) => t.modals.form.cameraRotation.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 0 },
    },
    {
        key: 'cameraStageTilt',
        section: 'values',
        label: (t) => t.modals.form.cameraStageTilt.label,
        qualifiedLabel: (t) => t.modals.form.cameraStageTilt.qualified,
        show: type('cameraEventJoint'),
        brush: { group: 'camera', initial: 1 },
    },
    {
        key: 'isMaskNotes',
        section: 'values',
        label: (t) => t.modals.form.isMaskNotes.label,
        show: type('stageMaskEventJoint'),
        brush: { group: 'mask', initial: false },
    },
    {
        key: 'divisionSize',
        section: 'values',
        label: (t) => t.modals.form.divisionSize.label,
        show: type('stagePivotEventJoint'),
        brush: { group: 'pivot', initial: 2 },
    },
    {
        key: 'divisionParity',
        section: 'values',
        label: (t) => t.modals.form.divisionParity.label,
        show: type('stagePivotEventJoint'),
        valueLabel: optionLabel((t) => t.modals.form.divisionParity),
        brush: { group: 'pivot', initial: 'even' },
    },
    {
        key: 'yOffset',
        section: 'values',
        label: (t) => t.modals.form.yOffset.label,
        show: type('stagePivotEventJoint'),
        brush: { group: 'pivot', initial: 0 },
    },
    {
        key: 'yOffsetBeat',
        section: 'values',
        label: (t) => t.modals.form.yOffsetBeat.label,
        show: type('stagePivotEventJoint'),
        brush: { group: 'pivot', initial: 0 },
    },
    {
        key: 'laneColor',
        section: 'values',
        label: (t) => t.modals.form.laneColor.label,
        show: type('stageStyleEventJoint'),
        valueLabel: styleLabel,
        brush: { group: 'style', initial: 'default' },
    },
    {
        key: 'judgmentLineColor',
        section: 'values',
        label: (t) => t.modals.form.judgmentLineColor.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 'purple' },
    },
    {
        key: 'judgmentLineStyle',
        section: 'values',
        label: (t) => t.modals.form.judgmentLineStyle.label,
        show: type('stageStyleEventJoint'),
        valueLabel: optionLabel((t) => t.modals.form.judgmentLineStyle),
        brush: { group: 'style', initial: 'default' },
    },
    {
        key: 'leftBorderStyle',
        section: 'values',
        label: (t) => t.modals.form.leftBorderStyle.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 'default' },
    },
    {
        key: 'rightBorderStyle',
        section: 'values',
        label: (t) => t.modals.form.rightBorderStyle.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 'default' },
    },
    {
        key: 'isFullWidth',
        section: 'values',
        label: (t) => t.modals.form.isFullWidth.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: false },
    },
    {
        key: 'noteAlpha',
        section: 'values',
        label: (t) => t.modals.form.noteAlpha.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 1 },
    },
    {
        key: 'laneAlpha',
        section: 'values',
        label: (t) => t.modals.form.laneAlpha.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 1 },
    },
    {
        key: 'judgmentLineAlpha',
        section: 'values',
        label: (t) => t.modals.form.judgmentLineAlpha.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 1 },
    },
    {
        key: 'divisionLineAlpha',
        section: 'values',
        label: (t) => t.modals.form.divisionLineAlpha.label,
        show: type('stageStyleEventJoint'),
        brush: { group: 'style', initial: 1 },
    },
    {
        key: 'rotation',
        section: 'values',
        label: (t) => t.modals.form.rotation.label,
        show: type('stageTransformEventJoint'),
        brush: { group: 'transform', initial: 0 },
    },
    {
        key: 'rotationCenter',
        section: 'values',
        label: (t) => t.modals.form.rotationCenter.label,
        show: type('stageTransformEventJoint'),
        valueLabel: optionLabel((t) => t.modals.form.rotationCenter),
        brush: { group: 'transform', initial: 'stage' },
    },
    {
        key: 'centerXOffset',
        section: 'values',
        label: (t) => t.modals.form.centerXOffset.label,
        qualifiedLabel: (t) => t.modals.form.centerXOffset.qualified,
        show: type('stageTransformEventJoint'),
        brush: { group: 'transform', initial: 0 },
    },
    {
        key: 'centerYOffset',
        section: 'values',
        label: (t) => t.modals.form.centerYOffset.label,
        qualifiedLabel: (t) => t.modals.form.centerYOffset.qualified,
        show: type('stageTransformEventJoint'),
        brush: { group: 'transform', initial: 0 },
    },
    {
        key: 'anchor',
        section: 'values',
        label: (t) => t.modals.form.anchor.label,
        show: type('stageTransformEventJoint'),
        valueLabel: optionLabel((t) => t.modals.form.anchor),
        brush: { group: 'transform', initial: 'default' },
    },
    {
        key: 'eventEase',
        section: 'values',
        label: (t) => t.modals.form.eventEase.label,
        qualifiedLabel: (t) => t.modals.form.eventEase.qualified,
        show: type(...eventJoints),
        valueLabel: easeLabel,
        ease: true,
        general: 'also',
        brush: { group: 'event', initial: 'linear' },
    },
    {
        key: 'noteType',
        section: 'values',
        label: (t) => t.modals.form.noteType.label,
        show: type('note'),
        brush: { group: 'note', initial: 'default' },
    },
    {
        key: 'isCritical',
        section: 'values',
        label: (t) => t.modals.form.isCritical.label,
        show: note('isCritical'),
        brush: { group: 'note', initial: false },
    },
    {
        key: 'flickDirection',
        section: 'values',
        label: (t) => t.modals.form.flickDirection.label,
        show: note('flickDirection'),
        brush: { group: 'note', initial: 'none' },
    },
    {
        key: 'isAttached',
        section: 'values',
        label: (t) => t.modals.form.isAttached.label,
        show: note('isAttached'),
        brush: { group: 'note', initial: false },
    },
    {
        key: 'noteStyle',
        section: 'values',
        label: (t) => t.modals.form.noteStyle.label,
        show: note('noteStyle'),
        brush: { group: 'note', initial: 'default' },
    },
    {
        key: 'isFake',
        section: 'values',
        label: (t) => t.modals.form.isFake.label,
        show: note('isFake'),
        brush: { group: 'note', initial: false },
    },
    {
        key: 'sfx',
        section: 'values',
        label: (t) => t.modals.form.sfx.label,
        show: note('sfx'),
        brush: { group: 'note', initial: 'default' },
    },

    // The connector leaving each note.
    {
        key: 'isConnectorSeparator',
        section: 'connector',
        label: (t) => t.modals.form.isConnectorSeparator.label,
        qualifiedLabel: (t) => t.modals.form.isConnectorSeparator.qualified,
        show: note('isConnectorSeparator'),
        brush: { group: 'connector', initial: false },
    },
    {
        key: 'connectorType',
        section: 'connector',
        label: (t) => t.modals.form.connectorType.label,
        qualifiedLabel: (t) => t.modals.form.connectorType.qualified,
        show: note('connectorType'),
        valueLabel: optionLabel((t) => t.modals.form.connectorType),
        brush: { group: 'connector', initial: 'active' },
    },
    {
        key: 'connectorStyle',
        section: 'connector',
        label: (t) => t.modals.form.connectorStyle.label,
        qualifiedLabel: (t) => t.modals.form.connectorStyle.qualified,
        show: note('connectorStyle'),
        valueLabel: styleLabel,
        brush: { group: 'connector', initial: 'default' },
    },
    {
        key: 'connectorEase',
        section: 'connector',
        label: (t) => t.modals.form.connectorEase.label,
        qualifiedLabel: (t) => t.modals.form.connectorEase.qualified,
        show: note('connectorEase'),
        valueLabel: easeLabel,
        ease: true,
        brush: { group: 'connector', initial: 'linear' },
    },
    {
        key: 'connectorIsFake',
        section: 'connector',
        label: (t) => t.modals.form.connectorIsFake.label,
        show: note('connectorIsFake'),
        brush: { group: 'connector', initial: false },
    },
    {
        key: 'connectorActiveIsCritical',
        section: 'connector',
        label: (t) => t.modals.form.connectorActiveIsCritical.label,
        show: note('connectorActiveIsCritical'),
        brush: { group: 'connector', initial: false },
    },
    {
        key: 'connectorGuideAlpha',
        section: 'connector',
        label: (t) => t.modals.form.connectorGuideAlpha.label,
        show: note('connectorGuideAlpha'),
        brush: { group: 'connector', initial: 1 },
    },
    {
        key: 'connectorLayer',
        section: 'connector',
        label: (t) => t.modals.form.connectorLayer.label,
        qualifiedLabel: (t) => t.modals.form.connectorLayer.qualified,
        show: note('connectorLayer'),
        valueLabel: optionLabel((t) => t.modals.form.connectorLayer),
        brush: { group: 'connector', initial: 'top' },
    },
    {
        key: 'connectorIsPassThrough',
        section: 'connector',
        label: (t) => t.modals.form.connectorIsPassThrough.label,
        qualifiedLabel: (t) => t.modals.form.connectorIsPassThrough.qualified,
        show: note('connectorIsPassThrough'),
        brush: { group: 'connector', initial: false },
    },
    {
        key: 'connectorPresentation',
        section: 'connector',
        label: (t) => t.modals.form.connectorPresentation.label,
        qualifiedLabel: (t) => t.modals.form.connectorPresentation.qualified,
        show: note('connectorPresentation'),
        valueLabel: optionLabel((t) => t.modals.form.connectorPresentation),
        brush: { group: 'connector', initial: 'default' },
    },

    // Organization: which group and stage own the objects.
    {
        key: 'groupId',
        section: 'organization',
        label: (t) => t.modals.form.group.label,
        show: type('timeScale', 'note'),
        general: 'only',
        // The current group, filled in when added.
        brush: { group: 'general', initial: undefined },
    },
    {
        key: 'stageId',
        section: 'organization',
        dynamicStages: true,
        label: (t) => t.modals.form.stage.label,
        show: (context) =>
            context.isDynamicStages &&
            type(
                'note',
                'stageMaskEventJoint',
                'stagePivotEventJoint',
                'stageStyleEventJoint',
                'stageTransformEventJoint',
            )(context),
        general: 'only',
        brush: { group: 'general', initial: undefined },
    },

    // Elevation, kept last as an advanced placement value. A note's adds to its stage's, so
    // notes and stage transform events each edit their own.
    {
        key: 'elevation',
        section: 'advanced',
        label: (t) => t.modals.form.elevation.label,
        show: (context) => !!context.counts.stageTransformEventJoint || note('elevation')(context),
        brush: { group: 'note', initial: 0 },
    },
]

export const propertyFields: readonly PropertyField[] = fields

/**
 * A field's name; qualified, as in a notice or Brush's Remove, without its unit,
 * unless only the unit tells it from another field, as Y Offset (beats).
 */
export const fieldLabel = (
    field: Pick<PropertyField, 'label' | 'qualifiedLabel'> & { key: string },
    t: Localization,
    qualified: boolean,
) => {
    const label = field.label(t)
    if (!qualified) return label
    const named = field.qualifiedLabel?.(t)
    if (named !== undefined) return named
    const short = withoutUnit(label)
    const taken = fields.some(
        (other) =>
            other.key !== field.key &&
            [other.label(t), withoutUnit(other.label(t))].includes(short),
    )
    return taken ? label : short
}

export const propertyField = new Map(fields.map((field) => [field.key, field]))

export const propertySections: readonly PropertySection[] = [
    'position',
    'values',
    'connector',
    'organization',
    'advanced',
]

type Sections = Record<PropertySection, PropertyField[]>

/** Fields of a selection's block: one kind's, or the General ones the kinds share. */
export type FieldBlock = { kind?: EntityType; sections: Sections }

const emptySections = () =>
    Object.fromEntries(propertySections.map((section) => [section, []])) as unknown as Sections

/** Groups the fields a selection shows: with several kinds, General first, then each kind's. */
export const layoutFields = (
    kinds: readonly EntityType[],
    kindContext: (kind: EntityType) => SelectionContext,
    context: SelectionContext,
): FieldBlock[] => {
    if (kinds.length < 2) {
        const sections = emptySections()
        for (const field of fields) if (field.show(context)) sections[field.section].push(field)
        return [{ kind: kinds[0], sections }]
    }
    const blocks: FieldBlock[] = kinds.map((kind) => ({ kind, sections: emptySections() }))
    const general = emptySections()
    for (const field of fields) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const owners = blocks.filter((block) => field.show(kindContext(block.kind!)))
        if (field.general === 'only' && owners.length > 1 && field.show(context)) {
            general[field.section].push(field)
            continue
        }
        for (const block of owners) block.sections[field.section].push(field)
        if (owners.length > 1 && field.general === 'also') general[field.section].push(field)
    }
    return propertySections.some((section) => general[section].length)
        ? [{ sections: general }, ...blocks]
        : blocks
}

export type BrushKey = keyof BrushProperties

/** A Brush row: its own key, and the chart property it writes. */
export type BrushField = Omit<PropertyField, 'key'> & {
    key: BrushKey
    property: PropertyKey
    /** The only kinds the row reads and writes; every kind with the property otherwise. */
    kinds?: readonly EntityType[]
    brush: NonNullable<PropertyField['brush']>
}

type Brushable = PropertyField & { brush: NonNullable<PropertyField['brush']> }

const brushRow = (field: Brushable, row: Partial<BrushField> = {}): BrushField => ({
    ...field,
    key: field.key as BrushKey,
    property: field.key,
    ...row,
})

const brushable = fields.filter((field): field is Brushable => !!field.brush)

// Elevation has a row for notes and one for stage transform events, as Selection has.
export const brushFields: readonly BrushField[] = [
    ...brushable.map((field) =>
        brushRow(field, field.key === 'elevation' ? { kinds: ['note'] } : {}),
    ),
    ...brushable
        .filter((field) => field.key === 'elevation')
        .map((field) =>
            brushRow(field, {
                key: 'stageElevation',
                qualifiedLabel: (t) => t.modals.form.elevation.stage,
                kinds: ['stageTransformEventJoint'],
                brush: { group: 'transform', initial: 0 },
            }),
        ),
]

/** What the brush writes to an object: each row that reaches its kind, under the row's property. */
export const brushObjectOf = (
    properties: BrushProperties,
    entity: { type: EntityType },
): EditableObject => {
    const object: Record<string, unknown> = {}
    for (const field of brushFields) {
        const value = properties[field.key]
        if (value === undefined || (field.kinds && !field.kinds.includes(entity.type))) continue
        object[field.property] = value
    }
    return object
}

/** The connector values summarized while the connector fields are collapsed. */
export const connectorSummaryKeys: readonly PropertyKey[] = [
    'connectorType',
    'connectorStyle',
    'connectorEase',
    'connectorLayer',
]

/** Whether the brush may offer a field in this chart mode. */
export const isBrushAvailable = (field: BrushField, isDynamicStages: boolean) =>
    isDynamicStages || (!stageGroups.has(field.brush.group) && !field.dynamicStages)

/**
 * A brush matching the selection: every brushable value it agrees on. `aggregate` gives the
 * selection's values, or those of its objects of `kinds`, for a row that reaches only them.
 */
export const pickBrush = (
    aggregate: (kinds?: readonly EntityType[]) => Aggregate,
    isDynamicStages: boolean,
) => {
    const brush: Record<string, unknown> = {}
    for (const field of brushFields) {
        if (!isBrushAvailable(field, isDynamicStages)) continue
        const { model, usage } = aggregate(field.kinds)
        // Eases keep the half the selection agrees on.
        const value = field.ease
            ? mergeEases((usage.get(field.property)?.values.keys() ?? []) as Iterable<Ease>)
            : model[field.property]
        if (value !== undefined) brush[field.key] = value
    }
    return brush as BrushProperties
}
