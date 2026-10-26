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

/** A choice's identity: the source, and the stored package for a file or a server. */
export const choiceKey = (choice: AssetChoice) =>
    choice.source === 'file' || choice.source === 'server'
        ? `${choice.source}:${choice.key}`
        : choice.source === 'bundled'
          ? `bundled:${choice.id}`
          : choice.source
