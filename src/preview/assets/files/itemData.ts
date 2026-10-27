import type {
    BackgroundConfiguration,
    BackgroundData,
    EffectData,
    ParticleData,
    SkinData,
} from '@sonolus/core'
import Type from 'typebox'
import Value from 'typebox/value'
import type { AssetType } from '../types'
import { AssetImportError } from './errors'
import { LIMITS } from './limits'
import { isNoteBody } from './noteBodies'
import { displayText } from './package'

// The schemas and checks for the JSON of untrusted items: extra fields are
// allowed, every number is finite (TypeBox's Number refuses NaN and Infinity), and what the
// preview reads is rebuilt from what passed, so nothing else reaches the renderer.

/** Import refuses a package for any problem; load tolerates what only costs a sprite. */
export type CheckMode = 'import' | 'load'

const unreadable = (type: AssetType) => new AssetImportError('unreadable', { type, part: 'data' })

const expression = Type.Record(Type.String(), Type.Number())

const skinSchema = Type.Object({
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    interpolation: Type.Optional(Type.Boolean()),
    sprites: Type.Array(
        Type.Object({
            name: Type.String(),
            x: Type.Number(),
            y: Type.Number(),
            w: Type.Number(),
            h: Type.Number(),
            transform: Type.Optional(Type.Record(Type.String(), expression)),
        }),
    ),
})

const property = Type.Object({
    from: Type.Optional(expression),
    to: Type.Optional(expression),
    ease: Type.Optional(Type.String()),
})

const particleSchema = Type.Object({
    width: Type.Number({ exclusiveMinimum: 0 }),
    height: Type.Number({ exclusiveMinimum: 0 }),
    interpolation: Type.Optional(Type.Boolean()),
    sprites: Type.Array(
        Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }),
    ),
    effects: Type.Array(
        Type.Object({
            name: Type.String(),
            transform: Type.Optional(Type.Record(Type.String(), expression)),
            groups: Type.Array(
                Type.Object({
                    count: Type.Integer({ minimum: 0 }),
                    particles: Type.Array(
                        Type.Object({
                            sprite: Type.Integer({ minimum: 0 }),
                            color: Type.Optional(Type.String()),
                            start: Type.Number(),
                            duration: Type.Number(),
                            x: property,
                            y: property,
                            w: property,
                            h: property,
                            r: property,
                            a: property,
                        }),
                    ),
                }),
            ),
        }),
    ),
})

const backgroundSchema = Type.Object({
    aspectRatio: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()])),
    fit: Type.Union([
        Type.Literal('width'),
        Type.Literal('height'),
        Type.Literal('contain'),
        Type.Literal('cover'),
    ]),
    color: Type.String(),
})

const configurationSchema = Type.Object({
    blur: Type.Number({ minimum: 0 }),
    mask: Type.String(),
})

const effectSchema = Type.Object({
    clips: Type.Array(Type.Object({ name: Type.String(), filename: Type.String() })),
})

const check = <S extends Type.TSchema>(schema: S, value: unknown, type: AssetType) => {
    if (!Value.Check(schema, value)) throw unreadable(type)
    return value
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

// The coordinate names of a transform and a particle expression: nothing else is read.
const transformKey = /^[xy][1-4]$/
const termKey = /^(c|[xy][1-4]|(r|sinr|cosr)[1-8])$/

const cleanExpression = (terms: Record<string, number> | undefined, keys: RegExp) =>
    Object.fromEntries(Object.entries(terms ?? {}).filter(([key]) => keys.test(key)))

const transformKeys = ['x1', 'x2', 'x3', 'x4', 'y1', 'y2', 'y3', 'y4'] as const

// Absent is the identity; a transform that is given is kept as it says, key by key.
const cleanTransform = (transform: Record<string, Record<string, number>> | undefined) =>
    Object.fromEntries(
        transformKeys.map((key) => [
            key,
            transform ? cleanExpression(transform[key], transformKey) : { [key]: 1 },
        ]),
    ) as SkinData['sprites'][number]['transform']

/** A colour as the engine writes it; undefined for anything else, so no other text reaches CSS. */
export const hexColor = (color: string | undefined) =>
    color !== undefined && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)
        ? color
        : undefined

const eases =
    /^(linear|none|(in|out|inOut|outIn)(Sine|Quad|Cubic|Quart|Quint|Expo|Circ|Back|Elastic))$/

const isInside = (
    sprite: { x: number; y: number; w: number; h: number },
    width: number,
    height: number,
) =>
    sprite.x >= 0 &&
    sprite.y >= 0 &&
    sprite.w >= 0 &&
    sprite.h >= 0 &&
    sprite.x + sprite.w <= width &&
    sprite.y + sprite.h <= height

