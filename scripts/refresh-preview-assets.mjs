import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshPreviewAssetLock } from './release-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = await refreshPreviewAssetLock(root)
const { version: _version, ...entries } = lock
console.log(
    `Locked preview assets: ${Object.values(entries)
        .map((entry) => entry.item.title)
        .join(', ')}`,
)
