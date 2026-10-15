import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { before, describe, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const projectRoot = fileURLToPath(new URL('../../', import.meta.url))
const packageRoot = path.join(projectRoot, 'node_modules', 'pixi.js')
const require = createRequire(path.join(projectRoot, 'package.json'))
const hash = (value) => createHash('sha256').update(value).digest('hex')
const extensions = ['mjs', 'js']
const batcherReplacement =
    '      batchers.default || (batchers.default = _BatcherPipe.getBatcher("default", this.renderer.limits.maxBatchableTextures));'
const patches = [
    {
        name: 'default batcher registry',
        script: 'patch-pixi-default-batcher.mjs',
        directory: 'lib/rendering/batcher/shared',
        basename: 'BatcherPipe',
        originals: {
            mjs: 'febebfef25495e5217cec6641ef16944df37d02f0f1178302fb641c70980adb7',
            js: '85ec1bc6b7a84ea7e85ee7a4e06382a866ad95848869244c7c032feb1d2b6557',
        },
        replacements: (extension) => {
            const constructor =
                extension === 'mjs' ? 'DefaultBatcher' : 'DefaultBatcher.DefaultBatcher'
            return [
                [
                    `      batchers.default || (batchers.default = new ${constructor}({\n        maxTextures: this.renderer.limits.maxBatchableTextures\n      }));`,
                    batcherReplacement,
                ],
            ]
        },
        partial: (original) =>
            original.replace(
                /new DefaultBatcher(?:\.DefaultBatcher)?\(\{/,
                '_BatcherPipe.getBatcher({',
            ),
    },
]
const inputs = new Map()
let packageJson

const relativeFile = (patch, extension) => `${patch.directory}/${patch.basename}.${extension}`
const installedText = (relative) => readFileSync(path.join(packageRoot, relative), 'utf8')

before(() => {
    packageJson = installedText('package.json')
    assert.equal(
        JSON.parse(packageJson).version,
        '8.22.0',
        'Re-audit these guards before changing the pinned Pixi version',
    )
    for (const patch of patches)
        for (const extension of extensions) {
            const relative = relativeFile(patch, extension)
            const current = installedText(relative)
            const replacements = patch.replacements(extension)
            // Derive fixtures from this installation, then prove they are the exact
            // published inputs. No pristine dependency checkout is needed.
            const original = replacements.reduce(
                (text, [from, to]) => text.replace(to, from),
                current,
            )
            assert.equal(
                hash(original),
                patch.originals[extension],
                `Unexpected Pixi source: ${relative}`,
            )
            const patched = replacements.reduce(
                (text, [from, to]) => text.replace(from, to),
                original,
            )
            assert.notEqual(patched, original, `Patch anchor missing: ${relative}`)
            inputs.set(relative, { original, patched })
        }
})

const fixture = (t) => {
    const parent = path.resolve(tmpdir())
    const root = mkdtempSync(path.join(parent, 'pixi-patches-'))
    t.after(() => {
        const resolved = path.resolve(root)
        assert.equal(
            path.dirname(resolved),
            parent,
            'Temporary fixture must remain inside its original parent',
        )
        assert.ok(
            path.basename(resolved).startsWith('pixi-patches-'),
            'Unexpected temporary fixture name',
        )
        rmSync(resolved, { recursive: true, force: true })
    })
    writeFileSync(path.join(root, 'package.json'), packageJson)
    for (const [relative, input] of inputs) {
        const file = path.join(root, relative)
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, input.original)
    }
    return root
}

const snapshot = (root) =>
    Object.fromEntries(
        ['package.json', ...inputs.keys()].map((relative) => [
            relative,
            hash(readFileSync(path.join(root, relative))),
        ]),
    )
const run = (patch, root, extraArgs = []) => {
    const result = spawnSync(
        process.execPath,
        [
            path.join(projectRoot, 'scripts', patch.script),
            ...(root === undefined ? [] : [root]),
            ...extraArgs,
        ],
        {
            cwd: projectRoot,
            encoding: 'utf8',
            timeout: 15_000,
        },
    )
    assert.equal(result.error, undefined, result.error?.message)
    return result
}
const apply = (patch, root, changed) => {
    const result = run(patch, root)
    assert.equal(result.status, 0, result.stderr)
    const records = result.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line))
    assert.equal(records.length, 2)
    for (const [index, extension] of extensions.entries()) {
        const relative = relativeFile(patch, extension)
        const { original, patched } = inputs.get(relative)
        assert.equal(records[index].changed, changed)
        assert.equal(records[index].originalHash, hash(original))
        assert.equal(records[index].patchedHash, hash(patched))
        assert.equal(readFileSync(path.join(root, relative), 'utf8'), patched)
    }
}
const rejectWithoutMutation = (patch, root, message) => {
    const before = snapshot(root)
    const result = run(patch, root)
    assert.notEqual(result.status, 0, 'The guard unexpectedly accepted an invalid fixture')
    assert.match(result.stderr, message)
    assert.deepEqual(
        snapshot(root),
        before,
        'Rejection must not modify either module or package metadata',
    )
}

test('installed ESM and CommonJS files contain the guarded default-batcher patch', () => {
    for (const [relative, input] of inputs)
        assert.equal(
            installedText(relative),
            input.patched,
            `Run the package postinstall scripts: ${relative}`,
        )
})

