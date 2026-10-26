import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stageDevPreviewAssets } from './preview-assets.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { skipped, failures } = await stageDevPreviewAssets(root)
if (skipped) console.log('NSE_SKIP_PREVIEW_ASSETS is set: the preview uses Built-in only.')
else if (failures.length)
    console.warn(
        `Preview assets not staged (${failures.join('; ')}). The preview uses Built-in only.`,
    )
