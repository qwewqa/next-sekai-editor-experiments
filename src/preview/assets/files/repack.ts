import { buildZip, type ZipInput } from '../../../zip'
import type { AssetType } from '../types'
import { sha1Hex, type CheckedItem, type ResourceField } from './item'
import { categoryOf } from './package'

const VERSIONS: Record<AssetType, number> = { skin: 4, particle: 3, background: 2, effect: 5 }

const encoder = new TextEncoder()
const json = (value: unknown) => encoder.encode(JSON.stringify(value))

const REPOSITORY = 'sonolus/repository/'

/** What a repacked item is made of besides its resources. */
type RepackFields = Pick<CheckedItem, 'type' | 'name' | 'version' | 'title' | 'subtitle' | 'author'>

/**
 * The item object of a repacked package, from its fields and the SHA-1 of each resource, the
 * thumbnail first, then the type's resources in order. The repack and the check of whether a
 * package's item is stored both build it here, so the two cannot drift.
 */
export const repackedItem = (fields: RepackFields, hashes: ReadonlyMap<ResourceField, string>) => {
    const srl = (hash: string) => ({ hash, url: `/${REPOSITORY}${hash}` })
    const thumbnail = hashes.get('thumbnail')
    return {
        name: fields.name,
        version: fields.version ?? VERSIONS[fields.type],
        title: fields.title,
        subtitle: fields.subtitle,
        author: fields.author,
        tags: [],
        ...(thumbnail === undefined ? {} : { thumbnail: srl(thumbnail) }),
        ...Object.fromEntries(
            [...hashes]
                .filter(([field]) => field !== 'thumbnail')
                .map(([f, hash]) => [f, srl(hash)]),
        ),
    }
}

/**
 * A standard single-item package: the list, the item's details and its resources
 * under `sonolus/repository/{sha1}`, every field rebuilt from what passed the checks. The same
 * item always makes the same bytes, so its sha256 names it.
 */
export const repackItem = async (checked: CheckedItem): Promise<Blob> => {
    const { type, name } = checked
    const category = categoryOf[type]

    const repository = new Map<string, Uint8Array>()
    const hashes = new Map<ResourceField, string>()
    for (const [field, bytes] of checked.resources) {
        const hash = await sha1Hex(bytes)
        repository.set(hash, bytes)
        hashes.set(field, hash)
    }

    const item = repackedItem(checked, hashes)

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
