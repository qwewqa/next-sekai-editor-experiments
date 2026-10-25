import Type from 'typebox'
import { noteStyleSchema } from '../chart/noteStyle'
import { easeEdits, type EaseEdit } from '../ease'

// One object rather than an intersection: typebox rebuilds an intersection's merged type on
// every decode, which took about 20 ms per preset list at each start.
export const defaultNoteSlidePropertiesSchema = Type.Object({
    ...Type.Partial(
        Type.Object({
            elevation: Type.Number(),
            noteStyle: noteStyleSchema,
            connectorStyle: noteStyleSchema,
            noteType: Type.Union([
                Type.Literal('default'),
                Type.Literal('trace'),
                Type.Literal('anchor'),
                Type.Literal('damage'),
                Type.Literal('forceTick'),
                Type.Literal('forceNonTick'),
            ]),
            isAttached: Type.Boolean(),
            isCritical: Type.Boolean(),
            flickDirection: Type.Union([
                Type.Literal('none'),
                Type.Literal('up'),
                Type.Literal('upLeft'),
                Type.Literal('upRight'),
                Type.Literal('down'),
                Type.Literal('downLeft'),
                Type.Literal('downRight'),
            ]),
            isFake: Type.Boolean(),
            sfx: Type.Union([
                Type.Literal('default'),
                Type.Literal('none'),
                Type.Literal('normalTap'),
                Type.Literal('criticalTap'),
                Type.Literal('normalFlick'),
                Type.Literal('criticalFlick'),
                Type.Literal('normalTrace'),
                Type.Literal('criticalTrace'),
                Type.Literal('normalTick'),
                Type.Literal('criticalTick'),
                Type.Literal('damage'),
            ]),
            isConnectorSeparator: Type.Boolean(),
            connectorType: Type.Union([
                Type.Literal('active'),
                Type.Literal('guide'),
                Type.Literal('damage'),
            ]),
            connectorEase: Type.Unsafe<EaseEdit>(
                Type.Union(easeEdits.map((value) => Type.Literal(value))),
            ),
            connectorIsFake: Type.Boolean(),
            connectorActiveIsCritical: Type.Boolean(),
            connectorGuideAlpha: Type.Number(),
            connectorLayer: Type.Union([
                Type.Literal('top'),
                Type.Literal('bottom'),
                Type.Literal('under'),
                Type.Literal('over'),
            ]),
            connectorIsPassThrough: Type.Boolean(),
            connectorPresentation: Type.Union([
                Type.Literal('default'),
                Type.Literal('fullscreen'),
            ]),
        }),
    ).properties,
    copyProperties: Type.Boolean({ default: true }),
})

export type DefaultNoteSlideProperties = Type.Static<typeof defaultNoteSlidePropertiesSchema>