export const checkSkinData = (raw: unknown, mode: CheckMode): SkinData => {
    if (isRecord(raw) && Array.isArray(raw.sprites) && raw.sprites.length > LIMITS.skinSprites)
        throw new AssetImportError('tooManySprites', { type: 'skin', limit: LIMITS.skinSprites })
    const data = check(skinSchema, raw, 'skin')

    const sprites: SkinData['sprites'] = []
    for (const sprite of data.sprites) {
        // An import refuses a bad sprite; a stored package loads without it, so it counts as missing.
        if (!isInside(sprite, data.width, data.height)) {
            if (mode === 'import') throw new AssetImportError('spriteOutside', { type: 'skin' })
            continue
        }
        sprites.push({
            name: sprite.name,
            x: sprite.x,
            y: sprite.y,
            w: sprite.w,
            h: sprite.h,
            transform: cleanTransform(sprite.transform),
        })
    }
    // A skin with no note body would draw blank notes, so it is refused, or falls back at load.
    if (!sprites.some((sprite) => isNoteBody(sprite.name)))
        throw new AssetImportError('noNoteSprites', { type: 'skin' })
    return {
        width: data.width,
        height: data.height,
        interpolation: data.interpolation ?? false,
        sprites,
    }
}

const cleanProperty = (value: Type.Static<typeof property>) => ({
    from: cleanExpression(value.from, termKey),
    to: cleanExpression(value.to, termKey),
    // An unknown ease is linear.
    ease: value.ease !== undefined && eases.test(value.ease) ? value.ease : 'linear',
})

/** The particles and groups of all effects, counted before the schema walks them. */
const checkParticleTotals = (effects: unknown) => {
    if (!Array.isArray(effects)) return
    let groups = 0
    let particles = 0
    for (const effect of effects as unknown[]) {
        if (!isRecord(effect) || !Array.isArray(effect.groups)) continue
        groups += effect.groups.length
        for (const group of effect.groups as unknown[])
            if (isRecord(group) && Array.isArray(group.particles))
                particles += group.particles.length
    }
    const detail = { type: 'particle' as const, limit: LIMITS.particlesInAll }
    if (groups > LIMITS.particlesInAll) throw new AssetImportError('tooManyGroups', detail)
    if (particles > LIMITS.particlesInAll) throw new AssetImportError('tooManyParticles', detail)
}

export const checkParticleData = (raw: unknown): ParticleData => {
    if (isRecord(raw)) {
        if (Array.isArray(raw.sprites) && raw.sprites.length > LIMITS.particleSprites)
            throw new AssetImportError('tooManySprites', {
                type: 'particle',
                limit: LIMITS.particleSprites,
            })
        if (Array.isArray(raw.effects) && raw.effects.length > LIMITS.particleEffects)
            throw new AssetImportError('tooManyEffects', {
                type: 'particle',
                limit: LIMITS.particleEffects,
            })
        checkParticleTotals(raw.effects)
    }
    const data = check(particleSchema, raw, 'particle')

    for (const sprite of data.sprites) {
        if (!isInside(sprite, data.width, data.height))
            throw new AssetImportError('spriteOutside', { type: 'particle' })
    }

    const effects = data.effects.map((effect) => {
        const detail = {
            type: 'particle' as const,
            name: displayText(effect.name),
            limit: LIMITS.particlesPerEffect,
        }
        if (effect.groups.length > LIMITS.particlesPerEffect)
            throw new AssetImportError('effectGroups', detail)
        // `count * particles` is what an effect can have alive at once; the draw walks every
        // occurrence of a group, so one with no particles counts as one.
        let alive = 0
        let particles = 0
        for (const group of effect.groups) {
            alive += group.count * Math.max(group.particles.length, 1)
            particles += group.particles.length
        }
        if (alive > LIMITS.particlesPerEffect || particles > LIMITS.particlesPerEffect)
            throw new AssetImportError('particleCount', detail)
        return {
            name: effect.name,
            transform: cleanTransform(effect.transform),
            groups: effect.groups.map((group) => ({
                count: group.count,
                particles: group.particles.map((particle) => {
                    if (particle.sprite >= data.sprites.length) throw unreadable('particle')
                    return {
                        sprite: particle.sprite,
                        // A colour that is not hex is white.
                        color: hexColor(particle.color) ?? '#ffffff',
                        start: particle.start,
                        duration: particle.duration,
                        x: cleanProperty(particle.x),
                        y: cleanProperty(particle.y),
                        w: cleanProperty(particle.w),
                        h: cleanProperty(particle.h),
                        r: cleanProperty(particle.r),
                        a: cleanProperty(particle.a),
                    }
                }),
            })),
        }
    }) as ParticleData['effects']
    return {
        width: data.width,
        height: data.height,
        interpolation: data.interpolation ?? false,
        sprites: data.sprites,
        effects,
    }
}

export const checkBackgroundData = (raw: unknown): BackgroundData => {
    const data = check(backgroundSchema, raw, 'background')
    return {
        ...(data.aspectRatio ? { aspectRatio: data.aspectRatio } : {}),
        fit: data.fit,
        color: hexColor(data.color) ?? 'transparent',
    }
}

/** The blur is capped so a hostile value cannot make the filter cost a frame. */
const MAX_BLUR = 100

export const checkBackgroundConfiguration = (raw: unknown): BackgroundConfiguration => {
    const data = check(configurationSchema, raw, 'background')
    return {
        blur: Math.min(data.blur, MAX_BLUR),
        mask: hexColor(data.mask) ?? '#00000000',
    }
}

export const checkEffectData = (raw: unknown): EffectData => check(effectSchema, raw, 'effect')
