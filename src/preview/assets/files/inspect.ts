import { assetTypes } from '../choice'
import type { AssetType } from '../types'
import { openSourcePackage, type SourcePackage } from './package'

/**
 * The first type, in the dialog's tab order, that a package holds an item of, and the package
 * opened, so the chooser need not read it again.
 */
export const firstTypeIn = async (
    file: Blob,
): Promise<{ type: AssetType | undefined; source?: SourcePackage }> => {
    let pkg: SourcePackage
    try {
        pkg = await openSourcePackage(file)
    } catch {
        // A package that cannot be opened is reported by the chooser it opens in.
        return { type: undefined }
    }
    for (const type of assetTypes) {
        try {
            if ((await pkg.list(type)).length) return { type, source: pkg }
        } catch {
            // This type's list is unreadable; the others may not be.
        }
    }
    return { type: undefined, source: pkg }
}
