// The level parser's declared table. It lists every archetype and field the parser reads, every
// choice field's values and default, and the archetypes and fields the parser reads past on
// purpose. Run-time reads can't be the authority: a field read only when another is present would
// be reported as unconsumed. Each archetype, field and choice value is tagged with the
// levelVersion that added it (omitted means 1), so a pin test fails when one is added without a
// bump of `LEVEL_VERSION`.

/** The levelVersion that added an archetype, a field or a choice value. */
type Since = number

export type KnownChoice = {
    /** Every value this build reads, by the levelVersion that added it. */
    values: Readonly<Record<number, Since>>
    /** Numbers in these ranges are read too, for a field whose values are not a list. */
    ranges?: readonly { min: number; max: number; since: Since }[]
    /** The value an unknown one becomes: what a new object of this kind gets. */
    default: number
}

export type KnownField = {
    kind: 'value' | 'ref'
    since?: Since
    /** The parser refuses the entity without it. */
    required?: true
    /** The condition under which the parser reads it, when there is one. */
    readWhen?: string
    choice?: KnownChoice
    /** The parser reads it for display only, so the report lists it. */
    unconsumed?: true
}

export type KnownArchetype = {
    since?: Since
    /** The condition under which the parser reads this archetype at all. */
    readWhen?: string
    fields: Readonly<Record<string, KnownField>>
}

export type IgnoredReason =
    /** The editor writes it again on export, from what it did read. */
    | 'rewritten'
    /** It carries nothing the level needs. */
    | 'nothing'
    /** The editor doesn't support it and leaves it out, as it always has. */
    | 'dropped'

export type Ignored = { reason: IgnoredReason; note: string; since?: Since }

const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)

/** Every value added by levelVersion 1. */
const v1 = (...values: number[]): Readonly<Record<number, Since>> =>
    Object.fromEntries(values.map((value) => [value, 1]))

const value = (extra: Partial<KnownField> = {}): KnownField => ({ kind: 'value', ...extra })
const ref = (extra: Partial<KnownField> = {}): KnownField => ({ kind: 'ref', ...extra })
const required = { required: true } as const
const choice = (values: readonly number[], defaultValue: number, extra: Partial<KnownField> = {}) =>
    value({ ...extra, choice: { values: v1(...values), default: defaultValue } })

// Eases: None, Linear, then ten functions in four modes each (Back and Elastic are 30 to 37).
const easeValues = range(0, 41)
const timeScaleEaseValues = [...range(0, 29), ...range(38, 41)]

// Connector kinds: plain, fake and guide kinds, then the colored ones (family tens, color units).
const segmentKinds = [
    1,
    2,
    3,
    51,
    52,
    53,
    ...range(101, 108),
    ...[10, 20, 30, 60, 70, 80].flatMap((base) => range(base + 1, base + 8)),
]

// Note archetypes: Fake or not, Normal or Critical, plain, Head or Tail, then the kind.
const noteKinds = ['Tap', 'Flick', 'Trace', 'TraceFlick', 'Release']
export const noteArchetypeNames = ['', 'Fake'].flatMap((fake) => [
    ...['Normal', 'Critical'].flatMap((weight) => [
        ...['', 'Head', 'Tail'].flatMap((end) =>
            noteKinds.map((kind) => `${fake}${weight}${end}${kind}Note`),
        ),
        `${fake}${weight}TickNote`,
    ]),
    `${fake}DamageNote`,
    `${fake}AnchorNote`,
])

export const noteFields: Record<string, KnownField> = {
    '#TIMESCALE_GROUP': ref(required),
    stage: ref({
        readWhen: 'always; required with dynamic stages, refused without them when present',
    }),
    '#BEAT': value(required),
    lane: value(required),
    size: value(required),
    elevation: value(),
    style: choice(range(0, 8), 0),
    direction: choice(range(0, 5), 0, required),
    isAttached: value(required),
    isSeparator: value(),
    connectorEase: choice(easeValues, 1, required),
    segmentKind: choice(segmentKinds, 1, required),
    segmentAlpha: value(required),
    segmentLayer: choice(range(0, 3), 0),
    effectKind: choice(range(0, 10), 0),
    segmentThroughJudgeLine: value(),
    segmentPresentation: choice([0, 1], 0),
    next: ref({ readWhen: 'the note has a name' }),
}

