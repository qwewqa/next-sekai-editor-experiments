import { ref } from 'vue'
import { readImageSize } from '../../../preview/assets/files/image'
import { LIMITS } from '../../../preview/assets/files/limits'
import { openSourcePackage } from '../../../preview/assets/files/package'
import { workerStore, type UserAssetMeta } from '../../../preview/assets/files/store'

// The pictures of stored items for the dialog's rows, read from the stored packages when a row
// first shows and kept as object URLs until the dialog closes.

const urls = ref<Record<string, string | undefined>>({})
const started = new Set<string>()
// A read that finishes after the dialog closed is dropped.
let epoch = 0

const readThumbnail = async (meta: UserAssetMeta) => {
    const stored = await workerStore.get(meta.key)
    if (!stored) return
    const pkg = await openSourcePackage(stored.bytes)
    const [item] = await pkg.list(meta.type)
    const path = pkg.resolve(item?.thumbnail)
    if (!path) return
    const bytes = await pkg.entry(path, {
        type: meta.type,
        part: 'thumbnail',
        maxSize: 8 * 1024 * 1024,
    })
    const size = bytes && readImageSize(bytes)
    if (!bytes || !size) return
    if (size.width > LIMITS.thumbnailSide || size.height > LIMITS.thumbnailSide) return
    return URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], {
            type: size.format === 'jpeg' ? 'image/jpeg' : 'image/png',
        }),
    )
}

/** The picture of a stored item, once read; undefined until then and for an item with none. */
export const storedThumbnail = (meta: UserAssetMeta) => {
    if (!started.has(meta.key)) {
        started.add(meta.key)
        const mine = epoch
        void readThumbnail(meta)
            .then((url) => {
                if (mine === epoch) urls.value = { ...urls.value, [meta.key]: url }
                else if (url) URL.revokeObjectURL(url)
            })
            .catch(() => undefined)
    }
    return urls.value[meta.key]
}

/** Revokes every picture, when the dialog closes. */
export const clearStoredThumbnails = () => {
    epoch++
    for (const url of Object.values(urls.value)) if (url) URL.revokeObjectURL(url)
    urls.value = {}
    started.clear()
}
