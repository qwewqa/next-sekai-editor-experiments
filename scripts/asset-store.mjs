// The asset store's three operations (infra/assets/README.md):
//   node scripts/asset-store.mjs prepare --bucket <bucket> --commit <sha> [--dist dist]
//   node scripts/asset-store.mjs record --bucket <bucket> --commit <sha> [--dist dist]
//   node scripts/asset-store.mjs seed --bucket <bucket> --origin <site origin> [--site test] [--replace]

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepare, record, seed } from './release/assetStore.mjs'
import { awsStore } from './release/awsStore.mjs'
import { storeSites } from './site.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
        bucket: { type: 'string' },
        commit: { type: 'string' },
        dist: { type: 'string', default: join(root, 'dist') },
        origin: { type: 'string' },
        site: { type: 'string', default: 'test' },
        replace: { type: 'boolean', default: false },
    },
})
const [operation] = positionals
const fail = (message) => {
    console.error(message)
    process.exit(2)
}
if (!['prepare', 'record', 'seed'].includes(operation) || positionals.length !== 1)
    fail('Usage: node scripts/asset-store.mjs prepare|record|seed --bucket <bucket> ...')
if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(values.bucket ?? '')) fail('--bucket is required')

const site =
    operation === 'seed'
        ? values.site
        : JSON.parse(await readFile(join(values.dist, 'release-manifest.json'), 'utf8')).site
if (!Object.hasOwn(storeSites, site)) fail(`Unknown site: ${site}`)
const { prefix, days } = storeSites[site]
const store = awsStore({ bucket: values.bucket, prefix })
const now = new Date()
const log = (line) => console.log(line)

try {
    if (operation === 'seed') {
        if (!/^https:\/\/[a-z0-9.-]+$/.test(values.origin ?? '')) fail('--origin is required')
        await seed({ store, fetch, origin: values.origin, site, now, replace: values.replace, log })
    } else {
        if (!/^[a-f0-9]{40}$/.test(values.commit ?? '')) fail('--commit is required')
        if (operation === 'prepare')
            await prepare({ dist: values.dist, store, now, commit: values.commit, days, log })
        else await record({ store, now, commit: values.commit, days, log })
    }
} catch (error) {
    console.error(`Asset store ${operation} failed: ${error.message}`)
    process.exitCode = 1
}