const eventEase = choice(easeValues, 1, required)
const eventReadWhen = (first: string) =>
    `the entity is reached by ${first} and its next chain; others are never read`

export const knownArchetypes: Readonly<Record<string, KnownArchetype>> = {
    Initialization: {
        readWhen: 'it is the first entity',
        fields: {
            initialLife: value(),
            // Read by getLevelDataRevision, not through the four helpers.
            revision: value(),
            firstCamera: ref(),
        },
    },
    '#BPM_CHANGE': {
        fields: { '#BEAT': value(required), '#BPM': value(required), meter: value() },
    },
    '#TIMESCALE_GROUP': {
        fields: {
            editorName: ref(),
            editorFolder: ref(),
            // 0 is the group's own speed; any speed from 1 to 12 forces one.
            forceNoteSpeed: value({
                choice: { values: v1(0), ranges: [{ min: 1, max: 12, since: 1 }], default: 0 },
            }),
            first: ref(),
        },
    },
    '#TIMESCALE_CHANGE': {
        fields: {
            '#TIMESCALE_GROUP': ref(required),
            '#BEAT': value(required),
            editorLane: value(),
            '#TIMESCALE': value(required),
            '#TIMESCALE_SKIP': value(required),
            '#TIMESCALE_EASE': choice(timeScaleEaseValues, 0, required),
            transitionStyle: choice([0, 1], 0),
            hideNotes: value(),
            next: ref({ readWhen: 'the entity is in a group’s first chain' }),
        },
    },
    Stage: {
        fields: {
            editorName: ref(),
            editorFolder: ref(),
            fromStart: value(required),
            untilEnd: value(required),
            generateSimLines: choice([0, 1], 0),
            firstMaskChange: ref(),
            firstPivotChange: ref(),
            firstStyleChange: ref(),
            firstTransformChange: ref(),
        },
    },
    CameraChange: {
        readWhen: eventReadWhen('Initialization.firstCamera'),
        fields: {
            '#BEAT': value(required),
            lane: value(required),
            size: value(required),
            zoom: value(),
            zoomTargetLane: value(),
            zoomTargetY: value(),
            zoomVerticalAlign: choice([0, 1], 0),
            rotate: value(),
            stageTilt: value(),
            ease: eventEase,
            next: ref(),
        },
    },
    StageMaskChange: {
        readWhen: eventReadWhen('a Stage’s firstMaskChange'),
        fields: {
            '#BEAT': value(required),
            lane: value(required),
            size: value(required),
            maskNotes: value(),
            ease: eventEase,
            next: ref(),
        },
    },
    StagePivotChange: {
        readWhen: eventReadWhen('a Stage’s firstPivotChange'),
        fields: {
            '#BEAT': value(required),
            lane: value(required),
            divisionSize: value(required),
            divisionParity: choice([0, 1], 0, required),
            yOffset: value(required),
            yBeatOffset: value(required),
            ease: eventEase,
            next: ref(),
        },
    },
    StageStyleChange: {
        readWhen: eventReadWhen('a Stage’s firstStyleChange'),
        fields: {
            '#BEAT': value(required),
            editorLane: value(),
            laneColor: choice(range(0, 8), 0),
            // Purple, which a new style event gets.
            judgeLineColor: choice(range(0, 7), 5, required),
            judgeLineStyle: choice([0, 1], 0),
            leftBorderStyle: choice(range(0, 3), 0, required),
            rightBorderStyle: choice(range(0, 3), 0, required),
            fullWidth: value(),
            noteAlpha: value(),
            laneAlpha: value(required),
            judgeLineAlpha: value(required),
            divisionLineAlpha: value(),
            alpha: value(),
            ease: eventEase,
            next: ref(),
        },
    },
    StageTransformChange: {
        readWhen: eventReadWhen('a Stage’s firstTransformChange'),
        fields: {
            '#BEAT': value(required),
            rotate: value(required),
            xLaneTranslate: value(required),
            yLaneTranslate: value(required),
            elevation: value(),
            anchor: choice([0, 1], 0, required),
            ease: eventEase,
            next: ref(),
        },
    },
    // The folders are editor-only; the parser reads them only when they have a name.
    EditorGroupFolder: {
        readWhen: 'the entity has a name',
        fields: {
            editorName: ref(),
            editorIndex: value(),
            // Flattened to the top-level folder, which loses the nesting.
            editorFolder: ref({ unconsumed: true }),
        },
    },
    EditorStageFolder: {
        readWhen: 'the entity has a name',
        fields: {
            editorName: ref(),
            editorIndex: value(),
            // Flattened to the top-level folder, which loses the nesting.
            editorFolder: ref({ unconsumed: true }),
        },
    },
    ...Object.fromEntries(noteArchetypeNames.map((name) => [name, { fields: noteFields }])),
}

