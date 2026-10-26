import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageDevPreviewAssets } from './preview-assets.mjs'

// The dev server (vite.config.ts) reports a missing package or the skip variable, so this stays
// quiet about those. A failure of another kind, such as a hash mismatch, is reported here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { unexpected } = await stageDevPreviewAssets(root)
if (unexpected.length) console.warn(`Preview assets not staged: ${unexpected.join('; ')}.`)
