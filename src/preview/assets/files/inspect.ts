import { assetTypes } from '../choice'
import type { AssetType } from '../types'
import { openSourcePackage } from './package'

/** The first type, in the dialog's tab order, that a package holds an item of. */
export const firstTypeIn = async (file: Blob): Promise<AssetType | undefined> => {
    try {
        const pkg = await openSourcePackage(file)
        for (const type of assetTypes) {
            try {
                if ((await pkg.list(type)).length) return type
            } catch {
                // This type's list is unreadable; the others may not be.
            }
        }
    } catch {
        // A package that cannot be opened is reported by the chooser it opens in.
    }
    return
}