const rewritten = (note: string): Ignored => ({ reason: 'rewritten', note })

const derivedNoteFields =
    'Derived from the note chain and connector kinds; written again on export.'

/** Archetypes the parser skips whole. */
export const ignoredArchetypes: Readonly<Record<string, Ignored>> = {
    Connector: rewritten('Built again from the notes’ next chain and segment fields.'),
    SimLine: rewritten('Built again from note positions and each stage’s generateSimLines.'),
    TransientHiddenTickNote: rewritten('Hidden ticks are scheduled again from the connectors.'),
    TransientHiddenDamageTickNote: rewritten(
        'Hidden damage ticks are scheduled again from the connectors.',
    ),
    Skill: { reason: 'dropped', note: 'Skill timing; not supported, left out as before.' },
    FeverChance: { reason: 'dropped', note: 'Fever timing; not supported, left out as before.' },
    FeverStart: { reason: 'dropped', note: 'Fever timing; not supported, left out as before.' },
}

const eventStage = rewritten(
    'The owning stage, which the Stage’s first change chain already gives; not written on export.',
)

/** Fields the parser skips on archetypes it otherwise reads. */
export const ignoredFields: Readonly<Record<string, Readonly<Record<string, Ignored>>>> = {
    '#TIMESCALE_GROUP': {
        editorHidden: {
            reason: 'nothing',
            note: 'Another editor’s display flag for the group; the level plays the same.',
        },
    },
    StageMaskChange: { stage: eventStage },
    StagePivotChange: { stage: eventStage },
    StageStyleChange: { stage: eventStage },
    StageTransformChange: { stage: eventStage },
    ...Object.fromEntries(
        noteArchetypeNames.map((name) => [
            name,
            {
                attachHead: rewritten(derivedNoteFields),
                attachTail: rewritten(derivedNoteFields),
                activeHead: rewritten(derivedNoteFields),
            },
        ]),
    ),
}

/** The archetype's declared fields, if the table has it. */
export const knownFieldsOf = (archetype: string) =>
    Object.hasOwn(knownArchetypes, archetype) ? knownArchetypes[archetype]?.fields : undefined

/** The declared choice of an archetype's field, if it is a choice field. */
export const knownChoiceOf = (archetype: string, name: string) => {
    const fields = knownFieldsOf(archetype)
    return fields && Object.hasOwn(fields, name) ? fields[name]?.choice : undefined
}

/** The highest levelVersion any archetype, field or choice value in the table carries. */
export const tableLevelVersion = () =>
    Math.max(
        1,
        ...Object.values(ignoredArchetypes).map(({ since }) => since ?? 1),
        ...Object.values(ignoredFields).flatMap((fields) =>
            Object.values(fields).map(({ since }) => since ?? 1),
        ),
        ...Object.values(knownArchetypes).flatMap((archetype) => [
            archetype.since ?? 1,
            ...Object.values(archetype.fields).flatMap((field) => [
                field.since ?? 1,
                ...Object.values(field.choice?.values ?? {}),
                ...(field.choice?.ranges ?? []).map(({ since }) => since),
            ]),
        ]),
    )
