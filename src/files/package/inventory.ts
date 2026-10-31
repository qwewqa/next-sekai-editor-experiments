import { assetTypes } from '../../preview/assets/choice'
import { AssetImportError } from '../../preview/assets/files/errors'
import { LIMITS } from '../../preview/assets/files/limits'
import {
    displayText,
    isSrl,
    openSourcePackage,
    type FilePackage,
    type ItemType,
    type NamedItem,
    type Srl,
} from '../../preview/assets/files/package'
import type { AssetType } from '../../preview/assets/types'

// What a Sonolus package offers Open: its levels, and its skins, particles, backgrounds and
// sound effects. Only the item lists are read (or the detail entries where a list is missing);
// `sonolus/info` and the info sections often disagree with them, and the lists win.

export type PackageLevel = {
    name: string
    title: string
    artists: string
    author: string
    /** The list's item, used for the check, the direct open and Open itself. */
    item: NamedItem
    /** The data entry's path, when the data is in this file. */
    data: string | undefined
    cover: Srl
}

export type PackageAsset = {
    type: AssetType
    name: string
    title: string
    author: string
    thumbnail: Srl
}

export type Inventory = {
    pkg: FilePackage
    levels: PackageLevel[]
    assets: PackageAsset[]
}

/** The first item of each name: lookups are by name. */
const firstOfEach = (items: NamedItem[]) => {
    const byName = new Map<string, NamedItem>()
    for (const item of items) if (!byName.has(item.name)) byName.set(item.name, item)
    return [...byName.values()]
}

/** The path of a level's data, when its SRL names an entry this file has. */
export const levelDataPath = (pkg: FilePackage, item: Record<string, unknown>) => {
    const srl = isSrl(item.data) ? item.data : undefined
    const path = pkg.resolve(srl)
    return path !== undefined && pkg.has(path) ? path : undefined
}

// A list that cannot be read is damage to the package, whatever its type.
const listed = async (pkg: FilePackage, type: ItemType, signal?: AbortSignal) => {
    try {
        return firstOfEach(await pkg.items(type, signal))
    } catch (error) {
        if (error instanceof AssetImportError) throw new AssetImportError('damaged')
        throw error
    }
}

/** Reads what a package lists. Refuses one the package reader refuses, with its error. */
export const readInventory = async (file: Blob, signal?: AbortSignal): Promise<Inventory> => {
    const pkg = await openSourcePackage(file, { fileLimit: LIMITS.openFile })
    const levels = (await listed(pkg, 'level', signal)).map((item): PackageLevel => ({
        name: item.name,
        title: displayText(item.title) || item.name,
        artists: displayText(item.artists),
        author: displayText(item.author),
        item,
        data: levelDataPath(pkg, item),
        cover: isSrl(item.cover) ? item.cover : undefined,
    }))
    const assets: PackageAsset[] = []
    for (const type of assetTypes)
        for (const item of await listed(pkg, type, signal))
            assets.push({
                type,
                name: item.name,
                title: displayText(item.title) || item.name,
                author: displayText(item.author),
                thumbnail: isSrl(item.thumbnail) ? item.thumbnail : undefined,
            })
    return { pkg, levels, assets }
}

/** The level that opens without the list: the only item, with its data in the file. */
export const directLevel = ({ levels, assets }: Inventory) => {
    const [level] = levels
    return levels.length === 1 && assets.length === 0 && level?.data !== undefined
        ? level
        : undefined
}

export const isEmptyInventory = ({ levels, assets }: Inventory) =>
    levels.length === 0 && assets.length === 0