for (const patch of patches)
    describe(patch.name, () => {
        test('patches exact original inputs in both module formats', (t) => {
            const root = fixture(t)
            apply(patch, root, true)
            for (const other of patches.filter((other) => other !== patch))
                for (const extension of extensions) {
                    const relative = relativeFile(other, extension)
                    assert.equal(
                        readFileSync(path.join(root, relative), 'utf8'),
                        inputs.get(relative).original,
                    )
                }
        })

        test('a repeated application is byte-for-byte idempotent', (t) => {
            const root = fixture(t)
            apply(patch, root, true)
            const before = snapshot(root)
            apply(patch, root, false)
            assert.deepEqual(snapshot(root), before)
        })

        test('read-only verification rejects pristine inputs without applying the patch', (t) => {
            const root = fixture(t)
            const before = snapshot(root)
            const result = run(patch, root, ['--check'])
            assert.notEqual(result.status, 0)
            assert.match(result.stderr, /patch is not applied/)
            assert.deepEqual(snapshot(root), before)
        })

        test('read-only verification validates patched explicit and default package roots without mutation', (t) => {
            const root = fixture(t)
            apply(patch, root, true)
            for (const target of [root, undefined]) {
                const resolved = target ?? packageRoot
                const before = snapshot(resolved)
                const result = run(patch, target, ['--check'])
                assert.equal(result.status, 0, result.stderr)
                const records = result.stdout
                    .trim()
                    .split(/\r?\n/)
                    .map((line) => JSON.parse(line))
                assert.equal(records.length, 2)
                assert.ok(records.every((record) => record.checked && !record.changed))
                assert.deepEqual(snapshot(resolved), before)
            }
        })

        test('rejects version drift before writing any output', (t) => {
            const root = fixture(t)
            writeFileSync(
                path.join(root, 'package.json'),
                JSON.stringify({ ...JSON.parse(packageJson), version: '8.22.1' }),
            )
            rejectWithoutMutation(patch, root, /expects 8\.22\.0/)
        })

        for (const extension of extensions) {
            test(`rejects ${extension} content drift without changing the other module`, (t) => {
                const root = fixture(t)
                const relative = relativeFile(patch, extension)
                writeFileSync(
                    path.join(root, relative),
                    `${inputs.get(relative).original}\n// unexpected dependency edit\n`,
                )
                rejectWithoutMutation(patch, root, /content drift/)
            })

            test(`rejects a partial ${extension} edit without mutation`, (t) => {
                const root = fixture(t)
                const relative = relativeFile(patch, extension)
                const { original, patched } = inputs.get(relative)
                const partial = patch.partial(original)
                assert.notEqual(partial, original)
                assert.notEqual(partial, patched)
                writeFileSync(path.join(root, relative), partial)
                rejectWithoutMutation(patch, root, /content drift|only partly applied/)
            })

            test(`rejects a mixed package with only ${extension} patched`, (t) => {
                const root = fixture(t)
                const relative = relativeFile(patch, extension)
                writeFileSync(path.join(root, relative), inputs.get(relative).patched)
                rejectWithoutMutation(patch, root, /only partly applied/)
            })
        }
    })

test('the installation patch remains byte-for-byte idempotent', (t) => {
    const root = fixture(t)
    for (const patch of patches) apply(patch, root, true)
    const before = snapshot(root)
    for (const patch of patches) apply(patch, root, false)
    assert.deepEqual(snapshot(root), before)
})

const load = (relative, extension) =>
    extension === 'mjs'
        ? import(pathToFileURL(path.join(packageRoot, `${relative}.mjs`)).href)
        : Promise.resolve(require(path.join(packageRoot, `${relative}.js`)))

for (const extension of extensions) {
    test(`${extension} default registry dispatch preserves reuse and disposal`, async () => {
        const { BatcherPipe } = await load('lib/rendering/batcher/shared/BatcherPipe', extension)
        const { extensions: registry, ExtensionType } = await load(
            'lib/extensions/Extensions',
            extension,
        )
        const { DefaultBatcher } = await load(
            'lib/rendering/batcher/shared/DefaultBatcher',
            extension,
        )
        assert.equal(BatcherPipe._availableBatchers.default, DefaultBatcher)
        class RegisteredDefault {
            static extension = { type: ExtensionType.Batcher, name: 'default' }
            constructor(options) {
                this.options = options
                this.beginCount = 0
                this.destroyCount = 0
            }
            begin() {
                this.beginCount++
            }
            destroy() {
                this.destroyCount++
            }
        }
        let pipe
        registry.add(RegisteredDefault)
        try {
            pipe = new BatcherPipe({ limits: { maxBatchableTextures: 7 } }, {})
            pipe.buildStart({ uid: 41 })
            const first = pipe._activeBatch
            assert.ok(first instanceof RegisteredDefault)
            assert.equal(first.options.maxTextures, 7)
            assert.equal(first.beginCount, 1)
            pipe.buildStart({ uid: 41 })
            assert.equal(pipe._activeBatch, first)
            assert.equal(first.beginCount, 2)
            pipe.buildStart({ uid: 42 })
            const second = pipe._activeBatch
            assert.ok(second instanceof RegisteredDefault)
            assert.notEqual(second, first)
            pipe.destroyInstructionSet({ uid: 42 })
            assert.equal(second.destroyCount, 1)
            assert.equal(pipe._activeBatch, null)
            pipe.buildStart({ uid: 41 })
            assert.equal(pipe._activeBatch, first)
            assert.equal(first.beginCount, 3)
            pipe.destroyInstructionSet({ uid: 41 })
            pipe.destroyInstructionSet({ uid: 41 })
            assert.equal(first.destroyCount, 1)
        } finally {
            pipe?.destroyInstructionSet({ uid: 41 })
            pipe?.destroyInstructionSet({ uid: 42 })
            pipe?.destroy()
            registry.remove(RegisteredDefault)
            registry.add(DefaultBatcher)
        }
    })
}
