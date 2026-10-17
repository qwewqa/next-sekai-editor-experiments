import Type from 'typebox'
import type { AssetChoice, AssetType } from './types'

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

/** One choice as the setting stores it; a malformed one repairs to Default. */
export const assetChoiceSchema = Type.Union(
    [
        Type.Object({ source: Type.Literal('default') }),
        Type.Object({ source: Type.Literal('builtin') }),
        storedChoice('file'),
        storedChoice('server'),
    ],
    { default: { source: 'default' } },
)

export const previewAssetsSchema = Type.Object(
    {
        skin: assetChoiceSchema,
        particle: assetChoiceSchema,
        background: assetChoiceSchema,
        effect: assetChoiceSchema,
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

/** A choice's identity: the source, and the stored package for a file or a server. */
export const choiceKey = (choice: AssetChoice) =>
    choice.source === 'file' || choice.source === 'server'
        ? `${choice.source}:${choice.key}`
        : choice.source

export const sameChoice = (a: AssetChoice, b: AssetChoice) => choiceKey(a) === choiceKey(b)
