import { buildZip, type ZipInput } from '../../../zip'
import type { AssetType } from '../types'
import { sha1Hex, type CheckedItem, type ResourceField } from './item'
import { categoryOf } from './package'

const VERSIONS: Record<AssetType, number> = { skin: 4, particle: 3, background: 2, effect: 5 }

const encoder = new TextEncoder()
const json = (value: unknown) => encoder.encode(JSON.stringify(value))

const REPOSITORY = 'sonolus/repository/'

/**
 * A standard single-item package (Part 2, 2.5.2): the list, the item's details and its resources
 * under `sonolus/repository/{sha1}`, every field rebuilt from what passed the checks. The same
 * item always makes the same bytes, so its sha256 names it.
 */
export const repackItem = async (checked: CheckedItem): Promise<Blob> => {
    const { type, name } = checked
    const category = categoryOf[type]

    const repository = new Map<string, Uint8Array>()
    const srls = new Map<ResourceField, { hash: string; url: string }>()
    for (const [field, bytes] of checked.resources) {
        const hash = await sha1Hex(bytes)
        repository.set(hash, bytes)
        srls.set(field, { hash, url: `/${REPOSITORY}${hash}` })
    }

    const item = {
        name,
        version: checked.version ?? VERSIONS[type],
        title: checked.title,
        subtitle: checked.subtitle,
        author: checked.author,
        tags: [],
        ...(srls.has('thumbnail') ? { thumbnail: srls.get('thumbnail') } : {}),
        ...Object.fromEntries([...srls].filter(([field]) => field !== 'thumbnail')),
    }

    const inputs: ZipInput[] = [
        {
            name: `sonolus/${category}/list`,
            method: 'deflate',
            data: json({ pageCount: 1, items: [item] }),
        },
        {
            name: `sonolus/${category}/${name}`,
            method: 'deflate',
            data: json({
                item,
                description: '',
                actions: [],
                hasCommunity: false,
                leaderboards: [],
                sections: [],
            }),
        },
        // Resources are PNG, JPEG, gzip or audio already, so they are stored as they are.
        ...[...repository]
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([hash, bytes]): ZipInput => ({
                name: `${REPOSITORY}${hash}`,
                method: 'store',
                data: new Uint8Array(bytes),
            })),
    ]
    return buildZip(inputs)
}
