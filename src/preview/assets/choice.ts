import Type from 'typebox'
import type { AssetChoice, AssetType, BundledId } from './types'

export const assetTypes = [
    'skin',
    'particle',
    'background',
    'effect',
] as const satisfies AssetType[]

const storedChoice = <S extends 'file' | 'server'>(source: S) =>
    Type.Object({
        source: Type.Literal(source),
        key: Type.String(),
        name: Type.String(),
        title: Type.String(),
        author: Type.String(),
        origin: Type.String(),
    })

/** The bundled package a type has, if any. */
const bundledChoices = { skin: 'skin2', effect: 'effect2' } as const

/** Every bundled package (Next SEKAI 02). */
export const bundledIds: readonly BundledId[] = Object.values(bundledChoices)

/** The bundled package (Next SEKAI 02) a type has, if any. */
export const bundledIdOf = (type: AssetType): BundledId | undefined =>
    (bundledChoices as Partial<Record<AssetType, BundledId>>)[type]

/** One choice as the setting stores it; a malformed one repairs to Default. */
const choiceSchema = (bundledId?: BundledId) =>
    Type.Unsafe<AssetChoice>(
        Type.Union(
            [
                Type.Object({ source: Type.Literal('default') }),
                Type.Object({ source: Type.Literal('builtin') }),
                ...(bundledId
                    ? [
                          Type.Object({
                              source: Type.Literal('bundled'),
                              id: Type.Literal(bundledId),
                          }),
                      ]
                    : []),
                storedChoice('file'),
                storedChoice('server'),
            ],
            { default: { source: 'default' } },
        ),
    )

export const assetChoiceSchema = choiceSchema()

export const previewAssetsSchema = Type.Object(
    {
        skin: choiceSchema(bundledChoices.skin),
        particle: assetChoiceSchema,
        background: assetChoiceSchema,
        effect: choiceSchema(bundledChoices.effect),
    },
    {
        default: {
            skin: { source: 'default' },
            particle: { source: 'default' },
            background: { source: 'default' },
            effect: { source: 'default' },
        },
    },
)

/** What `dismissedAssetNotices` holds at most. */
export const DISMISSED_NOTICE_LIMIT = 20

/** What `recentServers` holds at most. */
export const RECENT_SERVER_LIMIT = 5

/** The list with a server put first, once, and no more than the limit. */
export const withRecentServer = (servers: readonly string[], address: string) =>
    [address, ...servers.filter((held) => held !== address)].slice(0, RECENT_SERVER_LIMIT)

/**
 * What choosing Built-in stores. Where there is no Default (the apps, and web builds without the
 * resource packs) Built-in is the Default, and the setting stores it as Default.
 */
export const builtinChoice = (hasDefault: boolean): AssetChoice => ({
    source: hasDefault ? 'builtin' : 'default',
})

/**
 * The row of Preview Assets' sources a choice selects: the stored item's or Next SEKAI 02's
 * identity, else `default` or `builtin`, Built-in also where Default stands for it.
 */
export const choiceRow = (choice: AssetChoice, type: AssetType, hasDefault: boolean) => {
    if (choice.source === 'file' || choice.source === 'server') return choiceKey(choice)
    if (choice.source === 'bundled' && hasDefault && bundledIdOf(type) === choice.id)
        return choiceKey(choice)
    return choice.source === 'default' && hasDefault ? 'default' : 'builtin'
}

/** A choice's identity: the source, and the stored package for a file or a server. */
export const choiceKey = (choice: AssetChoice) =>
    choice.source === 'file' || choice.source === 'server'
        ? `${choice.source}:${choice.key}`
        : choice.source === 'bundled'
          ? `bundled:${choice.id}`
          : choice.source
