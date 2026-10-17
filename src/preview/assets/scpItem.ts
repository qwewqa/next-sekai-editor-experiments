import type { ServerItemDetails, ServerItemList } from '@sonolus/core'
import { parseScp, type ScpArchive } from '../scp'

/** An SRL as the server sends it; a null or missing url means the resource is absent. */
export type ResourceLocator = { url?: string | null } | undefined

export type ResourceGetter = (srl: ResourceLocator) => Uint8Array | undefined

type ItemCategory = 'skins' | 'particles' | 'backgrounds' | 'effects'

/**
 * Reads one item of a package, the first unless a name is given, and a getter for
 * its resources by SRL URL. A URL is a path in the package once its leading slash is stripped.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export const readItem = <T extends { name: string }>(
    scp: ScpArchive | ArrayBuffer,
    category: ItemCategory,
    name?: string,
): { item: T; getResource: ResourceGetter } | undefined => {
    const archive = 'get' in scp ? scp : parseScp(scp)

    const list = archive.getJson<ServerItemList<T>>(`sonolus/${category}/list`)
    const listed = name === undefined ? list?.items[0] : list?.items.find((i) => i.name === name)
    if (!listed) return

    const details = archive.getJson<ServerItemDetails<T>>(`sonolus/${category}/${listed.name}`)
    return {
        item: details?.item ?? listed,
        getResource: (srl) => (srl?.url ? archive.get(srl.url) : undefined),
    }
}
