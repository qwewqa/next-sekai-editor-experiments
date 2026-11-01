import Type from 'typebox'

export const exportVideoChoices = Type.Object({
    resolution: Type.Union(
        [Type.Literal(720), Type.Literal(1080), Type.Literal(1440), Type.Literal(2160)],
        { default: 1080 },
    ),
    frameRate: Type.Union([Type.Literal(30), Type.Literal(60)], { default: 30 }),
    quality: Type.Union([Type.Literal('low'), Type.Literal('standard'), Type.Literal('high')], {
        default: 'standard',
    }),
    format: Type.Union([Type.Literal('automatic'), Type.Literal('mp4'), Type.Literal('webm')], {
        default: 'automatic',
    }),
    antialias: Type.Boolean({ default: true }),
    renderScale: Type.Union([Type.Literal(1), Type.Literal(1.5), Type.Literal(2)], { default: 1 }),
    audioBitrate: Type.Union(
        [Type.Literal(128_000), Type.Literal(192_000), Type.Literal(256_000)],
        { default: 192_000 },
    ),
})

export type ExportVideoChoices = Type.Static<typeof exportVideoChoices>

export const exportVideoStop = Type.Pick(exportVideoChoices, ['resolution', 'renderScale'])
