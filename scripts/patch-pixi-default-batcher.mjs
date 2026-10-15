import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Pixi 8.22.0 consults its registered batchers for named batches but hardcodes
// DefaultBatcher when starting an instruction set. Honor the same registry for
// that initial default batch so an installed default extension is used there.
// This is an installation-time dependency patch; re-audit on every Pixi upgrade.
const args = process.argv.slice(2)
const check = args.includes('--check')
const positional = args.filter((arg) => !arg.startsWith('--'))
if (args.some((arg) => arg.startsWith('--') && arg !== '--check') || positional.length > 1) {
    throw new Error('Usage: node patch-pixi-default-batcher.mjs [packageRoot] [--check]')
}
const packageRoot = path.resolve(positional[0] ?? 'node_modules/pixi.js')
const version = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
if (version !== '8.22.0')
    throw new Error(`Pixi default batcher patch expects 8.22.0; found ${version}`)

const originals = {
    mjs: {
        hash: 'febebfef25495e5217cec6641ef16944df37d02f0f1178302fb641c70980adb7',
        constructor: 'DefaultBatcher',
    },
    js: {
        hash: '85ec1bc6b7a84ea7e85ee7a4e06382a866ad95848869244c7c032feb1d2b6557',
        constructor: 'DefaultBatcher.DefaultBatcher',
    },
}
const replacement =
    '      batchers.default || (batchers.default = _BatcherPipe.getBatcher("default", this.renderer.limits.maxBatchableTextures));'
const hash = (value) => createHash('sha256').update(value).digest('hex')
const changes = Object.entries(originals).map(([extension, expected]) => {
    const file = path.join(packageRoot, `lib/rendering/batcher/shared/BatcherPipe.${extension}`)
    const current = readFileSync(file, 'utf8')
    const originalBlock = `      batchers.default || (batchers.default = new ${expected.constructor}({\n        maxTextures: this.renderer.limits.maxBatchableTextures\n      }));`
    const original = current.replace(replacement, originalBlock)
    if (hash(original) !== expected.hash)
        throw new Error(`Pixi default batcher patch content drift: ${file}`)
    const patched = original.replace(originalBlock, replacement)
    if (patched === original)
        throw new Error(`Pixi default batcher patch replacement missing: ${file}`)
    if (current !== original && current !== patched)
        throw new Error(`Pixi default batcher patch is only partly applied: ${file}`)
    return {
        file,
        current,
        patched,
        alreadyPatched: current === patched,
        originalHash: expected.hash,
        patchedHash: hash(patched),
    }
})
if (
    changes.some((change) => change.alreadyPatched) &&
    !changes.every((change) => change.alreadyPatched)
) {
    throw new Error('Pixi default batcher patch is only partly applied across ESM/CommonJS outputs')
}
if (check && !changes.every((change) => change.alreadyPatched)) {
    throw new Error(
        'Pixi patch is not applied; run the package postinstall scripts before release verification',
    )
}

// Validate the version, every byte of both inputs, and the package-wide state
// before modifying either module format. Repeated execution is a no-op.
for (const change of changes) {
    if (!check && !change.alreadyPatched) writeFileSync(change.file, change.patched)
    console.log(
        JSON.stringify({
            file: change.file,
            originalHash: change.originalHash,
            patchedHash: change.patchedHash,
            changed: !change.alreadyPatched,
            ...(check ? { checked: true } : {}),
        }),
    )
}
