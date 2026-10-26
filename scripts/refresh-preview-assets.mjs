import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { refreshPreviewAssetLock } from './release-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = await refreshPreviewAssetLock(root)
const entries = Object.values(lock).filter((entry) => typeof entry === 'object')
console.log(`Locked preview assets: ${entries.map((entry) => entry.item.title).join(', ')}`)
