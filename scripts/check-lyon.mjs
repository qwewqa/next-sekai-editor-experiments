import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(path.join(root, 'native/lyon/artifact.json'), 'utf8'))
for (const entry of [...manifest.sources, manifest.artifact]) {
    assert.equal(
        createHash('sha256')
            .update(readFileSync(path.join(root, entry.file)))
            .digest('hex'),
        entry.sha256,
        `${entry.file} differs from the checked-in Lyon build; run npm run build:lyon and review its artifact manifest`,
    )
}
const module = new WebAssembly.Module(readFileSync(path.join(root, manifest.artifact.file)))
assert.deepEqual(WebAssembly.Module.imports(module), [], 'Lyon must not import a host runtime')
const { exports } = new WebAssembly.Instance(module)
assert.equal(exports.abi_version(), manifest.abi)
assert.equal(exports.memory.buffer.byteLength, manifest.link.initialMemory)
const notices = JSON.parse(
    readFileSync(path.join(root, 'public/third-party/lyon/sources.json'), 'utf8'),
)
for (const entry of notices) {
    assert.equal(
        createHash('sha256')
            .update(readFileSync(path.join(root, 'public/third-party/lyon', entry.file)))
            .digest('hex'),
        entry.sha256,
        `Upstream notice changed: ${entry.file}`,
    )
}
const lock = readFileSync(path.join(root, 'native/lyon/Cargo.lock'), 'utf8')
for (const entry of lock.split('[[package]]').slice(1)) {
    if (!entry.includes('source = "registry+')) continue
    const name = /^name = "([^"]+)"/m.exec(entry)?.[1]
    const version = /^version = "([^"]+)"/m.exec(entry)?.[1]
    assert.ok(
        notices.some((notice) => notice.package === `${name}-${version}`),
        `Missing locked package notices: ${name}-${version}`,
    )
}
console.log('Pinned Lyon source and binary checks passed')
